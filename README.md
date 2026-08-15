<p align="center">
  <img src="public/brand/unsession-readme.png" alt="Unsession" width="600">
</p>

<p align="center"><strong>From open call to opening keynote.</strong></p>

Unsession runs the whole speaker side of your event: proposals in, fair reviews, confident decisions, speakers who show up ready, and an agenda you can publish and trust. It is open-source speaker & session management for conferences. The pipeline is

<p align="center"><code>COLLECT → EVALUATE → DECIDE → ONBOARD → SCHEDULE → PUBLISH</code></p>

and deliberately nothing else: no CRM, no marketing suite, no media library. It ships as a single Cloudflare Worker with server-rendered pages and no client build step.

The [sandbox](https://unsession.dev) is a live event mid-lifecycle: submissions in review, an agenda half-built, a speaker mid-onboarding. Pick a seat: organizer, speaker, or evaluator. No signup, no demo call, no credit card.

- **Hosted service:** https://unsession.dev — runs this repo unmodified (admin at `/app`)
- **Keyboard:** in the admin, `⌘K` (`Ctrl+K`) opens the command palette to jump to any page; `⌘L` jumps to one of the last three submissions.
- **License:** [AGPL-3.0](LICENSE)

## Unsession MCP: Your AI agent can work the CFP with you

Unsession ships an MCP server at parity with the admin UI: anything an organizer can do in the app, an agent can do over MCP. Claude Code, Claude, Cursor, and anything else that speaks MCP can read the submission queue, build forms, run evaluation plans and record scores, queue decisions and send the outbox, review uploaded slides and reply with feedback, schedule and publish the agenda, create embeds, work the speaker CRM and pipeline, and invite teammates. Same engines, same permissions, same activity log as the admin UI. There is also a bearer-token REST API (`/api/v1/*`) over the same operations. Full guide, tool reference and per-client snippets: **[unsession.dev/docs/mcp](https://unsession.dev/docs/mcp)**.

| | |
|---|---|
| **Endpoint** | `POST https://unsession.dev/api/mcp` (self-hosted: `https://<your-domain>/api/mcp`) |
| **Transport** | Streamable HTTP — stateless JSON-RPC 2.0 over POST. No SSE, no sessions, no SDK, no Durable Objects. |
| **Auth** | OAuth (add the URL, sign in) or a static token: `Authorization: Bearer uns_…`, minted at `/app/api` |
| **Tools** | 84 — 32 read, 52 write. Write tools are omitted from `tools/list` for read-only tokens; org-level tools (CRM, pipeline, team) need an org-wide token. |

**1. Connect with OAuth, or mint a token.** Clients that speak OAuth — the Claude apps, VS Code, Cursor — need only the endpoint URL: add it, sign in, and pick a workspace and a scope on the consent page. The server supports dynamic client registration, so there is nothing to configure first. For header-based clients, mint a token instead: sign in → **Workspace → API** (`/app/api`) → **New token**. Choose read-only or read-write, optionally restrict it to one event, and copy the secret — it is shown once. (Sandbox workspaces can't create tokens or approve OAuth connections.)

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

Cursor (`.cursor/mcp.json`) uses the same shape without `type`; VS Code (`.vscode/mcp.json`) nests servers under `servers` and takes the token from an `inputs` prompt. Both also accept the bare URL and connect through OAuth, as do the Claude apps in the custom-connector dialog. Any client that speaks remote HTTP MCP with OAuth or a custom header works — verify a token with:

```sh
curl -s https://unsession.dev/api/mcp \
  -H "Authorization: Bearer uns_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**3. Hosting it yourself.** The MCP endpoint is part of the worker — deploy per [Self-hosting](#self-hosting) below and it is live at `/api/mcp` on your origin, with nothing extra to enable or run. OAuth runs on your origin too, and tokens are minted on your own instance at `/app/api`; hosted-service credentials don't work against it.

Every write lands in the activity log as `api:<token name>`. Tools that send email say so in their descriptions — `decide_submission` (suppressible with `sendEmail: false`), `send_outbox`, `update_session`/`schedule_session` when a confirmed session moves, `assign_task`, `save_evaluation_plan`, `remind_evaluators`, `review_task` (request-changes), `email_speaker`, `email_contacts`, `invite_teammate` — and the rest are silent. Decisions come in two speeds: `queue_decision` + `send_outbox` is the admin UI's reviewable two-phase flow, while `decide_submission` applies immediately; give an agent a read-only token if you want recommendations without sends. Implementation: [`src/routes/mcp.ts`](src/routes/mcp.ts) plus the `src/routes/api-*.ts` domain modules, spec: [`SPECS/C-api-mcp.md`](SPECS/C-api-mcp.md).

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

[AGPL-3.0](LICENSE). Run it, change it, ship it — and if you offer a modified version to others over a network, share your changes. The hosted service at https://unsession.dev runs this repository unmodified.

<p align="center">
  <img src="public/brand/unsession-watermark.png" alt="" width="420">
</p>
