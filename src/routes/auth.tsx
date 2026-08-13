/**
 * Sign in + auth routes (spec §5.2, §5.3). Visual port of the prototype's
 * `Sign In.dc.html`, with the demo persona list replaced by the sandbox CTA.
 *
 * Credentials are email + password. Magic tokens survive only as emailed
 * action links — `/auth/verify` still consumes invite and draft links, and
 * `password_reset` tokens land on `/auth/reset`, which doubles as the "set
 * your first password" flow for accounts created before passwords existed.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { raw } from 'hono/html';
import type { FC } from 'hono/jsx';
import type { Ctx, User } from '../types';
import { MONO, GOOGLE_FONTS, ADMIN_BASE_CSS, Toast } from '../views/layout';
import { Favicons } from '../views/meta';
import { ProductLogo } from '../views/brand';
import {
  createSession,
  destroySession,
  findOrCreateUserByEmail,
  hashPassword,
  requestPasswordReset,
  requireUser,
  verifyMagicToken,
  verifyPassword,
} from '../lib/auth';
import { newId } from '../lib/ids';
import { now, one, run } from '../lib/db';
import { deleteCookie, getCookie } from 'hono/cookie';
import { SANDBOX_COOKIE } from '../lib/seed-data';

const app = new Hono<Ctx>();

/** Centered auth-page frame — also used by the sandbox role picker (routes/sandbox.tsx). */
export const Shell: FC<{ title: string; toast?: string | null; width?: number; children?: unknown }> = (props) => (
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{`Unsession — ${props.title}`}</title>
      <Favicons />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link href={GOOGLE_FONTS} rel="stylesheet" />
      <style>{raw(ADMIN_BASE_CSS)}</style>
    </head>
    <body>
      <div style="min-height:100vh;display:grid;place-items:center;padding:32px 20px;">
        <div style={`width:${props.width ?? 400}px;max-width:100%;`}>
          <a href="/" aria-label="Unsession home" style="display:flex;justify-content:center;margin-bottom:26px;text-decoration:none;">
            <ProductLogo height={28} />
          </a>
          {props.children as never}
        </div>
      </div>
      <Toast message={props.toast} />
      <script type="module" src="/js/ui.js"></script>
    </body>
  </html>
);

const LABEL = `font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#9a9da6;margin-bottom:5px;`;
const INPUT = 'width:100%;padding:9px 11px;border:1px solid #d4d5db;font-size:13.5px;background:#fff;';
const PRIMARY_BTN =
  'display:block;width:100%;text-align:center;padding:11px;background:#4c5fd5;color:#fff;font-size:14px;font-weight:600;border:none;cursor:pointer;';
const HINT = 'font-size:12px;color:#9a9da6;margin-top:16px;line-height:1.5;';

const MIN_PASSWORD = 8;

/** The prototype's inline error strip, shown from the `err` query param. */
const Err: FC<{ message?: string | null }> = (props) =>
  props.message ? (
    <div style="border:1px solid #e03131;background:#fbe9e9;color:#c92a2a;padding:9px 11px;font-size:12.5px;margin-bottom:14px;">
      {props.message}
    </div>
  ) : null;

function safeNext(next: unknown, fallback = '/app'): string {
  return typeof next === 'string' && next.startsWith('/') ? next : fallback;
}

function withOk(target: string, message: string): string {
  return `${target}${target.includes('?') ? '&' : '?'}ok=${encodeURIComponent(message)}`;
}

function backTo(path: string, err: string, next?: string): string {
  const p = new URLSearchParams();
  if (next) p.set('next', next);
  p.set('err', err);
  return `${path}?${p.toString()}`;
}

/**
 * A sandbox persona session (the `us_sandbox` crumb from routes/sandbox.tsx)
 * must not count as "already signed in" on /signin and /signup — the visitor
 * pressing those buttons wants their own account, not the seat they were
 * trying out.
 */
function inSandbox(c: Context<Ctx>): boolean {
  return Boolean(getCookie(c, SANDBOX_COOKIE));
}

/** Drop the persona session and its role-switcher crumb before opening a real one. */
async function shedSandbox(c: Context<Ctx>): Promise<void> {
  await destroySession(c);
  deleteCookie(c, SANDBOX_COOKIE, { path: '/' });
}

