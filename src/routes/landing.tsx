/** Landing page `/` + the sandbox provisioner `POST /sandbox` (spec §5.1, §5.11). */
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { Ctx } from '../types';
import { MONO, GOOGLE_FONTS } from '../views/layout';
import { seedSandbox } from '../lib/seed';

const app = new Hono<Ctx>();

const BULLETS: { kicker: string; title: string; body: string }[] = [
  {
    kicker: '01 · COLLECT',
    title: 'CFP forms that fit your event',
    body: 'Multiple forms per event, conditional fields, drafts that survive a closed laptop, and co-speakers who get their own emails.',
  },
  {
    kicker: '02 · DECIDE',
    title: 'Evaluation without a spreadsheet',
    body: 'Blind review queues, 1–5 rubrics, reviewer progress you can see, and decision emails that always go through preview and confirm.',
  },
  {
    kicker: '03 · PUBLISH',
    title: 'Agenda, speakers, done',
    body: 'Accepted talks become sessions, speakers confirm and onboard themselves, and the public agenda updates the moment you publish.',
  },
];

app.get('/', (c) => {
  const signedIn = !!c.var.user;
  return c.html(
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Unsession — run your call for speakers without the bloat</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href={GOOGLE_FONTS} rel="stylesheet" />
        <style>
          {raw(`
  html,body{margin:0;padding:0;background:#faf8f5;color:#1a1a2e;font-family:'Space Grotesk',sans-serif;}
  a{color:#4c5fd5;text-decoration:none;} a:hover{color:#3a4ab8;text-decoration:underline;}
  *{box-sizing:border-box;} input,textarea,select,button{font-family:inherit;}
  @keyframes toastin{from{transform:translateY(12px);opacity:0}to{transform:none;opacity:1}}
`)}
        </style>
      </head>
      <body>
        <div style="border-bottom:1px solid #ece7de;background:#faf8f5;">
          <div style="max-width:1000px;margin:0 auto;padding:14px 24px;display:flex;align-items:center;gap:10px;">
            <div style={`width:26px;height:26px;background:#4c5fd5;color:#fff;display:grid;place-items:center;font-family:${MONO};font-size:12px;font-weight:600;`}>
              U
            </div>
            <div style="font-weight:700;font-size:15px;letter-spacing:-0.01em;">Unsession</div>
            <div style="margin-left:auto;font-size:13px;">
              <a href={signedIn ? '/app' : '/signin'}>{signedIn ? 'Open workspace →' : 'Sign in →'}</a>
            </div>
          </div>
        </div>

        <div style="max-width:1000px;margin:0 auto;padding:72px 24px 40px;">
          <div style={`font-family:${MONO};font-size:10.5px;letter-spacing:0.14em;color:#e8590c;margin-bottom:12px;`}>
            CONFERENCE SESSION BOOKING
          </div>
          <h1 style="margin:0 0 14px;font-size:44px;line-height:1.08;letter-spacing:-0.03em;max-width:16ch;">
            Run your call for speakers without the bloat
          </h1>
          <p style="margin:0 0 30px;font-size:16.5px;line-height:1.55;color:#555a63;max-width:60ch;">
            Unsession takes a conference from call for speakers to published agenda: submissions, evaluation,
            decisions, speaker onboarding, and the public schedule. Nothing else.
          </p>
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
            <form method="post" action="/sandbox">
              <button
                type="submit"
                style="padding:12px 20px;background:#e8590c;color:#fff;border:none;font-size:14px;font-weight:600;cursor:pointer;"
              >
                Try the sandbox →
              </button>
            </form>
            <a
              href="/signin"
              style="padding:12px 20px;background:#fff;border:1px solid #ded8cd;color:#1a1a2e;font-size:14px;font-weight:600;text-decoration:none;"
            >
              Sign in
            </a>
            <span style={`font-family:${MONO};font-size:11px;color:#8b857a;`}>
              No account needed — the sandbox is a real event, pre-filled.
            </span>
          </div>
        </div>

        <div style="max-width:1000px;margin:0 auto;padding:0 24px 72px;">
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;">
            {BULLETS.map((b) => (
              <div style="background:#fff;border:1px solid #ece7de;padding:20px;">
                <div style={`font-family:${MONO};font-size:9.5px;letter-spacing:0.14em;color:#8b857a;margin-bottom:10px;`}>
                  {b.kicker}
                </div>
                <div style="font-size:16.5px;font-weight:700;letter-spacing:-0.01em;margin-bottom:6px;">{b.title}</div>
                <div style="font-size:13.5px;line-height:1.55;color:#555a63;">{b.body}</div>
              </div>
            ))}
          </div>
        </div>

        <div style="border-top:1px solid #ece7de;">
          <div style={`max-width:1000px;margin:0 auto;padding:18px 24px;font-family:${MONO};font-size:10.5px;letter-spacing:0.12em;color:#8b857a;`}>
            UNSESSION
          </div>
        </div>
      </body>
    </html>
  );
});

/** Provisions a sandbox org + event, then hands the visitor the role picker. */
app.post('/sandbox', async (c) => {
  const { orgId } = await seedSandbox(c.env.DB);
  return c.redirect(`/sandbox/${orgId}`);
});

export default app;
