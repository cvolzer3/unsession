# Spec A — Foundation

Implement the Unsession foundation exactly as specified. Read `PLAN.md` and `DECISIONS.md` first. The prototype in `prototype/design_handoff_program/` is the visual source of truth — read `README.md` there, `design/Sign In.dc.html`, `design/Dashboard.dc.html`, `design/Event Setup.dc.html`, and `design/data.js` before writing UI.

## 1. Scaffold

- `package.json` (private), deps: `hono` (latest 4.x), devDeps: `wrangler`, `typescript`, `@cloudflare/workers-types`. Scripts: `dev` (wrangler dev), `deploy` (wrangler deploy), `db:migrate:local`, `db:migrate:remote` (wrangler d1 migrations apply unsession-db [--remote|--local]).
- `wrangler.jsonc`:
  - name `unsession`, `account_id: "9bbf4e4369014eae4329711aced8e0ae"`, main `src/index.tsx`, compatibility_date current.
  - D1 binding `DB` → database name `unsession-db` (create it: `npx wrangler d1 create unsession-db`; put the returned id in config).
  - Assets: `assets { directory: "public", binding: "ASSETS" }`.
  - `send_email: [{ name: "EMAIL" }]` — **commented out** with a note (enable after domain onboarding; code must tolerate `env.EMAIL === undefined`).
  - Cron trigger: `triggers { crons: ["*/15 * * * *"] }`; export a `scheduled` handler that calls a stub `runScheduledJobs()` in `src/lib/jobs.ts` (real logic comes in Phase C — write the shell + a no-op that logs).
  - `vars`: `APP_ORIGIN` = "https://unsession.workers.dev" for now (single source for absolute URLs in emails), `EMAIL_FROM` = "no-reply@unsession.dev", `EMAIL_ENABLED` = "0".
- `tsconfig.json` with `"jsx": "react-jsx", "jsxImportSource": "hono/jsx"`.
- Do NOT deploy with `--remote` migrations until local dev works; then apply remote migrations and `wrangler deploy` (yes, deploy is in scope for this task; verify with curl).

## 2. Database — migrations/0001_init.sql

