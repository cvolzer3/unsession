# Unsession — code conventions

Read this before touching anything under `src/`. Phase A built the foundation;
the B tracks fill in the screens. The rules below keep five parallel agents from
stepping on each other.

## 1. File ownership map

Each route file is owned by exactly one track. **Replace the contents of your
files; do not edit files you do not own, and do not touch `src/index.tsx`** —
the router already mounts every route file, so a rewrite that keeps the same
exported Hono app and the same registered paths needs no router change.

| Track | Owns |
|---|---|
| A (done) | `src/index.tsx`, `src/lib/*`, `src/views/layout.tsx`, `src/views/chrome.ts`, `src/routes/landing.tsx`, `auth.tsx`, `admin-dashboard.tsx`, `admin-events.tsx`, `admin-setup.tsx`, `admin-team.tsx`, `admin-emails.tsx`, `migrations/*`, `public/js/ui.js`, `public/js/setup.js` |
| B1 Forms & public submission | `src/routes/admin-forms.tsx`, `src/routes/public-form.tsx`, `public/js/forms.js`, `public/js/submit.js` |
| B2 Submissions & decisions | `src/routes/admin-submissions.tsx`, `public/js/submissions.js` |
| B3 Evaluation | `src/routes/admin-evaluation.tsx`, `src/routes/public-evaluate.tsx`, `public/js/evaluation.js`, `public/js/evaluate.js` |
| B4 Sessions & agenda | `src/routes/admin-sessions.tsx`, `src/routes/admin-agenda.tsx`, `src/routes/public-agenda.tsx`, `src/routes/public-speaker.tsx`, `public/js/agenda.js`, `public/js/sessions.js` |
| B5 Speakers & tasks | `src/routes/admin-speakers.tsx`, `src/routes/public-portal.tsx`, `public/js/speakers.js`, `public/js/portal.js` |

Shared files (`src/lib/*`, `src/views/layout.tsx`) are append-only for B tracks:
add a helper, never rewrite an existing one. If two tracks need the same new
helper, put it in `src/lib/` and say so in your final report.

New migrations are `migrations/000N_<feature>.sql` — numbered after the highest
existing file, named for the feature, never edited once applied.

## 2. Fidelity rule (the important one)

**Port the prototype markup and inline styles verbatim.** Open the matching
`prototype/design_handoff_program/design/*.dc.html`, copy the markup, and change
only what templating requires. Do not "improve" spacing, colors, or copy.

- Square corners everywhere. `border-radius` only on avatars and status dots.
- Admin is never themed: `#f4f4f6` page, `#fff` cards, `#e2e3e8` borders,
  `#4c5fd5` indigo primary, `#16171d` / `#686b74` / `#9a9da6` text.
- Public surfaces are themed: use the CSS custom properties emitted by
  `themeStyleVars()` (`var(--primary)`, `var(--bg)`, `var(--border)`,
  `var(--font-ui)`, `var(--font-mono)`, …) — never a hard-coded orange.
- Two fonts: Space Grotesk for language, IBM Plex Mono (`MONO` from
  `views/layout`) for microlabels, ids, timestamps, counts and KPI numerals.
- Product name is **Unsession**, logo letter **U** (the prototype's
  "Program"/"P" is gone). Public logo blocks use `initialsOf(event.name)`.

## 3. Page shape

```tsx
import { AdminLayout } from '../views/layout';
import { adminProps } from '../views/chrome';

app.get('/app/thing', async (c) => {
  const props = await adminProps(c, 'Thing');           // sidebar, header, switcher, toast
  if (!c.var.event) return c.redirect('/app/events/new');
  return c.html(<AdminLayout {...props}>…</AdminLayout>);
});
```

- `adminProps(c, title, extra)` takes overrides: `headerTitle` (replaces the
  event switcher with a plain title), `headerActions` (JSX rendered at the right
  of the header), `scripts` (island URLs).
- Public pages use `loadPublicEvent(c.env.DB, c.req.param('event'))` then
  `<PublicLayout title event={found.event} theme={found.theme} maxWidth={…}>`.
