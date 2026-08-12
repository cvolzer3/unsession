/** Landing page `/` + the sandbox provisioner `POST /sandbox` (spec §5.1, §5.11). */
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { Ctx } from '../types';
import { MONO, GOOGLE_FONTS } from '../views/layout';
import { seedSandbox } from '../lib/seed';

const app = new Hono<Ctx>();

const GITHUB = 'https://github.com/cvolzer3/unsession';

/* ------------------------------------------------------------ product walk */

type Card = { t: string; b: string };
type Phase = { num: string; kicker: string; title: string; lede: string; cards: Card[] };

const WALK: Phase[] = [
  {
    num: '01',
    kicker: 'COLLECT',
    title: 'A branded CFP, live in fifteen minutes',
    lede: 'Build the form, share the link. Fixed core fields keep every submission structured; everything else is yours to shape.',
    cards: [
      {
        t: 'Form builder',
        b: 'Word-limited long text with live counters, selects bound to your event’s taxonomies, URLs, emails, and file uploads — on top of fixed core fields every review screen can rely on.',
      },
      {
        t: 'Conditional logic',
        b: 'Show or hide any field based on earlier answers, so a workshop pitch and a lightning talk don’t share one bloated form.',
      },
      {
        t: 'Drafts & autosave',
        b: 'Autosave from the first keystroke. Anonymous drafts survive a closed laptop, and an emailed draft link carries them across devices.',
      },
      {
        t: 'Co-speakers',
        b: 'A submission carries one to many speakers, each with their own name, bio, headshot, and emails. Forms set the cap.',
      },
      {
        t: 'Multiple forms per event',
        b: 'Main CFP, workshop CFP, sponsor intake — each form has its own fields, settings, and versioning.',
      },
      {
        t: 'Mobile-first public forms',
        b: 'Themed to your event and server-rendered, so they stay fast on conference-hall wifi.',
      },
    ],
  },
  {
    num: '02',
    kicker: 'DECIDE',
    title: 'Evaluation without the spreadsheet export',
    lede: 'Score in the product, decide in the product, and let the emails write themselves — with a preview first, always.',
    cards: [
      {
        t: 'Evaluation plans',
        b: 'Scope a plan to a slice of submissions, pick the reviewers, and define rubric criteria scored 1–5.',
      },
      {
        t: 'Blind review',
        b: 'One toggle anonymizes speaker names, emails, and bios, so the work gets judged — not the byline.',
      },
      {
        t: 'Keyboard scoring',
        b: 'Reviewers score with the number keys and submit with Enter. A hundred submissions is an evening, not a weekend.',
      },
      {
        t: 'Reviewer progress',
        b: 'See who’s finished and who’s behind, per plan, without sending a single chasing email.',
      },
      {
        t: 'Decisions with a safety net',
        b: 'Accept, decline, or waitlist — individually or in bulk. Every decision email goes through preview and confirm before it leaves.',
      },
      {
        t: 'Import & export',
        b: 'CSV in from your old tool; CSV or XLSX out whenever someone upstream wants a spreadsheet anyway.',
      },
    ],
  },
  {
    num: '03',
    kicker: 'ONBOARD',
    title: 'Speakers who onboard themselves',
    lede: 'Acceptance isn’t the finish line. The portal walks each speaker from “accepted” to “ready for the stage.”',
    cards: [
      {
        t: 'Speaker portal',
        b: 'Magic-link sign-in, no passwords. Speakers see their submissions, statuses, tasks, and profile in one place.',
      },
      {
        t: 'Confirmation gate',
        b: 'Speakers explicitly confirm participation — and unconfirmed speakers can be held off the public agenda automatically.',
      },
      {
        t: 'Task checklists',
        b: 'Task templates generate a per-speaker checklist with due dates: confirm details, complete a profile, fill a form, tick a box.',
      },
      {
        t: 'File requests',
        b: 'Ask for slides or headshots with type and size limits. Uploads land in your file storage, not your inbox.',
      },
      {
        t: 'Calendar invites',
        b: 'Scheduled sessions arrive as ICS invites, and a reschedule sends a proper calendar update — not a plea to re-read email.',
      },
      {
        t: 'Activity trail',
        b: 'Every decision, email, task, and schedule change is logged per submission, so “did we tell them?” always has an answer.',
      },
    ],
  },
  {
    num: '04',
    kicker: 'PUBLISH',
    title: 'An agenda that argues back',
    lede: 'Drag sessions onto the grid and conflicts surface immediately. Then publish it everywhere at once.',
    cards: [
      {
        t: 'Agenda builder',
        b: 'Drag-and-drop across days and rooms. Double-booked rooms and speakers in two places at once are flagged before attendees find out.',
      },
      {
        t: 'Themed public agenda',
        b: 'Pick one brand color; an accessible palette is derived for you, WCAG contrast included.',
      },
      {
        t: 'Speaker pages',
        b: 'A public speaker directory and per-speaker pages, built straight from confirmed speaker profiles.',
      },
      {
        t: 'Embeds',
        b: 'Drop the agenda or the speaker grid into your existing site; a transparent mode blends into any background.',
      },
      {
        t: 'JSON API',
        b: 'A bearer-token REST API over events, submissions, sessions, speakers, tasks, and the agenda — tokens scoped read-only or read-write.',
      },
      {
        t: 'MCP server',
        b: 'The same operations exposed over MCP, so your AI agent can query the agenda or triage the submission queue.',
      },
    ],
  },
];