/* ------------------------------------------------------------------ sign in */

app.get('/signin', (c) => {
  if (c.var.user && !inSandbox(c)) return c.redirect(c.req.query('next') || '/app');
  const next = c.req.query('next') || '';
  const err = c.req.query('err');
  const host = c.env.APP_ORIGIN.replace(/^https?:\/\//, '');
  return c.html(
    <Shell title="Sign in" toast={c.req.query('ok') ?? null}>
      <div style="background:#fff;border:1px solid #e2e3e8;padding:28px;">
        <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;margin-bottom:2px;">Sign in</div>
        <div style="font-size:13px;color:#686b74;margin-bottom:20px;">{`Organizer workspace · ${host}`}</div>
        <Err message={err} />
        <form method="post" action="/auth/signin" style="display:flex;flex-direction:column;gap:12px;">
          <input type="hidden" name="next" value={next} />
          <label style="display:block;">
            <div style={LABEL}>EMAIL</div>
            <input name="email" type="email" required autofocus placeholder="you@example.com" style={INPUT} />
          </label>
          <label style="display:block;">
            <div style={LABEL}>PASSWORD</div>
            <input name="password" type="password" required autocomplete="current-password" style={INPUT} />
          </label>
          <button type="submit" data-busy="Signing in…" style={PRIMARY_BTN}>
            Sign in
          </button>
        </form>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;font-size:12.5px;">
          <a href={next ? `/auth/forgot?next=${encodeURIComponent(next)}` : '/auth/forgot'}>Forgot password?</a>
          <a href={next ? `/signup?next=${encodeURIComponent(next)}` : '/signup'}>New here? Create an account</a>
        </div>
        <div style={HINT}>Signs you in on this device for 30 days.</div>
      </div>
      <div style="margin-top:22px;">
        <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.14em;color:#9a9da6;margin-bottom:8px;text-align:center;`}>
          NEW HERE?
        </div>
        <div style="background:#fff;border:1px solid #e2e3e8;display:flex;flex-direction:column;">
          <form method="post" action="/sandbox">
            <button
              type="submit"
              data-busy="Opening the sandbox…"
              style="display:flex;align-items:center;justify-content:center;gap:10px;padding:11px 16px;width:100%;background:#fff;border:none;cursor:pointer;text-align:center;"
            >
              <span style={`width:26px;height:26px;border-radius:50%;background:#e8590c;color:#fff;display:grid;place-items:center;font-family:${MONO};font-size:10px;font-weight:600;flex:none;`}>
                DC
              </span>
              <span style="font-size:13.5px;font-weight:600;">Open the DevConf 2027 sandbox</span>
              <span style={`font-family:${MONO};font-size:10px;color:#9a9da6;`}>TRY IT →</span>
            </button>
          </form>
        </div>
      </div>
    </Shell>
  );
});

app.post('/auth/signin', async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email ?? '').trim();
  const password = String(body.password ?? '');
  const next = String(body.next ?? '');

  if (!email || !email.includes('@')) {
    return c.redirect(backTo('/signin', 'Enter a valid email address', next));
  }

  const user = await one<User>(c.env.DB, `SELECT * FROM users WHERE email = ?`, email);

  // Accounts created before passwords existed (invites, draft links, seeded
  // people) have no hash — the reset email is the only proof of ownership we
  // will accept before letting anyone set one.
  if (user && !user.password_hash) {
    return c.redirect(
      backTo('/signin', 'This account doesn’t have a password yet — use “Forgot password?” to set one.', next)
    );
  }

  const ok = user ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !ok) {
    return c.redirect(backTo('/signin', 'Invalid email or password', next));
  }

  await shedSandbox(c);
  await createSession(c, user.id, null);
  return c.redirect(withOk(safeNext(next), 'Signed in'));
});

/* ------------------------------------------------------------------ sign up */

