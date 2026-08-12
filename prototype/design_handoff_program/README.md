# Handoff: "Program" — Conference Session Booking Platform

## Overview
"Program" is a self-serve speaker & session management product for conference organizers: call for speakers → evaluation → accept/decline → speaker onboarding → agenda building → public publication. This bundle contains the complete hi-fi design prototype (14 interlinked screens), the shared seed data, and the two product specs the design was built against.

Read in this order:
1. `specs/program-spec.md` — full product spec (v1.0): vision, domain model, features, cut list, build phases.
2. `specs/tasks-spec.md` — addendum expanding §4.8 (speaker tasks) into a full spec.
3. `design/` — the screens. Open `design/Dashboard.dc.html` in a browser and click through; all screens are linked.

## About the Design Files
The files in `design/` are **design references created in HTML** — interactive prototypes showing intended look, layout, and behavior. They are NOT production code. Your task is to **recreate these designs in the target codebase's environment** (or, if greenfield, pick the stack the spec implies: server-rendered pages with interactive islands, per spec §5.1). The `.dc.html` files contain a template section (markup with inline styles — the source of truth for all visual values) and a small logic class (interaction behavior). `support.js`, `image-slot.js` are prototype runtime only — ignore them. `data.js` is the seed data every screen renders from; it doubles as a reference shape for the domain model and as content for the demo sandbox (spec §4.13).

## Fidelity
**High-fidelity.** Colors, typography, spacing, and copy are final intent — recreate pixel-perfectly using your own component library. Exception: interactions marked "pending" below (drag-and-drop physics, real uploads, email sending) are indicated in the UI but only partially simulated; implement them per spec.

## Key Product & Design Decisions
These were settled during design; treat them as requirements, not suggestions.

1. **Two visual languages, hard boundary.** The **admin** is never themed: neutral cool grays with an indigo primary, desktop-first, dense. Every **external surface** (submission form, speaker portal, public agenda, speaker profile, evaluator portal) is themed with the event's brand tokens — the prototype uses the fictional "DevConf 2027" theme (warm paper background, orange primary, Space Grotesk). Per spec §4.12: theme tokens only, no custom CSS, automatic contrast enforcement.
2. **Square corners everywhere.** No border-radius on cards, buttons, inputs, badges — the only circles are avatars and status dots. Flat 1px-bordered white cards, no drop shadows. This is the product's visual signature on both admin and public surfaces.
3. **Two-font system.** Space Grotesk for UI text; IBM Plex Mono for all metadata: section microlabels (9.5–10.5px, uppercase, letter-spacing 0.1–0.14em), IDs, timestamps, counts, KPI numerals. Mono = data, Grotesk = language. The public theme font is a token (curated list of ~8 pairings); the admin always uses this pairing.
4. **Session ≠ Submission** (spec §3): sessions are copies of accepted submissions, editable for publication without touching review history. Sponsor and service sessions (breaks, lunch, registration) are created directly and are first-class in the agenda — service sessions can span all rooms.
5. **Status system is fixed and color-coded** (see tokens below): Draft → Submitted → In Review → Accepted → Confirmed / Declined / Waitlisted / Withdrawn. **Confirmed** (speaker explicitly confirms from portal/email) gates public agenda display and triggers task generation.
6. **Categories are event-level taxonomies** (Track/Format/Level + custom) with per-option colors. Track colors drive agenda color coding, table chips, and the public agenda filter — one definition used everywhere.
7. **Magic-link auth for speakers, no passwords.** The portal header shows the signed-in email + "magic link". Organizers use email+password (see Sign In screen: two entry paths).
8. **Evaluation is a queue**, not a table: evaluators see "N of M done", score 1–5 stars per criterion + comment, keyboard-friendly, and blind-review hides speaker-identifying fields (per-field evaluator-visibility flags).
9. **Conflict detection warns, never blocks.** The agenda builder shows collision warnings (the seed data deliberately double-books Ines Kovač at 14:00 across Room 2/Room 3 to demo this). Warning treatment, not error treatment.
10. **Tasks: one system, four types** (checkbox, file request, form, profile completion), two targets (speaker vs. session — session tasks complete once for all co-speakers). Statuses are human-readable words (To do / Pending review / Done / Overdue), never an icon legend. The organizer dashboard is a speakers × tasks grid.
11. **Safe destructive/emotional flows.** Decision emails (accept/decline) always go through preview + explicit confirmation showing exactly who receives what. Bulk actions show a preview count before commit.
12. **Every table exports CSV**; bulk operations (status change, assign to plan, email) are Phase-1 core, not polish.
13. **Seed data = demo sandbox.** `data.js` models an event mid-lifecycle (~30 submissions in all states, evaluations part-done, agenda with conflicts, tasks pending) — this is the spec §4.13 sandbox content strategy: every screen has data on first load.
14. **The cut list (spec §6) is permanent.** No CRM, no payments, no attendee accounts, no AI evaluators, no custom CSS, no native app. Do not build these.