const FACTS: Card[] = [
  {
    t: 'SERVER-RENDERED',
    b: 'Every screen is HTML on arrival — no client framework, no build step, no loading spinners. Small vanilla-JS islands add interaction where it earns its keep.',
  },
  {
    t: 'EDGE-CACHED',
    b: 'Public pages are served from Cloudflare’s CDN, keyed to your publish revision — so publishing invalidates every cached view instantly.',
  },
  {
    t: 'DELIBERATELY SMALL',
    b: 'No CRM, no marketing suite, no media library. The features that make software slow live on a permanent cut list — and the tables stay smooth at a thousand submissions.',
  },
];

/* ------------------------------------------------------------------- page */

const CSS = `
  html,body{margin:0;padding:0;background:#faf8f5;color:#1a1a2e;font-family:'Space Grotesk',sans-serif;}
  a{color:#4c5fd5;text-decoration:none;} a:hover{color:#3a4ab8;text-decoration:underline;}
  *{box-sizing:border-box;} input,textarea,select,button{font-family:inherit;}
  .wrap{max-width:1040px;margin:0 auto;padding-left:24px;padding-right:24px;}
  .phase{display:grid;grid-template-columns:300px 1fr;gap:36px;padding:48px 0;border-top:1px solid #ece7de;}
  .cards{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-content:start;}
  .facts{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;}
  @media(max-width:880px){.phase{grid-template-columns:1fr;gap:22px;padding:36px 0;}}
  @media(max-width:720px){.facts{grid-template-columns:1fr;}}
  @media(max-width:560px){.cards{grid-template-columns:1fr;}}
`;

const SANDBOX_BTN =
  'padding:12px 20px;background:#4c5fd5;color:#fff;border:none;font-size:14px;font-weight:600;cursor:pointer;';

function SandboxForm() {
  return (
    <form method="post" action="/sandbox" style="margin:0;">
      <button type="submit" style={SANDBOX_BTN}>
        Try the sandbox →
      </button>
    </form>
  );
}

