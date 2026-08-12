# Unsession — Build Plan

**Product:** Unsession — conference session booking platform (CFP → evaluation → decisions → speaker onboarding → agenda → publication). Pared-down Sessionboard Program alternative.
**Source of truth:** `prototype/design_handoff_program/` — 15 hi-fi HTML screens + `data.js` seed + two specs. Where mock and spec disagree: spec wins on behavior, mock wins on visuals.
**Status:** Living document. Written 2026-08-11 after full prototype review.

---

## 1. Stack & Infrastructure (decided)

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Cloudflare Workers** (account `unsession`, id `9bbf4e4369014eae4329711aced8e0ae`) | User directive; free tier |
| Framework | **Hono + JSX server rendering**, TypeScript | Spec §5.1: server-rendered pages, interactive islands only where needed |
| Database | **D1** (SQLite) — `unsession-db` | Free tier ample (5M reads/day); relational model fits |
| Files | **R2** (`unsession-files`) once enabled in dashboard; until then uploads degrade gracefully ("uploads not yet enabled") | R2 needs one-time dashboard enablement |
| Email | **Cloudflare Email Service** (`send_email` binding), from `@unsession.dev` | Zone `unsession.dev` is live on the account. Until domain onboarding completes, an email abstraction logs to the `emails` table with `simulated` status and dev-surfaces magic links |
| Auth | **Email + password** (all roles; PBKDF2-SHA256 via WebCrypto) + session cookie backed by D1, plus single-use emailed links for invites, participation confirmations, draft resume and password reset/first-time setup | Spec §4.4/§5.3. Conventional sign-in per Decisions D14 (supersedes the passwordless magic-link + Google OAuth plan in D2/D12) |
| Client interactivity | Hand-written vanilla JS islands in `/public/js/` (form builder, agenda drag-drop, conditional forms, tables) | No client build step; pixel-perfect control; matches "islands" philosophy |
| Background work | `ctx.waitUntil` for email sends; **Cron trigger** (every 15 min) for scheduled reminders (CFP closing, task nags, reviewer reminders) | Queues needs paid plan; cron is free |
| Hosting | `unsession.dev` custom domain (+ `unsession.workers.dev` fallback) | Real domain exists |
| Public agenda caching | `Cache-Control` + Cache API, purge-on-publish | Spec §4.11 "cheapest and most visible" |

Repo layout: `src/` (routes, views, lib), `migrations/` (D1 SQL), `public/` (js islands, css), `prototype/` (reference, committed), `PLAN.md`, `DECISIONS.md`.

## 2. Domain model → D1 schema (summary)

users · auth_sessions · magic_tokens · orgs · org_members(role: owner|admin|collaborator) · invites · events(theme_json, publish flags) · rooms · taxonomies · taxonomy_options · forms(settings_json) · form_versions(schema_json) · submissions(status: draft→submitted→in_review→accepted/declined/waitlisted→confirmed / withdrawn; answers_json) · submission_speakers · files(r2_key, versioned) · comments · activity · eval_plans(criteria_json, rules_json) · eval_plan_reviewers · evaluations(scores_json, note, abstained) · sessions(type: talk|sponsor|service; copy of submission content; day/start_min/end_min/room nullable = unscheduled; published flag; status pending|confirmed) · session_speakers · speaker_profiles(per-event) · task_templates · tasks(status: open|pending_review|done; due; versions) · email_templates · emails(log: queued|sent|failed|simulated)

Key invariants (from spec):
- **Session ≠ Submission** — accepting a submission creates a session copy; edits to the session never touch the submission.
- **Confirmed gates public display** and triggers task generation.
- Times stored as UTC + event timezone; agenda slots as minutes-from-08:00 per event day (prototype convention) with day index.
- Form versioning: first submission freezes a version; edits create new version; submissions pin their version. Archived fields hidden from new, visible on old.
- Conditions only reference earlier fields; server re-evaluates conditions at submit.
- Per-field flags (public / speaker-editable / evaluator-visible) enforced server-side.

## 3. URL map

Public (event-themed): `/{event}/` → agenda · `/{event}/{form}` submission form · `/{event}/agenda` · `/{event}/speakers/{slug}` · `/{event}/portal` speaker portal · `/{event}/evaluate` evaluator workspace · `/{event}/agenda.json` read-only JSON.
Admin (indigo, never themed): `/app` dashboard · `/app/setup` · `/app/forms` · `/app/submissions` · `/app/evaluation` · `/app/sessions` · `/app/speakers` · `/app/agenda` · `/app/team` · `/app/emails` (templates + log) · `/app/events/new` · event switcher in header. Event scoping via `?e=` … no: active event stored in session, switcher swaps it (URLs stay clean, matches prototype nav).
Auth: `/signin` · `/auth/magic` (request) · `/auth/verify` (consume) · `/auth/google` + `/auth/google/callback` · `/auth/signout`.
Landing: `/` product page with "Try the sandbox" (spec §4.13) and sign-in.