## Screens (design/)
Admin (indigo, sidebar nav at 216px):
- **Sign In** — organizer email+password + speaker magic-link path.
- **Dashboard** — greeting, 4 KPI cards, submission pipeline bar, action items.
- **Event Setup** — event basics, dates/rooms/timezone, theming tokens with live preview.
- **Forms** — form list (multiple forms per event) + form builder: fixed core fields, custom field types, per-field flags (public/speaker-editable/evaluator-visible), conditional logic, preview mode.
- **Submissions** — the fast table: status filters, category filters, search, bulk bar, detail drawer with internal comments + activity log.
- **Evaluation** — evaluation plans: scope, rubric, evaluator assignment/progress, score distributions, reminders.
- **Sessions** — session list incl. sponsor & service sessions, per-field public-visibility.
- **Speakers & Tasks** — speaker directory + the speakers × tasks tracking grid with bulk reminders.
- **Agenda Builder** — day×room grid, unscheduled bin, track colors, conflict warnings, publish controls.

External (DevConf 2027 theme, orange):
- **Submit** — public submission form: mobile-first single column, autosave indicator, conditional fields firing live, co-speakers.
- **Speaker Portal** — my submissions with status, confirm-participation banner, task checklist, profile editor, slot + Add to Calendar.
- **Agenda** — public agenda: list/day/track/room + week views, viewer-timezone toggle, session detail overlay, sponsor badges.
- **Speaker Profile** — public speaker page as shown on the agenda.
- **Evaluator Workspace** — evaluator queue: progress, star rubric, comment, blind-review field hiding.

## Design Tokens

### Admin palette
- Page background `#f4f4f6` · card/surface `#fff`
- Text `#16171d` · secondary `#686b74` · muted `#9a9da6`
- Primary (indigo) `#4c5fd5` · hover `#3a4ab8` · selected-nav bg `#eef0fb`
- Borders `#e2e3e8` (cards) / `#eceded` (dividers)

### External palette (DevConf 2027 theme — these are *theme tokens*, organizer-configurable)
- Page background `#faf8f5` · card `#fff`
- Text `#1a1a2e` · secondary `#555a63` · muted `#8b857a` · faint `#b0a99c`
- Primary (orange) `#e8590c` · hover `#c44a0a`
- Borders `#ece7de` / `#ded8cd` · chip bg `#f0ece4`

### Status colors (fg / bg)
- Submitted `#1c7ed6` / `#e7f1fb` · In Review `#b08800` / `#fdf5dc` · Accepted `#2b8a3e` / `#e6f4ea` · Confirmed `#087f5b` / `#dcf2eb` · Declined `#c92a2a` / `#fbe9e9` · Waitlisted `#9c36b5` / `#f6e8f9` · Withdrawn `#868e96` / `#f1f3f5`

### Track colors
AI & ML `#7048e8` · Web Platform `#1c7ed6` · Infrastructure `#0ca678` · Security `#e03131` · Developer Experience `#e8590c`

### Typography
- Space Grotesk 400/500/600/700 — body 13–14px, card titles 15–16.5px 700, page titles 21–28px with -0.02em tracking.
- IBM Plex Mono 400/500/600 — microlabels 9.5–10.5px uppercase +0.1em, meta 10.5–11px, KPI numerals 26px 700.
- Both from Google Fonts.

### Spacing & shape
- Border radius: 0 (avatars/dots: 50%). Borders: 1px solid.
- Card padding 14–18px; admin content gutter 28px; grid gaps 10–14px.
- Admin sidebar 216px; admin content max-width 1160px; public agenda max-width 1240px; portal/form max-width 680px.

## Interactions & Behavior
Implemented in the prototypes (inspect the logic class in each file for exact behavior):
- Agenda view switching (list/day/track/room/week), viewer-timezone toggle, session detail overlay.
- Evaluator queue advance, star scoring, progress count.
- Submissions filtering, bulk-select bar, row drawer.
- Conditional form fields showing/hiding as answers change; autosave indicator.
- Confirm-participation flow in the portal (banner → confirmed state → checklist appears).
Spec-defined but only indicated in the mocks: real drag-and-drop scheduling, file uploads, email sending/preview, CSV import/export. Follow spec §§4.5–4.10.

## Assets
No image assets — headshots use initial-avatars/placeholder slots (`image-slot.js` in the prototype). Fonts from Google Fonts. Everything else is CSS.

## Files
- `design/*.dc.html` — the 14 screens (self-contained; inline styles carry all visual values).
- `design/data.js` — shared seed data: event, tracks, formats, forms, ~30 submissions, agenda placements, speaker/task grid.
- `design/support.js`, `design/image-slot.js` — prototype runtime; do not port.
- `specs/program-spec.md`, `specs/tasks-spec.md` — the product requirements. Where a mock and the spec disagree on behavior, the spec wins; on visuals, the mock wins.
