# Unsession

**Run your call for speakers without the bloat.**

Unsession is open-source speaker & session management for conferences. It covers the whole speaker pipeline — call for speakers → evaluation → decisions → speaker onboarding → agenda → publish — and deliberately nothing else: no CRM, no marketing suite, no media library. It ships as a single Cloudflare Worker with server-rendered pages and no client build step, built on three bets: speed, focus, and instant self-serve — the [sandbox](https://unsession.dev) provisions a real, pre-filled event in seconds, no account needed.

- **Hosted service:** https://unsession.dev — runs this repo unmodified (admin at `/app`)
- **License:** [AGPL-3.0](LICENSE)

## Features

- **CFP forms** — form builder with fixed core fields (title, abstract, format, per-speaker name/email/bio/headshot) plus custom fields: word-limited text with live counters, selects bound to event taxonomies, URLs, file uploads. Conditional show/hide logic, drafts with autosave and emailed draft links, co-speakers, multiple forms per event, themed mobile-first public forms.
- **Evaluation** — evaluation plans scoped to a slice of submissions, reviewer rosters, 1–5 rubric criteria, anonymized (blind) review, keyboard-driven scoring, reviewer progress tracking.
- **Decisions** — accept / decline / waitlist individually or in bulk; templated decision emails that always go through preview + confirm; CSV import, CSV/XLSX export.
- **Speaker onboarding** — magic-link speaker portal (submissions, statuses, tasks, profile), explicit participation confirmation that can gate public agenda display, task templates (checkbox / file request / form / profile), file uploads to R2, ICS calendar invites with proper updates on reschedule, per-submission activity log.
- **Agenda & publishing** — drag-and-drop agenda builder with conflict detection (double-booked rooms, a speaker in two places at once), themed public agenda and speaker directory with a WCAG-checked palette derived from one brand color, embeddable agenda/speaker widgets, edge-cached public pages invalidated on publish.
- **API & MCP** — bearer-token REST API (`/api/v1/*`) and an MCP server (`POST /api/mcp`) over the same operations; tokens are created in the admin, scoped read-only or read-write, optionally restricted to one event.

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
- `vars.APP_ORIGIN` — the origin your worker is reachable on; used for absolute URLs in emails and magic links.
- `vars.EMAIL_FROM` / `vars.EMAIL_ENABLED` — see below.

**Email sending** uses [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) through the `send_email` binding (`EMAIL`). Onboard your sending domain to Email Service, set `EMAIL_FROM` to an address on it, and set `EMAIL_ENABLED` to `"1"`. Until then, remove the `send_email` block and set `EMAIL_ENABLED` to `"0"` — every send is recorded as `simulated`, and flows that depend on a link (sign-in, invites, confirmations) surface the link in the UI instead.

**Google sign-in (optional):** set the `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` secrets (`npx wrangler secret put …`); the sign-in button appears automatically when both exist. Email magic links work without it.

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