app.get('/signup', (c) => {
  if (c.var.user && !inSandbox(c)) return c.redirect(c.req.query('next') || '/app');
  const next = c.req.query('next') || '';
  return c.html(
    <Shell title="Create an account" toast={c.req.query('ok') ?? null}>
      <div style="background:#fff;border:1px solid #e2e3e8;padding:28px;">
        <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;margin-bottom:2px;">Create an account</div>
        <div style="font-size:13px;color:#686b74;margin-bottom:20px;">Run your own event on Unsession</div>
        <Err message={c.req.query('err')} />
        <form method="post" action="/auth/signup" style="display:flex;flex-direction:column;gap:12px;">
          <input type="hidden" name="next" value={next} />
          <label style="display:block;">
            <div style={LABEL}>NAME</div>
            <input name="name" type="text" autofocus placeholder="Marta Keller" style={INPUT} />
          </label>
          <label style="display:block;">
            <div style={LABEL}>EMAIL</div>
            <input name="email" type="email" required placeholder="you@example.com" style={INPUT} />
          </label>
          <label style="display:block;">
            <div style={LABEL}>PASSWORD</div>
            <input
              name="password"
              type="password"
              required
              minlength={MIN_PASSWORD}
              autocomplete="new-password"
              style={INPUT}
            />
          </label>
          <button type="submit" data-busy="Creating account…" style={PRIMARY_BTN}>
            Create account
          </button>
        </form>
        <div style="margin-top:14px;font-size:12.5px;">
          <a href={next ? `/signin?next=${encodeURIComponent(next)}` : '/signin'}>← Already have an account? Sign in</a>
        </div>
        <div style={HINT}>{`At least ${MIN_PASSWORD} characters. Signs you in on this device for 30 days.`}</div>
      </div>
    </Shell>
  );
});

app.post('/auth/signup', async (c) => {
  const body = await c.req.parseBody();
  const name = String(body.name ?? '').trim();
  const email = String(body.email ?? '').trim();
  const password = String(body.password ?? '');
  const next = String(body.next ?? '');

  if (!email || !email.includes('@')) {
    return c.redirect(backTo('/signup', 'Enter a valid email address', next));
  }
  if (password.length < MIN_PASSWORD) {
    return c.redirect(backTo('/signup', `Choose a password of at least ${MIN_PASSWORD} characters`, next));
  }

  // Existing rows include accounts auto-created from an emailed link, so
  // signup must never attach a password to one — that would be takeover.
  const existing = await one<User>(c.env.DB, `SELECT * FROM users WHERE email = ?`, email);
  if (existing) {
    return c.redirect(
      backTo('/signin', 'That email already has an account — sign in or use “Forgot password?”.', next)
    );
  }

  const id = newId('usr');
  await run(
    c.env.DB,
    `INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
    id,
    email,
    name || null,
    await hashPassword(password),
    now()
  );

  await shedSandbox(c);
  await createSession(c, id, null);
  return c.redirect(withOk(safeNext(next), 'Welcome'));
});

/* ------------------------------------------------------------------ forgot / reset */

app.get('/auth/forgot', (c) => {
  const next = c.req.query('next') || '';
  return c.html(
    <Shell title="Forgot password">
      <div style="background:#fff;border:1px solid #e2e3e8;padding:28px;">
        <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;margin-bottom:2px;">Set a password</div>
        <div style="font-size:13px;color:#686b74;margin-bottom:20px;line-height:1.55;">
          We’ll email you a link to set a new password. Use this too if your account never had one.
        </div>
        <Err message={c.req.query('err')} />
        <form method="post" action="/auth/forgot" style="display:flex;flex-direction:column;gap:12px;">
          <input type="hidden" name="next" value={next} />
          <label style="display:block;">
            <div style={LABEL}>EMAIL</div>
            <input name="email" type="email" required autofocus placeholder="you@example.com" style={INPUT} />
          </label>
          <button type="submit" data-busy="Sending…" style={PRIMARY_BTN}>
            Email me a reset link
          </button>
        </form>
        <div style="margin-top:14px;font-size:12.5px;">
          <a href={next ? `/signin?next=${encodeURIComponent(next)}` : '/signin'}>← Back to sign in</a>
        </div>
      </div>
    </Shell>
  );
});

app.post('/auth/forgot', async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email ?? '').trim();
  const next = String(body.next ?? '');
  if (!email || !email.includes('@')) {
    return c.redirect(backTo('/auth/forgot', 'Enter a valid email address', next));
  }

  // Sent unconditionally — whether an address has an account is not something
  // this page should reveal.
  const res = await requestPasswordReset(c.env, email, next ? { next } : undefined);

  return c.html(
    <Shell title="Check your email">
      <div style="background:#fff;border:1px solid #e2e3e8;padding:28px;">
        <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;margin-bottom:2px;">Check your email</div>
        <div style="font-size:13px;color:#686b74;margin-bottom:18px;line-height:1.55;">
          If <span style={`font-family:${MONO};`}>{email}</span> has an account, we sent it a link to set a password. It
          works once and expires in 30 minutes.
        </div>
        {res.simulatedLink ? (
          <div style="border:1px solid #b08800;background:#fdf5dc;padding:12px 14px;margin-bottom:16px;">
            <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.12em;color:#b08800;margin-bottom:6px;`}>
              DEV MODE — EMAIL SENDING NOT YET ENABLED
            </div>
            <div style="font-size:12.5px;color:#686b74;margin-bottom:8px;">Open your password link directly:</div>
            <a href={res.simulatedLink} style="font-size:12.5px;word-break:break-all;">
              {res.simulatedLink}
            </a>
          </div>
        ) : null}
        <a href="/auth/forgot" style="font-size:12.5px;">
          ← Use a different email
        </a>
      </div>
    </Shell>
  );
});

