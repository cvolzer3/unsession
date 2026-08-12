/** Sessions, magic links, Google OAuth (spec A §3). No passwords anywhere (DECISIONS D2). */
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { all, now, one, run } from './db';
import { newId } from './ids';
import { sendEmail } from './email';
import type { AuthSession, Bindings, Ctx, Event, Role, User } from '../types';

export const SESSION_COOKIE = 'us_sess';
const SESSION_DAYS = 30;
const MAGIC_MINUTES = 30;

export type MagicPurpose = 'signin' | 'invite' | 'confirm_participation' | 'draft_link';

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
    google_id: null,
    created_at: now(),
  };
  await run(
    db,
    `INSERT INTO users (id, email, name, google_id, created_at) VALUES (?, ?, ?, ?, ?)`,
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

/* ------------------------------------------------------------------ Google OAuth */

export function googleConfigured(env: Bindings): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function googleRedirectUri(env: Bindings): string {
  return `${env.APP_ORIGIN}/auth/google/callback`;
}

export function googleAuthUrl(env: Bindings, state: string): string {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: googleRedirectUri(env),
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    include_granted_scopes: 'true',
    prompt: 'select_account',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

export type GoogleProfile = { sub: string; email: string; name?: string };

export async function googleExchange(env: Bindings, code: string): Promise<GoogleProfile | null> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: googleRedirectUri(env),
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) return null;
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) return null;

  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!infoRes.ok) return null;
  const info = (await infoRes.json()) as { sub?: string; email?: string; name?: string };
  if (!info.sub || !info.email) return null;
  return { sub: info.sub, email: info.email, name: info.name };
}

/** Links a Google identity to an existing account by email, or creates one. */
export async function linkGoogleUser(db: D1Database, profile: GoogleProfile): Promise<User> {
  const byGoogle = await one<User>(db, `SELECT * FROM users WHERE google_id = ?`, profile.sub);
  if (byGoogle) return byGoogle;
  const user = await findOrCreateUserByEmail(db, profile.email, profile.name ?? null);
  await run(db, `UPDATE users SET google_id = ? WHERE id = ?`, profile.sub, user.id);
  user.google_id = profile.sub;
  return user;
}
