# Shared contracts for all B tracks

Read this + `src/CONVENTIONS.md` + `PLAN.md` before your track spec. The foundation (Phase A) is already in place: DB schema (`migrations/0001_init.sql`), auth, layouts, email lib, theme lib, seeded sandbox. **Do not modify foundation files, the router (`src/index.tsx`), other tracks' files, or the DB schema without noting it prominently in your report.** If you genuinely need a migration, add a NEW numbered migration file — never edit 0001.

## File ownership (hard boundaries)

| Track | Owns (replace stub contents freely) |
|---|---|
| B1 | `src/routes/admin-forms.tsx`, `src/routes/public-form.tsx`, `public/js/form-builder.js`, `public/js/public-form.js`, `src/lib/forms.ts`, `src/lib/conditions.ts` |
| B2 | `src/routes/admin-submissions.tsx`, `public/js/submissions.js`, `src/lib/decisions.ts`, `src/lib/csv.ts` |
| B3 | `src/routes/admin-evaluation.tsx`, `src/routes/public-evaluate.tsx`, `public/js/evaluation.js`, `public/js/evaluate.js`, `src/lib/evals.ts` |
| B4 | `src/routes/admin-sessions.tsx`, `src/routes/admin-agenda.tsx`, `src/routes/public-agenda.tsx`, `src/routes/public-speaker.tsx`, `public/js/agenda-builder.js`, `public/js/sessions.js`, `public/js/public-agenda.js`, `src/lib/ics.ts`, `src/lib/agenda.ts` |
| B5 | `src/routes/admin-speakers.tsx`, `src/routes/public-portal.tsx`, `public/js/speakers.js`, `public/js/portal.js`, `src/lib/tasks.ts`, `src/lib/zip.ts` |

Shared core libs (already present, do not rewrite — extend only if your spec says so): `src/lib/{db,ids,auth,email,theme,activity,slugify,sessions-core,confirm}.ts`.

API route namespace: mount your JSON endpoints INSIDE your own route file under `/app/api/<yourarea>/...` (admin) or `/p/api/...` (public/portal). The router already forwards these prefixes to your file.

## Form schema JSON (`form_versions.schema_json`) — canonical shape

```jsonc
{ "fields": [ {
  "id": "f_abc123",            // immutable
  "core": true,                 // optional; core fields: title, abstract, format, speakers GRP
  "type": "TXT|LONG|EML|URL|TEL|NUM|DATE|SEL|MULTI|CHK|FILE|HDR|GRP",
  "label": "Session title",
  "required": true,
  "placeholder": "",           // optional
  "help": "",                  // optional
  "opts": ["A","B"],           // SEL/MULTI literal options…
  "taxonomyId": "tax_x",       // …or bound to a taxonomy (opts then come from taxonomy_options)
  "validation": { "minChars":0,"maxChars":0,"maxWords":0,"min":0,"max":0,"numKind":"integer","dateFrom":"","dateTo":"","fileExts":"pdf, key","fileMaxMb":25,"fileMaxCount":1,"mustCheck":false,"maxSpeakers":3 },
  "flags": { "public": true, "speakerEditable": false, "evaluatorVisible": true },
  "cond": { "src": "f_format", "op": "is|is not|contains|does not contain|is answered|is blank|gt|lt", "val": "Workshop (90 min)", "alsoReq": true }  // or null
} ] }
```

- `answers_json` on submissions: `{fieldId: string | string[] | number | boolean | fileId[]}`. Speaker data lives in `submission_speakers` rows (GRP field marks where the block renders). Title/abstract/format also mirrored to `submissions.title/abstract` and the format answer for fast queries — keep in sync on write.
- `src/lib/conditions.ts` (B1 creates early; B3/B5 may import): `evalCond(cond, answers) -> boolean`, `visibleFields(fields, answers) -> fields[]` (top-down single pass, conditions only reference earlier fields), `validateSubmission(fields, answers, speakers, {hard}) -> {errors}` — server-side authority.

## Status & decision flow

- `src/lib/decisions.ts` (B2) is THE way statuses change to accepted/declined/waitlisted: updates submission, creates session copy on accept via `sessions-core.createSessionFromSubmission`, renders template email per recipient (per-recipient `{{individual_feedback}}` for declines), queues via `sendEmail`, logs activity, returns summary. Accept emails include `{{confirmation_link}}` = `${APP_ORIGIN}/confirm/<token>` (magic_tokens purpose `confirm_participation`, payload {submissionId}).
- `src/lib/confirm.ts` (foundation) `confirmParticipation(env, submissionId, actor)`: submission → confirmed, its session status → confirmed, task generation trigger fires, activity + emails. Portal button (B5) and `/confirm/<token>` route (foundation) both call it.
- Cross-page deep links instead of cross-track imports for UI: e.g. Evaluation's Approve button → `/app/submissions?open=<subId>&action=accept` (B2's page auto-opens the right modal on those params).

## Email

`sendEmail(env, {...})` already handles simulated mode. Product emails use `email_templates` for the event (keys: accept, decline, waitlist, reminder, task_nag, schedule_notice, confirm_submission) + `renderTemplate(subject/body, vars)`. Vars available: `{{speaker_name}} {{session_title}} {{event_name}} {{confirmation_link}} {{individual_feedback}} {{slot_time}} {{portal_link}} {{task_name}} {{due_date}} {{days_left}}`.

## Files/uploads (R2 bucket `unsession-files`, binding `FILES` — foundation adds binding)

Upload pattern: client POSTs `multipart/form-data` to your API route → validate ext/size server-side → `env.FILES.put(key, stream)` key = `ev/<eventId>/<kind>/<fileId>/<filename>` → insert `files` row → return file id. Download route (foundation): `/files/<fileId>` streams from R2 with auth check (public for kind=headshot/logo of published content; otherwise requires event access). Versioned re-upload: new `files` row, `version = prev+1`, same subject.

## Fidelity & UX rules (all tracks)

- Port prototype markup + inline styles **verbatim** where a screen exists (your track spec names the file). Square corners everywhere; admin indigo `#4c5fd5`; fonts Space Grotesk / IBM Plex Mono; status colors per `prototype/.../data.js` STATUS map.
- Toasts: dark bottom-center toast (`ui.js` helper `toast(msg)`); server flash via `?ok=` param.
- Every table: CSV export button that really downloads (use `csv.ts` helper from B2 or inline a small one; format: header row + quoted values).
- Every mutation logs to `activity` where the spec's activity log mentions it.
- All admin routes: `requireUser` + event access already enforced by parent router; get current event via `c.var.event`.
- Islands: plain JS modules; server passes initial data via `<script type="application/json" id="data-x">` blocks; no external CDNs.
- Buttons that a track cannot finish MUST NOT dead-end silently: either implement, or hide.

## Definition of done (each track)

`npx tsc --noEmit` clean · `wrangler dev` manual curl of your pages (200 + expected HTML) · key JSON APIs curl-tested (create/update/list) · works against the seeded sandbox event · deviations + judgment calls listed in final report. Do NOT deploy, do NOT git commit (orchestrator does both).
