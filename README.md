<p align="center">
  <img src="public/brand/unsession-readme.png" alt="Unsession" width="600">
</p>

<p align="center"><strong>From open call to opening keynote.</strong></p>

Unsession runs the whole speaker side of your event: proposals in, fair reviews, confident decisions, speakers who show up ready, and an agenda you can publish and trust. It is open-source speaker & session management for conferences — the pipeline is

<p align="center"><code>COLLECT → EVALUATE → DECIDE → ONBOARD → SCHEDULE → PUBLISH</code></p>

and deliberately nothing else: no CRM, no marketing suite, no media library. It ships as a single Cloudflare Worker with server-rendered pages and no client build step.

The [sandbox](https://unsession.dev) is a live event mid-lifecycle — submissions in review, an agenda half-built, a speaker mid-onboarding. Pick a seat: organizer, speaker, or evaluator. No signup, no demo call, no credit card.

- **Hosted service:** https://unsession.dev — runs this repo unmodified (admin at `/app`)
- **License:** [AGPL-3.0](LICENSE)

## How it works

### 01 · Collect — a call for speakers people actually finish

Every abandoned draft is a talk you never got to consider. Unsession's forms are easy to start, hard to lose, and painless on a phone.

- **Drafts survive anything.** Autosaved from the first keystroke, resumable on any device via an emailed draft link.
- **Ask only what's relevant.** Conditional show/hide logic — a workshop pitch and a lightning talk each see their own questions.
- **Your brand, your questions.** A form builder with fixed core fields (title, abstract, format, per-speaker name/email/bio/headshot) plus custom fields: word-limited text with live counters, selects bound to event taxonomies, URLs, file uploads. Co-speakers, multiple forms per event, themed mobile-first public forms.

### 02 · Decide — fair decisions, made in an evening

Give every proposal the same fair read, see the results ranked, and send decisions knowing exactly what each speaker will receive.

- **Talks win on merit.** Blind review hides names and bios in one toggle, so the work gets judged, not the byline.
- **Your committee flies through the queue.** Evaluation plans scoped to a slice of submissions, reviewer rosters, 1–5 rubric criteria, keyboard-driven scoring, reviewer progress tracking.
- **No decision leaves unchecked.** Accept / decline / waitlist individually or in bulk; templated decision emails always go through preview + confirm. CSV import, CSV/XLSX export.

### 03 · Onboard — speakers arrive ready, without the chasing

The weeks between "accepted" and stage day are where events go sideways. Give each speaker one link and a clear checklist, and get out of the reminder-email business.

- **One portal, one checklist.** Speakers sign in to see their submissions, statuses, tasks, and profile — and an explicit participation confirmation can gate public agenda display.
- **Slides, headshots, A/V needs.** Task templates (checkbox / file request / form / profile) with due dates; files land in your storage instead of your inbox.
- **Schedule changes that stick.** ICS calendar invites update themselves when a session moves, and every submission keeps its own activity log.

### 04 · Publish — an agenda you can stand behind on stage day

Build the schedule by dragging sessions into place, and catch double-booked rooms and speakers before your attendees do.

- **Conflicts surface instantly.** Double-booked rooms and a speaker in two places flag themselves while you're still dragging.
- **Looks like your event.** One brand color becomes a polished public agenda and speaker directory with a WCAG-checked palette.
- **Everywhere at once.** Embeddable agenda/speaker widgets and edge-cached public pages, invalidated on publish.

Underneath all four: nothing falls through the cracks. The whole pipeline lives in one place — not spread across a form tool, a spreadsheet, and someone's inbox — and every decision, email, task, and schedule change is logged per submission, so "did we tell them?" is always one click away.

## Your AI agent can work the CFP with you

Unsession ships a [Model Context Protocol](https://modelcontextprotocol.io) server, so Claude Code, Claude, Cursor — anything that speaks MCP — can read your submission queue, pull evaluation scores, accept a talk, add a sponsor session, or move something on the agenda. Same engines, same permissions, same activity log as the admin UI. There is also a bearer-token REST API (`/api/v1/*`) over the same operations. Full guide, tool reference and per-client snippets: **[unsession.dev/docs/mcp](https://unsession.dev/docs/mcp)**.

| | |
|---|---|
| **Endpoint** | `POST https://unsession.dev/api/mcp` (self-hosted: `https://<your-domain>/api/mcp`) |
| **Transport** | Streamable HTTP — stateless JSON-RPC 2.0 over POST. No SSE, no sessions, no SDK, no Durable Objects. |
| **Auth** | `Authorization: Bearer uns_…` — the same tokens as the REST API, minted at `/app/api` |
| **Tools** | 19 — 10 read, 9 write. Write tools are omitted from `tools/list` for read-only tokens. |

**1. Mint a token.** Sign in → **Workspace → API** (`/app/api`) → **New token**. Choose read-only or read-write — an agent you trust to answer questions isn't the one you trust to send decisions, and read-only tokens can't even see the write tools. Optionally restrict it to one event, and copy the secret — it is shown once. (Sandbox workspaces can't create tokens.)

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

Every write is on the record: it lands in the activity log as `api:<token name>`, so "who moved this session?" answers the same for an agent as for a person. Three tools send email — `decide_submission` (suppressible with `sendEmail: false`), `update_session`/`schedule_session` when a confirmed session moves, and `assign_task` — and the rest are silent. Note that `decide_submission` applies a decision immediately rather than queueing it for the Emails → Outbox review the admin UI uses; give an agent a read-only token if you want recommendations without sends. Implementation: [`src/routes/mcp.ts`](src/routes/mcp.ts), spec: [`SPECS/C-api-mcp.md`](SPECS/C-api-mcp.md).

## Stack

Cloudflare Workers · [Hono](https://hono.dev) JSX server rendering (TypeScript) · D1 (SQLite) · R2 · Cloudflare Email Service.

There is **no client build step**: pages are server-rendered HTML, and interactivity comes from small vanilla-JS islands under `public/js/`. `hono` is the only runtime dependency.

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
- [`public/brand/`](public/brand/) — logo, mark, and watermark assets + usage notes

## License

[AGPL-3.0](LICENSE). Run it, change it, ship it — and if you offer a modified version to others over a network, share your changes. The hosted service at https://unsession.dev runs this repository unmodified — open source isn't a tier, it's the product.

<p align="center">
  <img src="public/brand/unsession-watermark.png" alt="" width="420">
</p>
