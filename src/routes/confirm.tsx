/**
 * Tokenized confirmation from the accept email: GET renders a themed page
 * with an explicit button (so mail scanners that prefetch links never consume
 * the single-use token); POST verifies + confirms + signs the speaker in-page.
 */
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { Ctx } from '../types';
import { one } from '../lib/db';
import { verifyMagicToken } from '../lib/auth';
import { confirmParticipation } from '../lib/confirm';
import { parseTheme } from '../lib/theme';
import { GOOGLE_FONTS, MONO } from '../views/layout';

const app = new Hono<Ctx>();

type TokenSub = { title: string; slug: string; name: string; theme_json: string };

async function subForToken(c: { env: Ctx['Bindings'] }, token: string): Promise<{ submissionId: string; info: TokenSub } | null> {
  // Peek without consuming: read the row via hash but do not mark used.
  const { hashToken } = await import('../lib/auth');
  const hash = await hashToken(token);
  const row = await one<{ payload_json: string | null; used_at: string | null; expires_at: string }>(
    c.env.DB,
    `SELECT payload_json, used_at, expires_at FROM magic_tokens WHERE token_hash = ? AND purpose = 'confirm_participation'`,
    hash
  );
  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) return null;
  const payload = row.payload_json ? (JSON.parse(row.payload_json) as { submissionId?: string }) : null;
  if (!payload?.submissionId) return null;
  const info = await one<TokenSub>(
    c.env.DB,
    `SELECT s.title, e.slug, e.name, e.theme_json FROM submissions s JOIN events e ON e.id = s.event_id WHERE s.id = ?`,
    payload.submissionId
  );
  if (!info) return null;
  return { submissionId: payload.submissionId, info };
}

const Shell = (props: { theme: ReturnType<typeof parseTheme>; eventName: string; children: unknown }) => (
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{props.eventName} — Confirm participation</title>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="stylesheet" href={GOOGLE_FONTS} />
      <style>{raw(`html,body{margin:0;padding:0;background:${props.theme.bg};color:#1a1a2e;font-family:'Space Grotesk',sans-serif;}`)}</style>
    </head>
    <body>
      <div style="min-height:100vh;display:grid;place-items:center;padding:32px 20px;">
        <div style="width:460px;max-width:100%;text-align:center;">{props.children}</div>
      </div>
    </body>
  </html>
);

app.get('/confirm/:token', async (c) => {
  const token = c.req.param('token');
  const found = await subForToken(c, token);
  if (!found) {
    return c.html(
      <Shell theme={parseTheme('{}')} eventName="Unsession">
        <div style="font-size:19px;font-weight:700;">This confirmation link has expired or was already used</div>
        <div style="font-size:13.5px;color:#555a63;margin-top:10px;">
          You can confirm any time from your speaker portal — sign in with your email there.
        </div>
      </Shell>,
      410
    );
  }
  const theme = parseTheme(found.info.theme_json);
  return c.html(
    <Shell theme={theme} eventName={found.info.name}>
      <div style={`font-family:${MONO};font-size:10.5px;letter-spacing:0.14em;color:${theme.primary};margin-bottom:10px;`}>
        {found.info.name.toUpperCase()} · SPEAKER CONFIRMATION
      </div>
      <div style="font-size:22px;font-weight:700;letter-spacing:-0.01em;line-height:1.25;">
        Confirm your participation for “{found.info.title}”
      </div>
      <div style="font-size:14px;color:#555a63;margin-top:10px;line-height:1.55;">
        Confirming puts your session on the public agenda and unlocks your onboarding checklist in the speaker portal.
      </div>
      <form method="post" action={`/confirm/${token}`} style="margin-top:22px;">
        <button
          type="submit"
          style={`padding:13px 26px;background:${theme.primary};color:#fff;border:none;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;`}
        >
          Confirm participation
        </button>
      </form>
      <div style="font-size:12px;color:#8b857a;margin-top:16px;">
        Can’t make it? Open your <a href={`/${found.info.slug}/portal`} style={`color:${theme.primary};`}>speaker portal</a> to withdraw instead.
      </div>
    </Shell>
  );
});

app.post('/confirm/:token', async (c) => {
  const token = c.req.param('token');
  const verified = await verifyMagicToken(c.env, token);
  const payload = verified?.payload as { submissionId?: string } | null;
  if (!verified || verified.purpose !== 'confirm_participation' || !payload?.submissionId) {
    return c.redirect(`/confirm/${token}`); // GET renders the expired state
  }
  const result = await confirmParticipation(c.env, payload.submissionId, verified.email);
  const info = await one<TokenSub>(
    c.env.DB,
    `SELECT s.title, e.slug, e.name, e.theme_json FROM submissions s JOIN events e ON e.id = s.event_id WHERE s.id = ?`,
    payload.submissionId
  );
  const theme = parseTheme(info?.theme_json ?? '{}');
  if (!result.ok) {
    return c.html(
      <Shell theme={theme} eventName={info?.name ?? 'Unsession'}>
        <div style="font-size:19px;font-weight:700;">This submission can’t be confirmed right now</div>
        <div style="font-size:13.5px;color:#555a63;margin-top:10px;">
          Its status may have changed. Check your <a href={`/${info?.slug}/portal`} style={`color:${theme.primary};`}>speaker portal</a> or contact the organizers.
        </div>
      </Shell>,
      409
    );
  }
  return c.html(
    <Shell theme={theme} eventName={info?.name ?? 'Unsession'}>
      <div style={`width:56px;height:56px;background:${theme.primary};color:#fff;display:grid;place-items:center;font-size:26px;margin:0 auto 18px;`}>✓</div>
      <div style="font-size:22px;font-weight:700;letter-spacing:-0.01em;">
        {result.already ? 'Already confirmed — see you there!' : 'You’re confirmed 🎉'}
      </div>
      <div style="font-size:14px;color:#555a63;margin-top:10px;line-height:1.55;">
        “{info?.title}” is on the {info?.name} agenda. Your onboarding checklist is ready in the speaker portal.
      </div>
      <div style="margin-top:22px;">
        <a
          href={`/${info?.slug}/portal`}
          style={`display:inline-block;padding:12px 24px;background:#1a1a2e;color:#fff;font-size:14px;font-weight:600;text-decoration:none;`}
        >
          Open speaker portal →
        </a>
      </div>
    </Shell>
  );
});

export default app;