- `c.var` carries `user`, `session`, `event` (the session's active event),
  `events` (everything the user can see), `role`.
- Guard writes with `requireOrgRole('admin' | 'owner')`. `/app` and `/app/*`
  already require a signed-in user.

## 4. Islands

No build step, no framework (DECISIONS D10). One file per page under
`public/js/<page>.js`, loaded through the layout:

```tsx
<AdminLayout {...props} scripts={['/js/agenda.js']}>
```

`public/js/ui.js` loads on every page and exports the shared helpers:

```js
import { toast, api, openDialog, closeDialog, copy } from './ui.js';
```

Declarative behaviour it already provides — prefer these over new code:

| Attribute | Effect |
|---|---|
| `data-toggle="#id"` | Click toggles `[hidden]` on the target; outside click and Escape close it (the header event switcher uses this) |
| `data-dialog` on an overlay | Marks a modal; backdrop click and Escape close it |
| `data-dialog-open="#id"` | Opens that modal |
| `data-dialog-close[="#id"]` | Closes the nearest (or named) modal |
| `data-copy="text"` `data-copy-msg="…"` | Clipboard copy + toast |

Progressive enhancement: a page must work with plain form POSTs where it
reasonably can. Modals are server-rendered `hidden` overlays containing real
`<form>`s — that is why Event Setup works without JavaScript.

## 5. JSON endpoints

Interactive islands POST JSON to `/app/api/...` and get `{ ok: true, ... }` back:

```js
await api('/app/api/sessions/move', { id, day, startMin });   // throws on !ok
```

```ts
app.post('/app/api/sessions/move', requireOrgRole('collaborator'), async (c) => {
  const body = await c.req.json<{ id: string }>();
  …
  return c.json({ ok: true, session });
});
```

Errors: `return c.json({ ok: false, error: 'Human sentence' }, 400)` — `api()`
throws with that sentence, and the caller shows it with `toast(err.message, false)`.

## 6. Toasts and flashes

Server-side redirects flash through the `ok` query param, which
`adminProps` picks up and `AdminLayout` renders as the prototype's dark toast:

```ts
return c.redirect('/app/setup?ok=' + encodeURIComponent('Saved — public surfaces revalidate on next request'));
```

Client-side, call `toast('…')`. Toast copy comes from the prototype's `flash()`
strings wherever one exists — keep the em dashes and the curly quotes.

## 7. Database

```ts
import { all, one, run, batch, now, jsonParse } from '../lib/db';
import { newId, nextSeq } from '../lib/ids';
```

- Ids are app-generated: `newId('sub')` → `sub_a1b2c3d4e5f6`. Prefixes in use:
  `usr ses mtk org inv evt rom tax tpo frm fvr sub ssp spk epl evl tsk tsi etp eml act file`.
- Timestamps are `now()` — ISO-8601 UTC, second precision. Dates that mean a
  calendar day (`start_date`, `due_date`, `closes_at`) are `YYYY-MM-DD`.
- Every `*_json` column is TEXT; read with `jsonParse(row.x_json, fallback)`.
- Display submission ids are `SUB-<seq>`; allocate with `nextSeq(db, eventId, 'submission')`.
- Batch large writes with `batch(db, [[sql, params], …])` — each `db.batch()`
  is one subrequest and the free plan allows 50 per request.
- Agenda times are minutes from 08:00 with a day index; `day IS NULL` means
  unscheduled (DECISIONS D9).
- **Session ≠ Submission.** Accepting copies content into `sessions`; editing a
  session must never write back to the submission.

## 8. Activity log

Anything an organizer would want to see later gets an activity row:

```ts
await logActivity(c.env.DB, {
  eventId: event.id,
  subjectType: 'submission',      // submission | session | speaker | task | event | form | plan
  subjectId: submission.id,
  actor: c.var.user?.name || c.var.user?.email || 'System',
  action: 'Accepted',             // short past-tense verb phrase
  detail: 'Decision email sent (template “Accept v1”)',
});
```

Status changes, decisions, emails sent, task completion, schedule changes and
publish actions are all logged. Reads never log.

## 9. Email

```ts
import { sendEmail, renderTemplate } from '../lib/email';

const tpl = await one(db, `SELECT * FROM email_templates WHERE event_id = ? AND key = ?`, event.id, 'accept');
await sendEmail(c.env, {
  eventId: event.id,
  to: speaker.email,
  toName: speaker.name,
  templateKey: 'accept',
  subject: renderTemplate(tpl.subject, vars),
  text: renderTemplate(tpl.body, vars),
  subjectType: 'submission',
  subjectId: submission.id,
});
```

- Never call `env.EMAIL` directly. `sendEmail` always writes the `emails` row
  first, so the log is complete whether or not sending is live.
- Sending is live (`EMAIL_ENABLED=1` + `send_email` binding); sandbox orgs are
  force-simulated in `lib/email.ts`. Flows that depend on a link the user must
  open (magic links, invites, confirmations) **must surface the URL in the UI**
  when `status === 'simulated'` — see `/signin` and `/app/team` for the pattern.
- Decision emails are never sent from the decision modal. Deciding queues into
  `decision_queue` (`lib/decision-queue.ts`); an organizer sends from
  Emails → Outbox, which runs `applyDecision` in batches sized to fit one
  request's subrequest budget. Other bulk sends stay synchronous per request —
  keep batches under the subrequest limit.
- Templates are per event, keyed `accept | decline | waitlist | reminder |
  task_nag | schedule_notice | confirm_submission`. Variables are `{{snake_case}}`.

## 10. Magic links

```ts
const res = await requestMagicLink(c.env, email, 'confirm_participation',
  { submissionId, next: `/${event.slug}/portal` },
  { eventId: event.id, subject: '…', text: '…' });
if (res.simulatedLink) { /* show it */ }
```

Purposes: `signin | invite | confirm_participation | draft_link`. Tokens are
single-use, 30-minute, SHA-256 hashed at rest. `/auth/verify` consumes the
token, creates the user if needed, opens a session, then redirects to
`payload.next`. Add new purposes by extending the switch in `routes/auth.tsx`
(coordinate — that file is track A's).

## 11. Theming

`src/lib/theme.ts` is the single source: `derive(primary)` gives
`{hover, border, tint, textOn}` with the WCAG contrast choice, and
`themeStyleVars(theme)` emits the CSS custom properties. `public/js/setup.js`
mirrors the same math client-side. If you need a new derived token, add it in
both places.

## 12. Availability notes

- **R2 / file uploads** — live (`FILES` binding, bucket `unsession-files`).
- **Email sending** — live since 2026-08-12 (Workers Paid + Email Service,
  `EMAIL` binding, `EMAIL_ENABLED=1`). Sandbox orgs are force-simulated in
  `src/lib/email.ts`; the abstraction rules in §9 still apply.
- **Google OAuth** — the button appears only when `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` secrets exist (still unset).
- **Cron work** — `src/lib/jobs.ts` runs every 15 minutes (reminder engine).
  Add scheduled functions there, not inline.
