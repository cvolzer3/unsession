# Unsession

**Run your call for speakers without the bloat.**

Unsession is open-source speaker & session management for conferences. It covers the whole speaker pipeline — call for speakers → evaluation → decisions → speaker onboarding → agenda → publish — and deliberately nothing else: no CRM, no marketing suite, no media library. It ships as a single Cloudflare Worker with server-rendered pages and no client build step, built on three bets: speed, focus, and instant self-serve. The [sandbox](https://unsession.dev) provisions a real, pre-filled event in seconds, no account needed.

- **Hosted service:** https://unsession.dev — runs this repo unmodified (admin at `/app`)
- **License:** [AGPL-3.0](LICENSE)

## Features

- **CFP forms** — form builder with fixed core fields (title, abstract, format, per-speaker name/email/bio/headshot) plus custom fields: word-limited text with live counters, selects bound to event taxonomies, URLs, file uploads. Conditional show/hide logic, drafts with autosave and emailed draft links, co-speakers, multiple forms per event, themed mobile-first public forms.
- **Evaluation** — evaluation plans scoped to a slice of submissions, reviewer rosters, 1–5 rubric criteria, anonymized (blind) review, keyboard-driven scoring, reviewer progress tracking.
- **Decisions** — accept / decline / waitlist individually or in bulk; templated decision emails that always go through preview + confirm; CSV import, CSV/XLSX export.
- **Speaker onboarding** — speaker portal with email + password sign-in (submissions, statuses, tasks, profile), explicit participation confirmation that can gate public agenda display, task templates (checkbox / file request / form / profile), file uploads to R2, ICS calendar invites with proper updates on reschedule, per-submission activity log.
- **Agenda & publishing** — drag-and-drop agenda builder with conflict detection (double-booked rooms, a speaker in two places at once), themed public agenda and speaker directory with a WCAG-checked palette derived from one brand color, embeddable agenda/speaker widgets, edge-cached public pages invalidated on publish.
- **API & MCP** — bearer-token REST API (`/api/v1/*`) and an MCP server (`POST /api/mcp`) over the same operations; tokens are created in the admin, scoped read-only or read-write, optionally restricted to one event. See [MCP server](#mcp-server) below, or the guide at [unsession.dev/docs/mcp](https://unsession.dev/docs/mcp).

## Stack

Cloudflare Workers · [Hono](https://hono.dev) JSX server rendering (TypeScript) · D1 (SQLite) · R2 · Cloudflare Email Service.

There is **no client build step**: pages are server-rendered HTML, and interactivity comes from small vanilla-JS islands under `public/js/`. `hono` is the only runtime dependency.

## MCP server

Unsession exposes its own [Model Context Protocol](https://modelcontextprotocol.io) server, so an AI agent can work the CFP with you — read the submission queue, pull evaluation scores, decide a talk, add a sponsor session, reschedule it, chase a speaker task. Full guide, tool reference and per-client snippets: **[unsession.dev/docs/mcp](https://unsession.dev/docs/mcp)**.

| | |
|---|---|
| **Endpoint** | `POST https://unsession.dev/api/mcp` (self-hosted: `https://<your-domain>/api/mcp`) |
| **Transport** | Streamable HTTP — stateless JSON-RPC 2.0 over POST. No SSE, no sessions, no SDK, no Durable Objects. |
| **Auth** | `Authorization: Bearer uns_…` — the same tokens as the REST API, minted at `/app/api` |
| **Tools** | 19 — 10 read, 9 write. Write tools are omitted from `tools/list` for read-only tokens. |

**1. Mint a token.** Sign in → **Workspace → API** (`/app/api`) → **New token**. Choose read-only or read-write, optionally restrict it to one event, and copy the secret — it is shown once. (Sandbox workspaces can't create tokens.)

**2. Connect your agent.** Claude Code, in one command:

```sh
claude mcp add --transport http unsession https://unsession.dev/api/mcp \
  --header "Authorization: Bearer uns_your_token_here"
```

Or check it into a repo — Claude Code expands `${VAR}` in `url` and `headers`, so this is safe to commit:

```json
{
  "mcpServers": {
    "unsession": {
      "type": "http",
      "url": "https://unsession.dev/api/mcp",
      "headers": { "Authorization": "Bearer ${UNSESSION_TOKEN}" }
    }
  }
}
```

Cursor (`.cursor/mcp.json`) uses the same shape without `type`; VS Code (`.vscode/mcp.json`) nests servers under `servers` and takes the token from an `inputs` prompt; the Claude apps take the URL plus a `Request headers` entry (`authorization` → `Bearer uns_…`) in the custom-connector dialog. Any client that speaks remote HTTP MCP with a custom header works — verify a token with:

```sh
curl -s https://unsession.dev/api/mcp \
  -H "Authorization: Bearer uns_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**3. Hosting it yourself.** The MCP endpoint is part of the worker — deploy per [Self-hosting](#self-hosting) below and it is live at `/api/mcp` on your origin, with nothing extra to enable or run. Mint tokens on your own instance at `/app/api`; hosted-service tokens don't work against it.

Every write lands in the activity log as `api:<token name>`. Three tools send email — `decide_submission` (suppressible with `sendEmail: false`), `update_session`/`schedule_session` when a confirmed session moves, and `assign_task` — and the rest are silent. Note that `decide_submission` applies a decision immediately rather than queueing it for the Emails → Outbox review the admin UI uses; give an agent a read-only token if you want recommendations without sends. Implementation: [`src/routes/mcp.ts`](src/routes/mcp.ts), spec: [`SPECS/C-api-mcp.md`](SPECS/C-api-mcp.md).

## Self-hosting

You need a Cloudflare account and Node 18+ (`wrangler` is a dev dependency).

```sh
git clone https://github.com/cvolzer3/unsession
cd unsession
npm install

# 1. Create the database, then copy its id into wrangler.jsonc (d1_databases[0].database_id)
npx wrangler d1 create unsession-db

# 2. Create the file-storage bucket
npx wrangler r2 bucket create unsession-files

# 3. Apply migrations
npx wrangler d1 migrations apply unsession-db --remote

# 4. Deploy
npx wrangler deploy
```

Then adjust `wrangler.jsonc` for your account:

- `account_id` — your Cloudflare account id.
- `routes` — your custom domains, or delete the block to use the `workers.dev` URL.
- `vars.APP_ORIGIN` — the origin your worker is reachable on; used for absolute URLs in emails and emailed links.
- `vars.EMAIL_FROM` / `vars.EMAIL_ENABLED` — see below.

**Email sending** uses [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) through the `send_email` binding (`EMAIL`). Onboard your sending domain to Email Service, set `EMAIL_FROM` to an address on it, and set `EMAIL_ENABLED` to `"1"`. Until then, remove the `send_email` block and set `EMAIL_ENABLED` to `"0"` — every send is recorded as `simulated`, and flows that depend on a link (password reset, invites, confirmations) surface the link in the UI instead.

**Sign-in** is email + password for everyone. Password-reset/first-time-setup, team-invite, participation-confirmation and draft-resume links go out by email; in simulated-email mode they appear on screen instead.

## Development

```sh
npm install
npm run db:migrate:local   # apply D1 migrations to the local database
npm run dev                # wrangler dev
npm run typecheck          # tsc --noEmit
```

## Docs

- `PLAN.md` — architecture + build plan
- `DECISIONS.md` — product decisions + open questions
- `SPECS/` — per-track build specs
- `prototype/` — hi-fi design reference (the visual source of truth)
- `src/CONVENTIONS.md` — code conventions

## License

[AGPL-3.0](LICENSE). Run it, change it, ship it — and if you offer a modified version to others over a network, share your changes. The hosted service at https://unsession.dev runs this repository unmodified.