/** Password form for an emailed reset token. The token is only consumed on POST. */
const ResetForm: FC<{ token: string; err?: string | null }> = (props) => (
  <Shell title="Choose a password">
    <div style="background:#fff;border:1px solid #e2e3e8;padding:28px;">
      <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;margin-bottom:2px;">Choose a password</div>
      <div style="font-size:13px;color:#686b74;margin-bottom:20px;">This link works once.</div>
      <Err message={props.err} />
      <form method="post" action="/auth/reset" style="display:flex;flex-direction:column;gap:12px;">
        <input type="hidden" name="token" value={props.token} />
        <label style="display:block;">
          <div style={LABEL}>NEW PASSWORD</div>
          <input
            name="password"
            type="password"
            required
            minlength={MIN_PASSWORD}
            autofocus
            autocomplete="new-password"
            style={INPUT}
          />
        </label>
        <label style="display:block;">
          <div style={LABEL}>CONFIRM PASSWORD</div>
          <input name="confirm" type="password" required autocomplete="new-password" style={INPUT} />
        </label>
        <button type="submit" data-busy="Saving…" style={PRIMARY_BTN}>
          Set password
        </button>
      </form>
      <div style={HINT}>{`At least ${MIN_PASSWORD} characters.`}</div>
    </div>
  </Shell>
);

app.get('/auth/reset', (c) => {
  const token = c.req.query('token') ?? '';
  if (!token) {
    return c.redirect('/signin?err=' + encodeURIComponent('That link is missing its token — request a new one'));
  }
  return c.html(<ResetForm token={token} err={c.req.query('err')} />);
});

app.post('/auth/reset', async (c) => {
  const body = await c.req.parseBody();
  const token = String(body.token ?? '');
  const password = String(body.password ?? '');
  const confirm = String(body.confirm ?? '');

  // Validate the typed fields before consuming the token — a typo in the
  // confirm field must not burn a single-use link.
  if (password.length < MIN_PASSWORD) {
    return c.html(<ResetForm token={token} err={`Choose a password of at least ${MIN_PASSWORD} characters`} />);
  }
  if (password !== confirm) {
    return c.html(<ResetForm token={token} err="Those passwords don’t match" />);
  }

  const verified = await verifyMagicToken(c.env, token);
  if (!verified || verified.purpose !== 'password_reset') {
    return c.redirect('/signin?err=' + encodeURIComponent('That link has expired or was already used'));
  }

  const payload = (verified.payload ?? {}) as Record<string, unknown>;
  const user = await findOrCreateUserByEmail(c.env.DB, verified.email);
  await run(c.env.DB, `UPDATE users SET password_hash = ? WHERE id = ?`, await hashPassword(password), user.id);

  await shedSandbox(c);
  await createSession(c, user.id, null);
  return c.redirect(withOk(safeNext(payload.next), 'Password set'));
});

/* ------------------------------------------------------------------ first password (session-verified) */