Use exactly this DDL (SQLite/D1). TEXT ids: app-generated `<prefix>_<random 12 lowercase alnum>` via `newId('usr')` helper in `src/lib/ids.ts`. Timestamps TEXT ISO-8601 UTC (`now()` helper). All `*_json` columns are TEXT holding JSON.

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT,
  google_id TEXT UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE,
  active_event_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE magic_tokens (
  id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,               -- signin | invite | confirm_participation | draft_link
  payload_json TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, is_sandbox INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE org_members (
  org_id TEXT NOT NULL REFERENCES orgs(id), user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,                  -- owner | admin | collaborator
  created_at TEXT NOT NULL, PRIMARY KEY (org_id, user_id)
);
CREATE TABLE invites (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL, invited_by TEXT REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|revoked
  created_at TEXT NOT NULL
);
CREATE TABLE events (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE, start_date TEXT NOT NULL, end_date TEXT NOT NULL, timezone TEXT NOT NULL,
  venue TEXT, mode TEXT NOT NULL DEFAULT 'in_person',   -- in_person | online | hybrid
  description TEXT, theme_json TEXT NOT NULL,           -- {primary, accent, bg, font, logoFileId}
  day_start_min INTEGER NOT NULL DEFAULT 30,            -- minutes from 08:00 grid origin (prototype: 08:30 first slot)
  day_end_min INTEGER NOT NULL DEFAULT 600,             -- 18:00
  published INTEGER NOT NULL DEFAULT 0, hide_unconfirmed INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE rooms (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL,
  capacity INTEGER, priority INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE taxonomies (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL,
  has_color INTEGER NOT NULL DEFAULT 0, has_duration INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE taxonomy_options (
  id TEXT PRIMARY KEY, taxonomy_id TEXT NOT NULL REFERENCES taxonomies(id), name TEXT NOT NULL,
  color TEXT, duration_min INTEGER, position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE forms (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL, slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',                 -- draft | open | closed
  opens_at TEXT, closes_at TEXT, settings_json TEXT NOT NULL, -- {allowDrafts,lateLinkSecret,welcomeMd,coSpeakerCap,postSubmitMsg,notifyEmails[]}
  created_at TEXT NOT NULL, UNIQUE (event_id, slug)
);
CREATE TABLE form_versions (
  id TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES forms(id), version INTEGER NOT NULL,
  schema_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (form_id, version)
);
CREATE TABLE submissions (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), form_id TEXT NOT NULL REFERENCES forms(id),
  form_version_id TEXT REFERENCES form_versions(id),
  seq INTEGER NOT NULL,                                 -- per-event sequence; display id = 'SUB-' + seq
  status TEXT NOT NULL DEFAULT 'draft',                 -- draft|submitted|in_review|accepted|confirmed|declined|waitlisted|withdrawn
  title TEXT NOT NULL DEFAULT '', abstract TEXT NOT NULL DEFAULT '',
  answers_json TEXT NOT NULL DEFAULT '{}',              -- {fieldId: value}
  owner_user_id TEXT REFERENCES users(id), agent_mode INTEGER NOT NULL DEFAULT 0,
  withdraw_reason TEXT, submitted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_submissions_event ON submissions(event_id, status);
CREATE TABLE submission_speakers (
  id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id), position INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '' COLLATE NOCASE, bio TEXT NOT NULL DEFAULT '',
  headshot_file_id TEXT, user_id TEXT REFERENCES users(id)
);
CREATE TABLE files (
  id TEXT PRIMARY KEY, event_id TEXT REFERENCES events(id), kind TEXT NOT NULL, -- headshot|upload|task_file|logo|sample
  subject_type TEXT, subject_id TEXT, r2_key TEXT NOT NULL, filename TEXT NOT NULL,
  size INTEGER NOT NULL, content_type TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  uploaded_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE comments (
  id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id),
  author_user_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE activity (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id),
  subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, actor TEXT NOT NULL, -- user name or 'System'
  action TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_activity_subject ON activity(subject_type, subject_id);
CREATE TABLE eval_plans (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '', deadline TEXT, anonymized INTEGER NOT NULL DEFAULT 1,
  reminders INTEGER NOT NULL DEFAULT 1, reviews_per INTEGER NOT NULL DEFAULT 3,
  rules_json TEXT NOT NULL,                             -- {track:'all'|optId, form:'all'|formId, format:'all'|optId, level:'all'|optId, status:'active'|'all'|<status>}
  criteria_json TEXT NOT NULL,                          -- [{name,hint,scale}]
  automation_json TEXT,                                 -- {on,minLeft,d14,d7,d3,over,cooldown}
  created_at TEXT NOT NULL
);
CREATE TABLE eval_plan_reviewers (
  plan_id TEXT NOT NULL REFERENCES eval_plans(id), user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',                  -- chair | member
  PRIMARY KEY (plan_id, user_id)
);
CREATE TABLE evaluations (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES eval_plans(id),
  submission_id TEXT NOT NULL REFERENCES submissions(id), reviewer_id TEXT NOT NULL REFERENCES users(id),
  scores_json TEXT NOT NULL DEFAULT '{}',               -- {criterionName: 1..5}
  note TEXT NOT NULL DEFAULT '', abstained INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  UNIQUE (plan_id, submission_id, reviewer_id)
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id),
  submission_id TEXT REFERENCES submissions(id), type TEXT NOT NULL DEFAULT 'talk', -- talk|sponsor|service
  title TEXT NOT NULL, abstract TEXT NOT NULL DEFAULT '',
  track_option_id TEXT REFERENCES taxonomy_options(id), format_option_id TEXT REFERENCES taxonomy_options(id),
  level TEXT, duration_min INTEGER NOT NULL DEFAULT 30,
  room_id TEXT REFERENCES rooms(id), all_rooms INTEGER NOT NULL DEFAULT 0,
  day INTEGER, start_min INTEGER, end_min INTEGER,      -- NULL day/start = unscheduled
  status TEXT NOT NULL DEFAULT 'pending',               -- pending | confirmed
  published INTEGER NOT NULL DEFAULT 1, sponsor_name TEXT, stream_url TEXT,
  visibility_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_event ON sessions(event_id, day);
CREATE TABLE session_speakers (
  session_id TEXT NOT NULL REFERENCES sessions(id), speaker_profile_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session_id, speaker_profile_id)
);
CREATE TABLE speaker_profiles (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), user_id TEXT REFERENCES users(id),
  email TEXT NOT NULL COLLATE NOCASE, name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '',
  headshot_file_id TEXT, slug TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (event_id, email), UNIQUE (event_id, slug)
);
CREATE TABLE task_templates (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, -- checkbox|file|form|profile
  target TEXT NOT NULL DEFAULT 'speaker',               -- speaker | session
  settings_json TEXT NOT NULL DEFAULT '{}',             -- {link,ext,capMb,maxFiles,sampleFileId,review,formSpec}
  required INTEGER NOT NULL DEFAULT 0, lock_on_complete INTEGER NOT NULL DEFAULT 0,
  due_json TEXT NOT NULL,                               -- {mode:'after'|'before'|'abs', n, date}
  grace_json TEXT,                                      -- {mode:'none'|'lock', days}
  trigger TEXT NOT NULL DEFAULT 'confirmation',         -- confirmation | acceptance | manual
  clauses_json TEXT NOT NULL DEFAULT '[]',              -- [{field:'Track'|'Format'|'Level'|'Form answer', value}]
  reminders_json TEXT NOT NULL,                         -- {on, days:[7,2], subject, body}
  archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id),
  template_id TEXT REFERENCES task_templates(id),       -- NULL = one-off
  one_off_json TEXT,                                    -- {name,type,due}
  target_type TEXT NOT NULL,                            -- speaker | session
  speaker_profile_id TEXT REFERENCES speaker_profiles(id), session_id TEXT REFERENCES sessions(id),
  status TEXT NOT NULL DEFAULT 'open',                  -- open | pending_review | done
  due_date TEXT, completed_by TEXT, completed_at TEXT, review_note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE email_templates (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), key TEXT NOT NULL, -- accept|decline|waitlist|reminder|task_nag|schedule_notice|confirm_submission
  name TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (event_id, key)
);
CREATE TABLE emails (
  id TEXT PRIMARY KEY, event_id TEXT REFERENCES events(id), to_email TEXT NOT NULL,
  to_name TEXT, template_key TEXT, subject TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL,                                 -- queued | sent | failed | simulated
  error TEXT, subject_type TEXT, subject_id TEXT, created_at TEXT NOT NULL, sent_at TEXT
);
CREATE TABLE counters (event_id TEXT NOT NULL, key TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (event_id, key));
```

## 3. Core libraries (`src/lib/`)

- `db.ts` — tiny typed query helpers over `env.DB` (`one`, `all`, `run`), `now()`, JSON parse helpers.
- `ids.ts` — `newId(prefix)`; `nextSeq(db, eventId, key)` using `counters` (INSERT ON CONFLICT UPDATE RETURNING).
- `auth.ts` —
  - `hashToken(t)` = SHA-256 hex via WebCrypto. Raw tokens: 32 bytes base64url from `crypto.getRandomValues`.
  - `requestMagicLink(env, email, purpose, payload)`: create magic_tokens row (30-min expiry), send email with `${APP_ORIGIN}/auth/verify?token=…`. Returns `{simulatedLink?}` when email is simulated so callers can surface it.
  - `verifyMagicToken` (single-use, marks used_at), creates user if missing (email → user), creates auth session (cookie `us_sess`, HttpOnly, Secure, SameSite=Lax, 30-day, store hash).
  - `getSession(c)` middleware → `c.var.user`, `c.var.session`; `requireUser`, `requireOrgRole(role)`.
  - Google OAuth: `/auth/google` redirect (only if `GOOGLE_CLIENT_ID` secret set — otherwise signin page hides the button), `/auth/google/callback` exchanges code, links by email, creates session. Standard endpoints, `openid email profile` scope.
- `email.ts` — `sendEmail(c.env, {eventId?, to, toName?, templateKey?, subject, text, subjectType?, subjectId?})`: inserts `emails` row; if `env.EMAIL && env.EMAIL_ENABLED==='1'` send via binding (from `EMAIL_FROM`, name "Unsession") and mark sent/failed; else mark `simulated`. Body plain text v1 wrapped in a minimal themed HTML shell (accent bar with event primary color, logo name, footer). `renderTemplate(str, vars)` replaces `{{var}}`.
- `theme.ts` — port from prototype `Event Setup.dc.html` logic: `hex2rgb`, `lum`, `shade`, `tint`, `derive(primary)` → `{hover, border, tint, textOn}` with WCAG contrast choice; `themeStyleVars(theme)` → CSS custom-property string for public layout.
- `activity.ts` — `logActivity(db, {eventId, subjectType, subjectId, actor, action, detail})`.
- `slugify.ts`.

## 4. Views & layout conventions (`src/views/`)

- Hono JSX. **Fidelity rule: copy markup + inline styles from the prototype files verbatim** (adjusting only templating). Square corners, Space Grotesk/IBM Plex Mono via Google Fonts links, admin palette `#4c5fd5` indigo etc. per prototype README tokens.
- `AdminLayout` — 216px sidebar exactly as prototype (nav sections EVENT/PROGRAM/PUBLIC), active-state styling, user block with real name + Sign out, header with event name + `unsession.dev/{slug}` + dates + CFP status pill, **event switcher**: clicking event name in header opens dropdown of org events + "＋ New event" (mirror the Forms screen's picker pattern). Sidebar "PUBLIC" links point at real public URLs (target _blank).
- `PublicLayout` — event-themed wrapper: bg/text/primary from `theme_json` as CSS vars, fonts per pairing, sticky mini header (logo block + event name) as in `Submit.dc.html`.
- `Toast` helper — server-flash via `?ok=` message query param rendered as the prototype's dark toast (auto-hide via 3-line inline script). Shared `public/js/ui.js` for tiny helpers (toast, dialog open/close, fetch JSON wrapper `api()`).
- Brand: product name **Unsession**, logo block letter "U" (indigo square, mono font) — replaces "Program"/"P" everywhere.

## 5. Pages in scope for A

1. **Landing `/`** — simple, tasteful, prototype-styled (paper bg, mono microlabels): headline "Run your call for speakers without the bloat", 3 bullets (CFP forms → evaluation → agenda), buttons: "Try the sandbox" (POST `/sandbox` → provisions sandbox org+event, signs you in as its organizer via anonymous sandbox user, redirects `/app`) and "Sign in". Footer "Unsession".
2. **Sign in `/signin`** — port `Sign In.dc.html` visually; email field + "Email me a magic link" (primary), Google button (only when configured); on submit → "check your email" state; in simulated-email mode ALSO render the verify link inline ("Dev mode: email sending not yet enabled — open your magic link"). No password field (DECISIONS D2).
3. **Auth routes** as in §3.
4. **`/app` Dashboard** — port `Dashboard.dc.html`: greeting with real user first name, 4 KPI cards, pipeline bar, deadlines (from form close dates + event dates + plan deadlines), review progress — all computed from DB for active event. Attention list computed: unscheduled accepted count, overdue tasks count, unreviewed submissions count (conflicts item comes with B4; include if cheap: same-speaker overlap query on sessions).
5. **`/app/events/new`** — create event: name, slug (auto from name, editable, uniqueness check), start/end dates, timezone (IANA select — common list), venue, mode. Creates default taxonomies (Track/Format/Level with prototype options+colors), default rooms (Main Stage only), default email templates (subjects/bodies lifted from the prototype's Submissions modal + Speakers reminder + a confirm_submission template), theme default (`#e8590c`, bg `#faf8f5`, font 'Space Grotesk'). First event of a new user also creates their org ("<name>'s events"). Redirect `/app/setup`.
6. **`/app/setup`** — port `Event Setup.dc.html` fully: basics form (persist), rooms chips + dialog (name/capacity/priority), taxonomies + option dialog (color/duration per taxonomy flags) + new-taxonomy dialog, theme panel (color input persists, font select persists, derived swatches live via small island `public/js/setup.js`), live preview block, Save header button. Logo upload button: if R2 unavailable show disabled state with tooltip "File storage not yet enabled".
7. **`/app/team`** — members table (name, email, role, joined), invite form (email + role), pending invites list with revoke; invite email contains magic link (purpose `invite`, payload org+role); accepting signs in + joins org. Role guard: owners/admins manage team.
8. **`/app/emails`** — two tabs: Templates (list of event's email_templates, edit subject/body in the prototype's editor-modal style with variables hint + "Send test to me") and Log (table: time, to, template, subject, status chip; filter by status; detail view shows body).
9. **Route stubs** for `/app/submissions`, `/app/forms`, `/app/evaluation`, `/app/sessions`, `/app/speakers`, `/app/agenda`, and public `/{event}/…` pages: register in router, render AdminLayout/PublicLayout with an "Under construction — {page}" card so nav works end-to-end. **Create one file per page** under `src/routes/` named: `admin-submissions.tsx`, `admin-forms.tsx`, `admin-evaluation.tsx`, `admin-sessions.tsx`, `admin-speakers.tsx`, `admin-agenda.tsx`, `public-form.tsx`, `public-agenda.tsx`, `public-portal.tsx`, `public-evaluate.tsx`, `public-speaker.tsx` — B-track agents will replace file contents without touching the router.
10. **Sandbox seeding** — `src/lib/seed.ts`: converts `prototype/design_handoff_program/design/data.js` content (copy it into `src/lib/seed-data.ts` as TS consts) into a full sandbox: org (is_sandbox=1), event devconf-2027-{4char} (unique slug), rooms, taxonomies, forms (cfp + sponsor with schemas matching the prototype's Forms screen field lists incl. conditions), ~30 submissions with statuses/speakers/scores (create eval plan "Main CFP Review" + reviewers as users + evaluations rows matching evalDone/avg), sessions for accepted/confirmed (+ agenda placements incl. the Ines double-booking + service blocks), speaker profiles, task templates (the 6 from `Speakers.dc.html` seed) + task instances matching SPEAKER_TASKS grid, email templates. Deterministic-ish scores: distribute so avg matches data.js within rounding.
11. **`POST /sandbox`** — creates sandbox + a user `sandbox-<id>@sandbox.unsession.dev` (name "Sean Parker"), org membership owner, session cookie, redirect `/app`.

## 6. Conventions for B tracks (document in `src/CONVENTIONS.md`)

Write a short conventions file covering: file ownership map (which route files belong to which track), how to add an island (`public/js/<page>.js`, loaded via `<script type="module" src>`), the `api()` fetch wrapper + JSON POST route pattern (`/app/api/...` returning `{ok:true,...}`), toast pattern, activity logging expectations, email sending, and "port prototype markup verbatim" fidelity rule.

## 7. Verify & finish

- `npm run db:migrate:local`, `wrangler dev` smoke test locally (curl `/`, `/signin`, sandbox POST + follow cookie to `/app`).
- Apply remote migrations, `wrangler deploy`, curl the deployed URL for `/` 200 and `/app` redirect to signin.
- Do NOT commit (the orchestrator commits after review).
- Final report: what works, deployed URL, any deviations from this spec, open questions.
