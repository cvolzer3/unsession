/**
 * Unsession — worker entry point.
 *
 * Route order matters: the public event surfaces (`/:event/...`) are the
 * catch-all and must be registered last. Static assets are served by the
 * ASSETS binding before the worker runs.
 */
import { Hono } from 'hono';
import type { Ctx } from './types';
import { getSession, requireUser } from './lib/auth';
import { runScheduledJobs } from './lib/jobs';
import { ProductLogo } from './views/brand';
import { Favicons } from './views/meta';

import api from './routes/api';
import mcp from './routes/mcp';
import oauth from './routes/oauth';
import landing from './routes/landing';
import docs from './routes/docs';
import auth from './routes/auth';
import sandbox from './routes/sandbox';
import confirm from './routes/confirm';
import files from './routes/files';
import adminDashboard from './routes/admin-dashboard';
import adminEvents from './routes/admin-events';
import adminSetup from './routes/admin-setup';
import adminTeam from './routes/admin-team';
import adminEmails from './routes/admin-emails';
import adminApi from './routes/admin-api';
import adminSubmissions from './routes/admin-submissions';
import adminForms from './routes/admin-forms';
import adminEvaluation from './routes/admin-evaluation';
import adminSessions from './routes/admin-sessions';
import adminSpeakers from './routes/admin-speakers';
import adminFiles from './routes/admin-files';
import adminAgenda from './routes/admin-agenda';
import adminEmbeds from './routes/admin-embeds';
import adminOrgDirectory from './routes/admin-org-directory';
import adminOrgContact from './routes/admin-org-contact';
import adminOrgPipeline from './routes/admin-org-pipeline';
import publicAgenda from './routes/public-agenda';
import publicEmbed from './routes/public-embed';
import publicWidgets from './routes/public-widgets';
import publicPortal from './routes/public-portal';
import publicEvaluate from './routes/public-evaluate';
import publicSpeaker from './routes/public-speaker';
import publicForm from './routes/public-form';

const app = new Hono<Ctx>();

// Public API + MCP (Bearer tokens, spec C) — registered BEFORE the session
// middleware so /api/* never touches cookie auth, and before the /:event
// catch-alls so `api` can never be read as an event slug.
app.route('/', api);
app.route('/', mcp);

app.use('*', getSession);
app.use('/app', requireUser);
app.use('/app/*', requireUser);

app.get('/healthz', (c) => c.json({ ok: true, service: 'unsession' }));

// Landing + docs + auth. `docs` claims /docs and /mcp before the /:event
// catch-alls, so those two slugs are effectively reserved — `oauth` likewise
// reserves /oauth and /.well-known (OAuth 2.1 + DCR for MCP clients; its
// /oauth/authorize consent page needs the session middleware above).
app.route('/', landing);
app.route('/', docs);
app.route('/', auth);
app.route('/', oauth);
app.route('/', sandbox);
app.route('/', confirm);
app.route('/', files);

// Admin (indigo, never themed)
app.route('/', adminDashboard);
app.route('/', adminEvents);
app.route('/', adminSetup);
app.route('/', adminTeam);
app.route('/', adminEmails);
app.route('/', adminApi);
app.route('/', adminSubmissions);
app.route('/', adminForms);
app.route('/', adminEvaluation);
app.route('/', adminSessions);
app.route('/', adminSpeakers);
app.route('/', adminFiles);
app.route('/', adminAgenda);
app.route('/', adminEmbeds);
app.route('/', adminOrgDirectory);
app.route('/', adminOrgContact);
app.route('/', adminOrgPipeline);

// Public, event-themed surfaces — order-sensitive, `/:event/:form` last.
app.route('/', publicPortal);
app.route('/', publicEvaluate);
app.route('/', publicSpeaker);
app.route('/', publicEmbed);
app.route('/', publicWidgets);
app.route('/', publicAgenda);
app.route('/', publicForm);

app.notFound((c) =>
  c.html(
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Unsession — not found</title>
        <Favicons />
      </head>
      <body style="margin:0;background:#f4f4f6;color:#16171d;font-family:system-ui,sans-serif;">
        <div style="min-height:100vh;display:grid;place-items:center;">
          <div style="text-align:center;">
            <a href="/" aria-label="Unsession home" style="display:flex;justify-content:center;margin-bottom:28px;">
              <ProductLogo height={24} />
            </a>
            <div style="font-family:ui-monospace,monospace;font-size:11px;letter-spacing:0.14em;color:#9a9da6;">404</div>
            <div style="font-size:18px;font-weight:700;margin-top:6px;">Nothing here</div>
            <div style="margin-top:10px;font-size:13px;">
              <a href="/" style="color:#4c5fd5;">Back to Unsession</a>
            </div>
          </div>
        </div>
      </body>
    </html>,
    404
  )
);

app.onError((err, c) => {
  console.error('[unsession]', err);
  return c.text('Something went wrong', 500);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Ctx['Bindings'], ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledJobs(env, event));
  },
};