app.get('/auth/set-password', requireUser, (c) => {
  const next = c.req.query('next') || '/app';
  // Only for accounts that still have no hash: their session came from a
  // verified email link. Changing an existing password needs the reset email.
  if (c.var.user?.password_hash) return c.redirect(safeNext(next));
  return c.html(
    <Shell title="Choose a password">
      <div style="background:#fff;border:1px solid #e2e3e8;padding:28px;">
        <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;margin-bottom:2px;">Choose a password</div>
        <div style="font-size:13px;color:#686b74;margin-bottom:20px;line-height:1.55;">
          You’re signed in as <span style={`font-family:${MONO};`}>{c.var.user?.email}</span>. Pick a password so you
          can sign in without an emailed link next time.
        </div>
        <Err message={c.req.query('err')} />
        <form method="post" action="/auth/set-password" style="display:flex;flex-direction:column;gap:12px;">
          <input type="hidden" name="next" value={next} />
          <label style="display:block;">
            <div style={LABEL}>PASSWORD</div>
            <input
              name="password"
              type="password"
              required
              minlength={MIN_PASSWORD}
              autofocus
              autocomplete="new-password"
              style={INPUT}
            />
          </label>
          <button type="submit" data-busy="Saving…" style={PRIMARY_BTN}>
            Set password
          </button>
        </form>
        <div style={HINT}>{`At least ${MIN_PASSWORD} characters.`}</div>
      </div>
    </Shell>
  );
});

app.post('/auth/set-password', requireUser, async (c) => {
  const body = await c.req.parseBody();
  const password = String(body.password ?? '');
  const next = String(body.next ?? '/app');
  const user = c.var.user!;

  if (password.length < MIN_PASSWORD) {
    return c.redirect(
      backTo('/auth/set-password', `Choose a password of at least ${MIN_PASSWORD} characters`, safeNext(next))
    );
  }

  await run(c.env.DB, `UPDATE users SET password_hash = ? WHERE id = ?`, await hashPassword(password), user.id);
  return c.redirect(withOk(safeNext(next), 'Password set'));
});

/* ------------------------------------------------------------------ emailed action links */

app.get('/auth/verify', async (c) => {
  const token = c.req.query('token') ?? '';
  const verified = await verifyMagicToken(c.env, token);
  if (!verified) {
    return c.redirect('/signin?err=' + encodeURIComponent('That link has expired or was already used'));
  }
  // Password links land on /auth/reset and confirmations on /confirm — a token
  // for either purpose must not open a session here.
  if (verified.purpose === 'password_reset') {
    return c.redirect('/signin?err=' + encodeURIComponent('That was a password link — request a fresh one below'));
  }
  if (verified.purpose === 'confirm_participation') {
    return c.redirect('/signin?err=' + encodeURIComponent('That link has expired or was already used'));
  }

  const payload = (verified.payload ?? {}) as Record<string, unknown>;
  const user = await findOrCreateUserByEmail(
    c.env.DB,
    verified.email,
    typeof payload.name === 'string' ? payload.name : null
  );

  if (verified.purpose === 'invite' && typeof payload.orgId === 'string') {
    const role = typeof payload.role === 'string' ? payload.role : 'collaborator';
    const existing = await one<{ role: string }>(
      c.env.DB,
      `SELECT role FROM org_members WHERE org_id = ? AND user_id = ?`,
      payload.orgId,
      user.id
    );
    if (!existing) {
      await run(
        c.env.DB,
        `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?,?,?,?)`,
        payload.orgId,
        user.id,
        role,
        now()
      );
    }
    if (typeof payload.inviteId === 'string') {
      await run(c.env.DB, `UPDATE invites SET status = 'accepted' WHERE id = ?`, payload.inviteId);
    }
  }

  await shedSandbox(c);
  await createSession(c, user.id, null);
  const next = safeNext(payload.next);
  // Invited and draft-link people arrive without credentials — the verified
  // link is exactly the proof needed to let them pick a password now.
  if (!user.password_hash) {
    return c.redirect(`/auth/set-password?next=${encodeURIComponent(next)}`);
  }
  return c.redirect(withOk(next, 'Signed in'));
});

app.get('/auth/signout', async (c) => {
  await destroySession(c);
  deleteCookie(c, SANDBOX_COOKIE, { path: '/' }); // drop the sandbox role-switcher chip too
  return c.redirect('/');
});
app.post('/auth/signout', async (c) => {
  await destroySession(c);
  deleteCookie(c, SANDBOX_COOKIE, { path: '/' });
  return c.redirect('/');
});

export default app;
