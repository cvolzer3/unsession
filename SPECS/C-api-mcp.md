# C — Public API + MCP Server (B12 / R10)

**Decision basis:** DECISIONS.md review round R10 — full implementation (read *and*
write), token auth, MCP server wrapping the API. "JSON API + CSV are the
integration story" (spec §6); the MCP server is that story extended for agents.

## Principles

- Zero new npm dependencies. The MCP server speaks Streamable HTTP (stateless
  JSON-RPC 2.0 over POST) implemented directly in Hono — no SDK, no Durable
  Objects. Stateless is explicitly allowed by the MCP spec and is what
  Claude Code / claude.ai custom connectors consume.
- The API is a thin layer over the same lib functions the admin UI uses —
  decisions, sessions, tasks all reuse existing engines so invariants
  (Session ≠ Submission, confirmation gating, activity logging) hold for free.
- Every write lands in the activity log with actor `api:<token name>`.

## Tokens

Table `api_tokens` (migration `0010_api_tokens.sql`):

```
id TEXT PK · org_id TEXT NOT NULL REFERENCES orgs(id) · name TEXT NOT NULL
token_hash TEXT NOT NULL (SHA-256 of the secret)
scopes TEXT NOT NULL ('read' | 'read,write')
event_id TEXT NULL REFERENCES events(id)  -- NULL = whole org
created_by TEXT NOT NULL · created_at TEXT NOT NULL
last_used_at TEXT NULL · revoked_at TEXT NULL
```

- Secret format `uns_<40 base36 chars>`, shown **once** at creation.
- Sandbox orgs cannot create tokens (`is_sandbox = 1` → 403) — sandboxes are
  throwaway and personas are shared.
- Management UI: `/app/api` (new admin page, sidebar WORKSPACE section, label
  "API"). Owner/admin only. List (name, scope, event, created, last used),
  create dialog (name, scope, optional event restriction), revoke. Shows the
  secret in a copy-once panel after creation. Page footer documents the base
  URL and links the MCP endpoint.

Auth middleware: `Authorization: Bearer uns_…` → hash lookup → attaches
`{ org, scopes, eventId? }` to context; bumps `last_used_at` (fire-and-forget).
401 unknown/revoked; 403 scope/event mismatch.

## REST surface — `/api/v1`

All responses `{ ok: true, data: … }` or `{ ok: false, error: string }` with
proper status codes. Event-scoped routes 404 outside the token's event
restriction. List endpoints accept `?limit=` (default 100, max 500) and
`?cursor=` (opaque keyset cursor) where noted.

Read (scope `read`):

| Route | Returns |
|---|---|
| `GET /api/v1/events` | events of the org (id, name, slug, dates, timezone, venue, published) |
| `GET /api/v1/events/:event` | one event + rooms + taxonomies/options |
| `GET /api/v1/events/:event/forms` | forms (id, name, slug, status, opens/closes, public URL) |
| `GET /api/v1/events/:event/submissions` | filters: `status`, `form`, `track`, `q`; cursor-paginated; answers keyed by field label + id |
| `GET /api/v1/submissions/:id` | full submission: answers, speakers, status, scores summary, activity tail |
| `GET /api/v1/events/:event/sessions` | sessions incl. schedule (day/start/end/room), type, publish flag |
| `GET /api/v1/sessions/:id` | one session |
| `GET /api/v1/events/:event/speakers` | speaker profiles (name, email, bio, pronouns, links, headshot URL) + task progress counts |
| `GET /api/v1/events/:event/agenda` | the published agenda (same shape as `/{slug}/agenda.json`) |
| `GET /api/v1/events/:event/tasks` | task instances w/ status, due, speaker/session target |

Write (scope `write`):

| Route | Action |
|---|---|
| `POST /api/v1/events/:event/submissions` | create a submission on a form (organizer-on-behalf semantics; body: formId, title, abstract, speakers[], answers{}) — reuses the CSV-import creation path |
| `PATCH /api/v1/submissions/:id` | update answers/title/abstract (activity-logged) |
| `POST /api/v1/submissions/:id/decision` | `{ decision: accept\|decline\|waitlist, sendEmail: bool (default true), templateId?, feedback? }` — runs the real decision engine (session creation, confirmation token, emails unless suppressed) |
| `POST /api/v1/events/:event/sessions` | create sponsor/service session (same rules as the New Session dialog) |
| `PATCH /api/v1/sessions/:id` | edit fields; `{ day, startMin, roomId }` schedules; nulls unschedule; `published` toggles |
| `PATCH /api/v1/speakers/:id` | update profile fields (name, bio, pronouns, links) |
| `POST /api/v1/tasks` | assign a template or one-off task to a speaker/session (honest skip semantics, same as bulk assign) |
| `POST /api/v1/tasks/:id/complete` | organizer override complete (logged) |

Deliberately **not** in v1: form/schema editing (versioning semantics deserve
their own design), event creation, team management, email template CRUD.
Documented in the page footer as out of scope.

## MCP server — `POST /api/mcp`

Same Bearer auth. Stateless Streamable HTTP:

- `initialize` → protocol version echo (support `2025-03-26` and
  `2025-06-18`), `capabilities: { tools: {} }`, serverInfo
  `unsession/<version>`.
- `notifications/initialized` → 202, empty body.
- `tools/list` → tools below; write tools omitted for read-only tokens.
- `tools/call` → dispatches to the same lib layer as REST; results as
  `content: [{ type: 'text', text: JSON.stringify(data) }]`; errors as
  `isError: true` tool results (JSON-RPC errors only for protocol problems).
- GET/DELETE on the endpoint → 405 (no SSE stream, no sessions).

Tools (1:1 with the API): `list_events`, `get_event`, `list_forms`,
`list_submissions`, `get_submission`, `list_sessions`, `get_session`,
`list_speakers`, `get_agenda`, `list_tasks` · write: `create_submission`,
`update_submission`, `decide_submission`, `create_session`, `update_session`,
`schedule_session`, `update_speaker`, `assign_task`, `complete_task`.
Every tool takes `event` (slug or id) where relevant; descriptions written for
agent consumption (state effects, side effects like "sends the decision email
unless sendEmail=false").

## Files

- `migrations/0010_api_tokens.sql`
- `src/lib/api-tokens.ts` — mint/hash/verify/middleware
- `src/routes/api.tsx` — REST router (`/api/v1/*`)
- `src/routes/mcp.ts` — MCP endpoint (`/api/mcp`)
- `src/routes/admin-api.tsx` — token management UI (`/app/api`)
- `src/index.tsx` — registration (API routes bypass session auth; mounted
  before the `/:event` catch-alls)
- `src/views/layout.tsx` — sidebar link (WORKSPACE → "API")
