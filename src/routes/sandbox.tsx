/**
 * Sandbox role picker + role switcher (spec §4.13, DECISIONS review round).
 *
 * `POST /sandbox` (routes/landing.tsx) provisions a seeded org and redirects
 * to `GET /sandbox/:org` — a login-style page with the three pre-made
 * personas. Picking one signs the visitor in AS that seeded user:
 *
 *   Organizer  Marta Keller → /app (she owns the sandbox org)
 *   Speaker    Sofia Rossi  → /{slug}/portal (her profile is user-linked)
 *   Evaluator  Deniz Aksoy  → /{slug}/evaluate (on two reviewer rosters)
 *
 * `POST /sandbox/switch` is the same sign-in driven from the bottom-right
 * widget (views/layout.tsx). Both paths verify the org has `is_sandbox = 1`
 * AND resolve the persona through that org's own tables (membership /
 * reviewer roster / speaker profile), so this can never sign anyone into a
 * real org and never crosses sandboxes.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Ctx, Event, Org, User } from '../types';
import { MONO, initials } from '../views/layout';
import { Shell } from './auth';
import { createSession, destroySession } from '../lib/auth';
import { one } from '../lib/db';
import {
  EVENT,
  SANDBOX_COOKIE,
  SANDBOX_PERSONAS,
  SANDBOX_PERSONA_KEYS,
  suffixEmail,
  type SandboxPersonaKey,
} from '../lib/seed-data';

const app = new Hono<Ctx>();

/* ------------------------------------------------------------------ lookup */

type Sandbox = { org: Org; event: Event; suffix: string };

/** The org (sandboxes only — `is_sandbox = 1` is non-negotiable) and its one event. */
async function loadSandbox(db: D1Database, orgId: string): Promise<Sandbox | null> {
  if (!orgId) return null;
  const org = await one<Org>(db, `SELECT * FROM orgs WHERE id = ? AND is_sandbox = 1`, orgId);
  if (!org) return null;
  const event = await one<Event>(db, `SELECT * FROM events WHERE org_id = ? ORDER BY created_at LIMIT 1`, org.id);
  if (!event) return null;
  // Sandbox slugs are `devconf-2027-<suffix>`; the suffix plus-addresses every persona email.
  const suffix = event.slug.startsWith(`${EVENT.slug}-`) ? event.slug.slice(EVENT.slug.length + 1) : '';
  return { org, event, suffix };
}

/**
 * Resolve a persona to its user row, scoped to THIS sandbox: the exact
 * plus-suffixed email must also be wired into the org's own tables, so a
 * user from another sandbox (or anywhere else) never resolves.
 */
async function personaUser(db: D1Database, sb: Sandbox, key: SandboxPersonaKey): Promise<User | null> {
  const email = suffixEmail(SANDBOX_PERSONAS[key].email, sb.suffix);
  if (key === 'organizer') {
    return one<User>(
      db,
      `SELECT u.* FROM users u JOIN org_members m ON m.user_id = u.id
        WHERE m.org_id = ? AND m.role = 'owner' AND u.email = ?`,
      sb.org.id,
      email
    );
  }
  if (key === 'evaluator') {
    return one<User>(
      db,
      `SELECT u.* FROM users u
         JOIN eval_plan_reviewers r ON r.user_id = u.id
         JOIN eval_plans p ON p.id = r.plan_id
        WHERE p.event_id = ? AND u.email = ?`,
      sb.event.id,
      email
    );
  }
  return one<User>(
    db,
    `SELECT u.* FROM users u JOIN speaker_profiles sp ON sp.user_id = u.id
      WHERE sp.event_id = ? AND u.email = ?`,
    sb.event.id,
    email
  );
}

function isPersonaKey(v: string): v is SandboxPersonaKey {
  return (SANDBOX_PERSONA_KEYS as string[]).includes(v);
}

/* ----------------------------------------------------------------- sign-in */