## 4. Dead-end inventory → resolutions

Every `flash()` toast and `href="#"` in the prototype, with the decided fix:

| # | Screen | Dead end | Resolution |
|---|---|---|---|
| 1 | Sign In | "Email me a magic link instead" `href="#"` | Real magic-link flow for organizers too (see D2) |
| 2 | Sign In | Demo seeded-session links | Landing "Try the sandbox" provisions seeded sandbox event (spec §4.13) using prototype `data.js` content; the four demo personas become real sandbox logins |
| 3 | Submissions | Import CSV toast | Real CSV import: upload → column-mapping UI → create submissions |
| 4 | Submissions | Export CSV toast | Real CSV download of current filter/selection (export-everywhere rule) |
| 5 | Submissions | "Send email" (bulk) toast | Group mailing composer modal: template picker + variables + preview + recipient list + confirm; logs to email log |
| 6 | Submissions | Decision modal confirm (simulated) | Real: status change + per-recipient templated email (queued via waitUntil) + activity log + confirmation tokens in accept emails |
| 7 | Submissions drawer | Hardcoded uploads (PDF/MP4/JPG) | Render real submission file answers from R2; download via signed URL route |
| 8 | Event Setup | Save toast | Real persist of basics/rooms/taxonomies/theme |
| 9 | Event Setup | Duplicate event toast | Real "duplicate event" cloning structure only (forms as fresh versions, categories, task templates, rooms, theme, email templates) — Phase C |
| 10 | Event Setup | Logo upload toast | Real upload to R2, shown on public surfaces + emails |
| 11 | Event Setup | Font pairing toast | Actually applies one of ~8 curated Google-font pairings to public theme |
| 12 | Forms | Copy share link | Real clipboard copy of `unsession.dev/{event}/{form}`; draft forms have no link until published |
| 13 | Forms | Preview mode | Kept: renders live form from schema in-admin, conditions fire live |
| 14 | Evaluation | Reminder "send now" / test send | Real emails via Email Service, logged; "sent today" state persisted |
| 15 | Evaluation | Automation settings | Persisted per-plan; cron trigger evaluates schedule (14/7/3 days before, overdue) |
| 16 | Evaluation | Stats CSV export toast | Real CSV of plan scores |
| 17 | Evaluation org view | Approve/Waitlist/Deny buttons flip local state | Open the same decision-email modal as Submissions (spec §4.7: decisions always go through preview + confirm). No silent status changes |
| 18 | Sessions | Inline edits, save toast | Real persist; sync to agenda placements + public pages |
| 19 | Sessions | (missing) | **Add "New session" button** — create sponsor/service sessions directly (spec §4.9); talk sessions come from accepted submissions automatically |
| 20 | Speakers | ZIP headshots/slides toast | Real ZIP streaming from R2 (fflate), organized by day/room for slides |
| 21 | Speakers | Nudge / Email speaker | Real templated email sends, logged |
| 22 | Speakers | Template editor, bulk assign, one-offs | Real CRUD + instance stamping; "apply to open instances" flow as designed |
| 23 | Speaker Portal | Confirm participation | Real: submission → confirmed, session status → confirmed, tasks generated per templates, activity + email |
| 24 | Speaker Portal | Add to calendar | Real `.ics` download (METHOD:REQUEST, TZID, sequence bumps on change; CANCEL on unschedule) + email invite on schedule change |
| 25 | Speaker Portal | Task Upload / Open form | Real upload dialog (R2, versioned) and mini-form renderer (reuses form engine) |
| 26 | Speaker Portal | Withdraw | Real: status withdrawn, organizers notified, session unscheduled with warning, tasks cancelled, ICS CANCEL |
| 27 | Agenda Builder | Publish toast | Real: event.published flag + per-session publish; purge public cache |
| 28 | Agenda Builder | "+ Sponsor session" toast | Real sponsor session editor dialog (title, company, speakers, slot) |
| 29 | Agenda Builder | Quick-edit toast | Real in-place editor card (title, time, room, publish flag) |
| 30 | Agenda public | Session detail "coming soon" fallback | Sessions carry their own abstract (copies), so detail always renders |
| 31 | Submit | Headshot upload placeholder | Real camera-roll-friendly upload |
| 32 | Submit | Share card toast | Copies share text + link to clipboard |
| 33 | Submit | Autosave indicator (fake timer) | Real debounced draft autosave to server (magic-link account auto-created on first save — see D3) |