app.get('/', (c) => {
  const signedIn = !!c.var.user;
  return c.html(
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Unsession — run your call for speakers without the bloat</title>
        <meta
          name="description"
          content="Open-source speaker and session management for conferences: call for speakers, evaluation, decisions, speaker onboarding, agenda, publish. Fast, focused, self-hostable."
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href={GOOGLE_FONTS} rel="stylesheet" />
        <style>{raw(CSS)}</style>
      </head>
      <body>
        {/* ------------------------------------------------------- header */}
        <div style="border-bottom:1px solid #ece7de;background:#faf8f5;">
          <div class="wrap" style="padding-top:14px;padding-bottom:14px;display:flex;align-items:center;gap:10px;">
            <div style={`width:26px;height:26px;background:#4c5fd5;color:#fff;display:grid;place-items:center;font-family:${MONO};font-size:12px;font-weight:600;`}>
              U
            </div>
            <div style="font-weight:700;font-size:15px;letter-spacing:-0.01em;">Unsession</div>
            <div style="margin-left:auto;display:flex;gap:18px;font-size:13px;">
              <a href={GITHUB}>Source</a>
              <a href={signedIn ? '/app' : '/signin'}>{signedIn ? 'Open workspace →' : 'Sign in →'}</a>
            </div>
          </div>
        </div>

        {/* --------------------------------------------------------- hero */}
        <div class="wrap" style="padding-top:76px;padding-bottom:56px;">
          <div style={`font-family:${MONO};font-size:10.5px;letter-spacing:0.14em;color:#4c5fd5;margin-bottom:12px;`}>
            OPEN-SOURCE SPEAKER & SESSION MANAGEMENT
          </div>
          <h1 style="margin:0 0 14px;font-size:clamp(32px,6.5vw,46px);line-height:1.08;letter-spacing:-0.03em;max-width:16ch;">
            Run your call for speakers without the bloat
          </h1>
          <p style="margin:0 0 30px;font-size:16.5px;line-height:1.55;color:#555a63;max-width:62ch;">
            Unsession is the whole speaker pipeline — call for speakers → evaluation → decisions → speaker
            onboarding → agenda → publish — and deliberately nothing else.
          </p>
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
            <SandboxForm />
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

        {/* --------------------------------------------------- product walk */}
        <div class="wrap" style="padding-bottom:24px;">
          {WALK.map((p) => (
            <div class="phase">
              <div>
                <div style={`font-family:${MONO};font-size:10.5px;letter-spacing:0.14em;color:#4c5fd5;margin-bottom:10px;`}>
                  {p.num} · {p.kicker}
                </div>
                <div style="font-size:23px;font-weight:700;letter-spacing:-0.02em;line-height:1.2;margin-bottom:10px;">
                  {p.title}
                </div>
                <div style="font-size:14px;line-height:1.6;color:#555a63;">{p.lede}</div>
              </div>
              <div class="cards">
                {p.cards.map((card) => (
                  <div style="background:#fff;border:1px solid #ece7de;padding:16px 18px;">
                    <div style="font-size:14.5px;font-weight:700;letter-spacing:-0.01em;margin-bottom:5px;">
                      {card.t}
                    </div>
                    <div style="font-size:13px;line-height:1.55;color:#555a63;">{card.b}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* --------------------------------------------------------- speed */}
        <div style="background:#16171d;color:#fff;">
          <div class="wrap" style="padding-top:56px;padding-bottom:56px;">
            <div style={`font-family:${MONO};font-size:10.5px;letter-spacing:0.14em;color:#8f9bff;margin-bottom:12px;`}>
              THE BET
            </div>
            <div style="font-size:30px;font-weight:700;letter-spacing:-0.02em;margin-bottom:14px;">
              Fast is the feature.
            </div>
            <p style="margin:0 0 36px;font-size:15px;line-height:1.6;color:#b9bcc6;max-width:66ch;">
              Speed here isn’t an optimization pass — it’s the architecture. Pages are server-rendered HTML
              from Cloudflare’s edge, the public agenda is CDN-cached and invalidated the instant you publish,
              and the review queues are built to stay smooth at a thousand submissions.
            </p>
            <div class="facts">
              {FACTS.map((f) => (
                <div style="border-top:1px solid #2c2d36;padding-top:16px;">
                  <div style={`font-family:${MONO};font-size:10px;letter-spacing:0.14em;color:#83858f;margin-bottom:8px;`}>
                    {f.t}
                  </div>
                  <div style="font-size:13.5px;line-height:1.6;color:#c9cbd4;">{f.b}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* --------------------------------------------------- open source */}
        <div class="wrap" style="padding-top:56px;padding-bottom:56px;">
          <div style={`font-family:${MONO};font-size:10.5px;letter-spacing:0.14em;color:#4c5fd5;margin-bottom:12px;`}>
            OPEN SOURCE
          </div>
          <div style="font-size:26px;font-weight:700;letter-spacing:-0.02em;margin-bottom:12px;">
            AGPL-3.0, and yours to run
          </div>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#555a63;max-width:66ch;">
            Unsession is open source under the AGPL-3.0 license. It’s one Cloudflare Worker — Hono JSX server
            rendering, D1 for the database, R2 for files — so self-hosting is a few wrangler commands on your own
            Cloudflare account. And the hosted service at unsession.dev runs exactly this code: same repo, no
            enterprise fork, no held-back features.
          </p>
          <a href={GITHUB} style="font-size:14px;font-weight:600;">
            Read the source on GitHub →
          </a>
        </div>

        {/* --------------------------------------------------- closing CTA */}
        <div style="border-top:1px solid #ece7de;background:#fff;">
          <div class="wrap" style="padding-top:52px;padding-bottom:52px;">
            <div style="font-size:23px;font-weight:700;letter-spacing:-0.02em;margin-bottom:10px;">
              See it in thirty seconds
            </div>
            <p style="margin:0 0 22px;font-size:14.5px;line-height:1.6;color:#555a63;max-width:60ch;">
              The sandbox is a real event mid-lifecycle — submissions in review, an agenda half-built, a speaker
              mid-onboarding. Pick a seat: organizer, speaker, or evaluator.
            </p>
            <SandboxForm />
          </div>
        </div>

        {/* -------------------------------------------------------- footer */}
        <div style="border-top:1px solid #ece7de;">
          <div
            class="wrap"
            style={`padding-top:18px;padding-bottom:18px;display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;font-family:${MONO};font-size:10.5px;letter-spacing:0.12em;color:#8b857a;`}
          >
            <span>UNSESSION</span>
            <span style="margin-left:auto;display:flex;gap:16px;">
              <a href={GITHUB} style="color:#8b857a;">
                SOURCE
              </a>
              <span>AGPL-3.0</span>
            </span>
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