/** Re-signs the visitor in as the persona and lands them on its home surface. */
async function enterAs(c: Context<Ctx>, sb: Sandbox, key: SandboxPersonaKey): Promise<Response> {
  const user = await personaUser(c.env.DB, sb, key);
  if (!user) {
    return c.redirect('/signin?err=' + encodeURIComponent('That sandbox is gone — start a fresh one from the landing page'));
  }
  const p = SANDBOX_PERSONAS[key];
  await destroySession(c);
  await createSession(c, user.id, key === 'organizer' ? sb.event.id : null);
  // Client-readable crumb for the public layout's role-switcher chip.
  setCookie(c, SANDBOX_COOKIE, JSON.stringify({ o: sb.org.id, s: sb.event.slug, p: key, n: `${p.first} (${p.title})` }), {
    httpOnly: false,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 86_400,
  });
  const dest =
    key === 'organizer' ? '/app' : key === 'speaker' ? `/${sb.event.slug}/portal` : `/${sb.event.slug}/evaluate`;
  return c.redirect(`${dest}?ok=${encodeURIComponent(`Sandbox — viewing as ${p.name} (${p.title})`)}`);
}

/* ------------------------------------------------------------------ routes */

/**
 * The seat row is avatar · title+blurb · persona name. Below the breakpoint
 * there is no room for all three side by side, so the name drops to its own
 * line under the blurb. `margin-left:auto` has to live here rather than
 * inline, or the media query could not undo it.
 */
const CSS = `
  .sb-seat{display:flex;align-items:center;gap:12px;}
  .sb-text{flex:0 1 auto;min-width:0;}
  .sb-who{margin-left:auto;flex:none;}
  @media(max-width:768px){
    .sb-seat{flex-wrap:wrap;}
    /* flex:1 1 0 keeps the title+blurb beside the avatar and wraps its text
       inside; an auto basis would send the whole block to its own line */
    .sb-text{flex:1 1 0;}
    .sb-who{margin-left:42px;flex:1 0 100%;}
  }
`;

app.get('/sandbox/:org', async (c) => {
  const sb = await loadSandbox(c.env.DB, c.req.param('org'));
  if (!sb) return c.notFound();
  return c.html(
    <Shell title="Sandbox — choose your seat" width={440} css={CSS} toast={c.req.query('ok') ?? null}>
      <div style="background:#fff;border:1px solid #e2e3e8;padding:28px;">
        <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.14em;color:#e8590c;margin-bottom:8px;`}>
          DEVCONF 2027 · SANDBOX
        </div>
        <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;margin-bottom:2px;">Choose your seat</div>
        <div style="font-size:13px;color:#686b74;margin-bottom:18px;line-height:1.55;">
          You can easily switch roles at any time.
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          {SANDBOX_PERSONA_KEYS.map((key) => {
            const p = SANDBOX_PERSONAS[key];
            return (
              <form method="post" action={`/sandbox/${sb.org.id}/enter`}>
                <input type="hidden" name="persona" value={key} />
                <button
                  type="submit"
                  class="sb-seat"
                  style="width:100%;padding:13px 14px;background:#fff;border:1px solid #d4d5db;cursor:pointer;text-align:left;"
                >
                  <span
                    style={`width:30px;height:30px;border-radius:50%;background:${p.color};color:#fff;display:grid;place-items:center;font-family:${MONO};font-size:11px;font-weight:600;flex:none;`}
                  >
                    {initials(p.name)}
                  </span>
                  <span class="sb-text">
                    <span style="display:block;font-size:13.5px;font-weight:600;color:#16171d;">{p.title}</span>
                    <span style="display:block;font-size:12px;color:#686b74;">{p.blurb}</span>
                  </span>
                  <span class="sb-who" style={`font-family:${MONO};font-size:10px;letter-spacing:0.08em;color:#9a9da6;`}>
                    {`${p.name.toUpperCase()} →`}
                  </span>
                </button>
              </form>
            );
          })}
        </div>
      </div>
    </Shell>
  );
});

app.post('/sandbox/:org/enter', async (c) => {
  const sb = await loadSandbox(c.env.DB, c.req.param('org'));
  if (!sb) return c.notFound();
  const body = await c.req.parseBody();
  const key = String(body.persona ?? '');
  if (!isPersonaKey(key)) return c.notFound();
  return enterAs(c, sb, key);
});

app.post('/sandbox/switch', async (c) => {
  const body = await c.req.parseBody();
  const key = String(body.persona ?? '');
  const sb = await loadSandbox(c.env.DB, String(body.org ?? ''));
  if (!sb || !isPersonaKey(key)) return c.notFound();
  return enterAs(c, sb, key);
});

export default app;