## 5. Missing flows I'm adding (not in the mocks)

1. **Landing page** (`/`) — product intro, "Try the sandbox", sign in. Unsession branding.
2. **Create event** wizard + **event switcher** in admin header (user-requested).
3. **Team page** (`/app/team`) — members list, role change, email invites (magic-link accept), per spec §2 roles (user-requested).
4. **Email templates page** (`/app/emails`) — the §4.7 library (accept/decline/waitlist/reminder/task-nag/schedule-notice) with variables, editing, test-send; plus the **email log** tab (user-requested).
5. **Bulk decision send** — already designed in Submissions modal; extended with per-recipient decline feedback fields (mock has them) and background sending (user-requested "bulk email send flow").
6. **Evaluator onboarding** — adding a reviewer to a plan invites them by email; they sign in via magic link and see only their queue.
7. **Sandbox provisioning** — "Try it" creates an org+event pre-seeded from the prototype's `data.js` (DevConf 2027 mid-lifecycle: ~30 submissions, part-done evals, agenda with the Ines Kovač double-booking, task grid). Claimable by signing in.
8. **Account/profile page** (minimal): name, email, sign out everywhere.
9. **Confirmation links in accept emails** — tokenized URL that confirms participation without login friction (magic-link semantics).
10. **CSV import mapping UI** (spec §4.5).

## 6. Build phases & work packages

**Phase A — Foundation (blocking):** scaffold, migrations, auth (magic+Google-ready), org/event model, admin shell (sidebar/header/switcher), theming engine (tokens → CSS vars, contrast enforcement), landing, signin, create-event, team invites, email abstraction + log, seed script (sandbox).

**Phase B — parallel tracks (each = one Opus subagent):**
- **B1 Forms & Public Submission:** form list/picker, builder (drag-drop, field types, per-field flags, conditions, validation editor), settings (open/close, drafts, late link, welcome, caps), versioning, preview; public renderer (mobile-first, autosave, conditional fire, co-speakers, uploads, error summary), post-submit page, drafts in portal.
- **B2 Submissions & Decisions:** table (filters, chips, search, sort, bulk bar, saved selection), drawer (fields, uploads, comments w/ @-mentions, activity), decision modals (single+bulk, per-recipient feedback, confirmation checkbox), CSV import/export, group mailing composer.
- **B3 Evaluation:** plans list/edit/detail (rubric builder, reviewer roles, rules scope preview, live scoring demo), evaluator queue (card + list modes, keyboard 1–5/Enter, skip/abstain, blind review), org scores view + submission detail with per-evaluator breakdown, reminders (manual + automation + editor + test send), stats CSV.
- **B4 Sessions & Agenda:** sessions table (inline edit, badges, new sponsor/service), agenda builder (rooms cols + lanes, day/list/week views, drag-drop with ghost, 15-min snap, conflict detection warn-not-block with undo, service blocks, bin, schedule dialog, quick-edit, publish), public agenda (5 views, tz toggle, track chips, detail popover, sponsor badges), speaker profile page, ICS generation.
- **B5 Speakers & Tasks:** task templates CRUD (4 types, triggers, clauses, due/grace, reminders, review toggle, archive, apply-to-open-instances), grid (filters, pagination, cell states), speaker drawer (profile, tasks, nudge, assign, one-offs), bulk assign, portal checklist (confirm banner, uploads with versions, mini-forms, profile editor, withdraw), ZIP downloads, file review loop (approve/request changes).

**Phase C — Integration & polish:** cross-links between screens, dashboard live numbers, cron reminders, duplicate event, embeds, `agenda.json`, browser QA pass on every flow, deploy hardening.

## 7. Verification

Browser (Chrome extension) walkthrough of the golden path after each phase: create event → build form → submit publicly → evaluate → accept (email) → confirm (portal) → tasks appear → schedule on agenda → publish → public agenda + speaker page + ICS. Screenshot-compare against prototype for fidelity.

## 8. Cut list (unchanged, permanent — spec §6)

No CRM, payments, attendee accounts, AI evaluators, custom CSS, native app, multi-language, integrations marketplace, page-jump branching, multi-round review.
