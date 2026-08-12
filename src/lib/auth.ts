/**
 * Sessions, email+password credentials, and magic links (spec A §3).
 *
 * Sign-in is email + password (PBKDF2-HMAC-SHA256 via WebCrypto — the Workers
 * runtime has no bcrypt). Magic tokens stay for emailed action links only:
 * `invite`, `confirm_participation`, `draft_link` and `password_reset` (which
 * covers both "forgot password" and "set your first password" on accounts that
 * predate passwords, since the emailed link proves mailbox ownership).
 */
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { all, now, one, run } from './db';
import { newId } from './ids';
import { sendEmail } from './email';
import type { AuthSession, Bindings, Ctx, Event, Role, User } from '../types';

export const SESSION_COOKIE = 'us_sess';
const SESSION_DAYS = 30;
const MAGIC_MINUTES = 30;

export type MagicPurpose = 'invite' | 'confirm_participation' | 'draft_link' | 'password_reset';

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashToken(t: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function plusMinutes(min: number): string {
  return new Date(Date.now() + min * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function plusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/* ------------------------------------------------------------------ passwords */

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BYTES = 32;

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    bytes * 8
  );
  return new Uint8Array(bits);
}

/** XOR-accumulate so a wrong password never leaks how much of the hash matched. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * PBKDF2-HMAC-SHA256 (WebCrypto — the Workers runtime has no node bcrypt).
 * Stored as `pbkdf2$<iterations>$<b64 salt>$<b64 hash>` so the cost factor is
 * upgradable: `verifyPassword` derives with whatever the row recorded.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_BYTES);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** False for NULL (account predates passwords) or malformed stored values. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!password || !stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  try {
    const salt = fromBase64(parts[2]);
    const expected = fromBase64(parts[3]);
    if (!salt.length || !expected.length) return false;
    const actual = await pbkdf2(password, salt, iterations, expected.length);
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ magic links */

export type MagicLinkResult = {
  /** Present only while email sending is simulated — the UI surfaces it (DECISIONS D6). */
  simulatedLink?: string;
  url: string;
  emailId: string;
  status: 'sent' | 'failed' | 'simulated';
};

/**
 * Create a magic token row and return the RAW token (only ever returned here —
 * the DB stores the hash). Used directly when the link must live inside
 * another email (e.g. `{{confirmation_link}}` in accept emails → /confirm/<raw>)
 * or needs a non-default TTL.
 */
export async function createMagicToken(
  env: Bindings,
  email: string,
  purpose: MagicPurpose,
  payload?: Record<string, unknown>,
  ttlMinutes: number = MAGIC_MINUTES
): Promise<{ raw: string; id: string }> {
  const raw = randomToken();
  const id = newId('mtk');
  await run(
    env.DB,
    `INSERT INTO magic_tokens (id, email, token_hash, purpose, payload_json, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    id,
    email.trim(),
    await hashToken(raw),
    purpose,
    payload ? JSON.stringify(payload) : null,
    now(),
    plusMinutes(ttlMinutes)
  );
  return { raw, id };
}

/** 7 days — confirmation links live inside decision emails and must outlast an inbox backlog. */
export const CONFIRM_TOKEN_MINUTES = 7 * 24 * 60;

export async function requestMagicLink(
  env: Bindings,
  email: string,
  purpose: MagicPurpose,
  payload?: Record<string, unknown>,
  opts?: { subject?: string; text?: string; eventId?: string | null }
): Promise<MagicLinkResult> {
  const { raw, id } = await createMagicToken(env, email, purpose, payload);

  const url = `${env.APP_ORIGIN}/auth/verify?token=${encodeURIComponent(raw)}`;
  const subject = opts?.subject ?? 'Your Unsession sign-in link';
  const text =
    opts?.text ??
    `Here is your sign-in link for Unsession. It works once and expires in ${MAGIC_MINUTES} minutes.\n\n${url}\n\nIf you didn't ask for this, you can ignore this email.\n\n— Unsession`;

  const res = await sendEmail(env, {
    eventId: opts?.eventId ?? null,
    to: email.trim(),
    templateKey: `magic_${purpose}`,
    subject,
    text: text.includes(url) ? text : `${text}\n\n${url}`,
    subjectType: 'magic_token',
    subjectId: id,
  });

  return {
    url,
    emailId: res.id,
    status: res.status,
    simulatedLink: res.status === 'simulated' ? url : undefined,
  };
}

/**
 * "Forgot password" and "set your first password" are the same flow: the
 * emailed link is the proof of mailbox ownership that lets someone claim a
 * password on an account (accounts created before passwords existed have
 * `password_hash IS NULL` and can only be claimed this way).
 */
export async function requestPasswordReset(
  env: Bindings,
  email: string,
  opts?: { subject?: string; text?: string; eventId?: string | null; next?: string }
): Promise<MagicLinkResult> {
  const { raw, id } = await createMagicToken(
    env,
    email,
    'password_reset',
    opts?.next ? { next: opts.next } : undefined
  );

  const url = `${env.APP_ORIGIN}/auth/reset?token=${encodeURIComponent(raw)}`;
  const subject = opts?.subject ?? 'Set your Unsession password';
  const text =
    opts?.text ??
    `Use this link to set or reset your Unsession password. It works once and expires in ${MAGIC_MINUTES} minutes.\n\n${url}\n\nIf you didn't ask for this, you can ignore this email — your password stays as it is.\n\n— Unsession`;

  const res = await sendEmail(env, {
    eventId: opts?.eventId ?? null,
    to: email.trim(),
    templateKey: 'magic_password_reset',
    subject,
    text: text.includes(url) ? text : `${text}\n\n${url}`,
    subjectType: 'magic_token',
    subjectId: id,
  });

  return {
    url,
    emailId: res.id,
    status: res.status,
    simulatedLink: res.status === 'simulated' ? url : undefined,
  };
}

export type VerifiedToken = {
  id: string;
  email: string;
  purpose: MagicPurpose;
  payload: Record<string, unknown> | null;
};

/** Single-use consumption: marks `used_at` and returns the row, or null when invalid/expired. */
export async function verifyMagicToken(env: Bindings, raw: string): Promise<VerifiedToken | null> {
  if (!raw) return null;
  const hash = await hashToken(raw);
  const row = await one<{
    id: string;
    email: string;
    purpose: string;
    payload_json: string | null;
    expires_at: string;
    used_at: string | null;
  }>(env.DB, `SELECT * FROM magic_tokens WHERE token_hash = ?`, hash);
  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  await run(env.DB, `UPDATE magic_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`, now(), row.id);
  return {
    id: row.id,
    email: row.email,
    purpose: row.purpose as MagicPurpose,
    payload: row.payload_json ? (JSON.parse(row.payload_json) as Record<string, unknown>) : null,
  };
}

/* ------------------------------------------------------------------ users & sessions */

export async function findOrCreateUserByEmail(
  db: D1Database,
  email: string,
  name?: string | null
): Promise<User> {
  const existing = await one<User>(db, `SELECT * FROM users WHERE email = ?`, email.trim());
  if (existing) {
    if (name && !existing.name) {
      await run(db, `UPDATE users SET name = ? WHERE id = ?`, name, existing.id);
      existing.name = name;
    }
    return existing;
  }
  const user: User = {
    id: newId('usr'),
    email: email.trim(),
    name: name ?? null,
    password_hash: null,
    created_at: now(),
  };
  await run(
    db,
    `INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
    user.id,
    user.email,
    user.name,
    null,
    user.created_at
  );
  return user;
}

export async function createSession(
  c: Context<Ctx>,
  userId: string,
  activeEventId?: string | null
): Promise<string> {
  const raw = randomToken();
  const id = newId('ses');
  await run(
    c.env.DB,
    `INSERT INTO auth_sessions (id, user_id, token_hash, active_event_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    await hashToken(raw),
    activeEventId ?? null,
    now(),
    plusDays(SESSION_DAYS)
  );
  setSessionCookie(c, raw);
  return id;
}

export function setSessionCookie(c: Context<Ctx>, raw: string): void {
  setCookie(c, SESSION_COOKIE, raw, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function destroySession(c: Context<Ctx>): Promise<void> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (raw) {
    await run(c.env.DB, `DELETE FROM auth_sessions WHERE token_hash = ?`, await hashToken(raw));
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

/** Attaches c.var.user / c.var.session / c.var.event / c.var.events / c.var.role. */
export const getSession: MiddlewareHandler<Ctx> = async (c, next) => {
  c.set('user', null);
  c.set('session', null);
  c.set('event', null);
  c.set('events', []);
  c.set('role', null);

  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return next();

  const session = await one<AuthSession>(
    c.env.DB,
    `SELECT * FROM auth_sessions WHERE token_hash = ?`,
    await hashToken(raw)
  );
  if (!session) return next();
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await run(c.env.DB, `DELETE FROM auth_sessions WHERE id = ?`, session.id);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return next();
  }

  const user = await one<User>(c.env.DB, `SELECT * FROM users WHERE id = ?`, session.user_id);
  if (!user) return next();

  c.set('session', session);
  c.set('user', user);

  const events = await all<Event>(
    c.env.DB,
    `SELECT e.* FROM events e
       JOIN org_members m ON m.org_id = e.org_id
      WHERE m.user_id = ?
      ORDER BY e.created_at DESC`,
    user.id
  );
  c.set('events', events);

  let active = events.find((e) => e.id === session.active_event_id) ?? events[0] ?? null;
  if (active && active.id !== session.active_event_id) {
    await run(c.env.DB, `UPDATE auth_sessions SET active_event_id = ? WHERE id = ?`, active.id, session.id);
    session.active_event_id = active.id;
  }
  c.set('event', active);

  if (active) {
    const member = await one<{ role: Role }>(
      c.env.DB,
      `SELECT role FROM org_members WHERE org_id = ? AND user_id = ?`,
      active.org_id,
      user.id
    );
    c.set('role', member?.role ?? null);
  }

  return next();
};

export const requireUser: MiddlewareHandler<Ctx> = async (c, next) => {
  if (!c.var.user) {
    const to = new URL(c.req.url);
    return c.redirect(`/signin?next=${encodeURIComponent(to.pathname + to.search)}`);
  }
  return next();
};

const RANK: Record<Role, number> = { collaborator: 1, admin: 2, owner: 3 };

export function requireOrgRole(min: Role): MiddlewareHandler<Ctx> {
  return async (c, next) => {
    const role = c.var.role;
    if (!role || RANK[role] < RANK[min]) {
      return c.text('Forbidden', 403);
    }
    return next();
  };
}

export async function setActiveEvent(c: Context<Ctx>, eventId: string): Promise<void> {
  const session = c.var.session;
  if (!session) return;
  await run(c.env.DB, `UPDATE auth_sessions SET active_event_id = ? WHERE id = ?`, eventId, session.id);
}
