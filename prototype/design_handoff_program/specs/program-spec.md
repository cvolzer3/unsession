# Program — Product Specification

**Version:** 1.0 (draft for review)
**Status:** Consolidated from planning discussions + competitive research (SessionBoard Program, Sessionize)
**Scope:** A focused, fast, self-serve speaker & session management product for conference organizers.

---

## 1. Vision & Positioning

A simpler, faster alternative to SessionBoard's Program product, with slightly more workflow depth than Sessionize. It covers the complete speaker content lifecycle — call for speakers → evaluation → acceptance → speaker onboarding → agenda → publication — and deliberately nothing else.

**Strategic positioning (the three bets):**

1. **Speed as a feature.** Every page loads fast, every table scrolls smoothly at 1,000+ submissions, the public agenda is CDN-cached. "No slow shit" is a product requirement, not an aspiration. Performance is mostly architectural discipline: server-rendered pages, one fast Postgres, background jobs for all email, aggressive caching on public surfaces, and refusing to build the features that make apps slow.
2. **Focus as a feature.** No CRM, no marketing suite, no media library, no AI agents. SessionBoard's own demo presenter could not find the submission form in his product. Our cut list (§6) is a permanent artifact, not a backlog.
3. **Instant self-serve.** No "Request a Demo." A "Try it" button provisions a sandbox pre-seeded with a realistic event mid-lifecycle, so the product demos itself in thirty seconds (§4.13).

**Primary success metric intuition:** an organizer can go from signup to a live, branded, conditional CFP form with a shareable public link in under 15 minutes without talking to anyone.

---

## 2. Users & Roles

| Role | Who they are | Primary surfaces |
|---|---|---|
| **Owner/Admin** | Head of program/content for the event | Full admin: event setup, forms, decisions, agenda, publishing, team management |
| **Collaborator** | Team member helping run the program | Admin minus billing/team/destructive settings (configurable per event) |
| **Evaluator** | Reviewer assigned to score submissions | Evaluation queue only; sees only assigned plans; per-field visibility respected |
| **Submitter / Speaker** | Person proposing or delivering a session | Public form; speaker portal (submissions, statuses, tasks, profile, calendar) |
| **Attendee (anonymous)** | Public visiting the agenda | Hosted agenda page, embeds. **No accounts.** |

Team size is unlimited. Roles are per-event. Form-level admin assignment (who gets notified / can edit a given form) is supported per the original notes.

---

## 3. Domain Model

```
Organization
└── Event  (timezone, dates, branding/theme, task templates, categories)
    ├── Category taxonomies  (track, format, level, audience, custom)
    ├── Form (versioned)  ──<  Submission  ──<  Answers
    │                             │
    │                             ├── belongs to Submitter(s) (speaker accounts)
    │                             ├── Internal comments, activity log entries
    │                             └── Evaluations (via Evaluation Plan)
    ├── Evaluation Plan  (scope, evaluators, rubric, settings)
    ├── Session  (created from accepted Submission, OR directly: sponsor/service)
    │     ├── Speaker Profiles (per-event)
    │     └── Tasks (from task templates)
    ├── Agenda  (days → time slots → rooms/tracks → placed Sessions)
    └── Published surfaces  (hosted agenda page, embeds, JSON endpoint)
```

**Key modeling decisions (settled):**

- **Session ≠ Submission.** A Session is created by copying an accepted Submission's content. Organizers can edit sessions for publication without corrupting the submission and its review history. Sponsor and service sessions are Sessions created directly, skipping the pipeline.
- **Categories are first-class, event-level taxonomies** referenced by forms and reused for evaluation routing, table filtering, agenda coloring, and public agenda filtering. One definition, five payoffs.
- **Speaker profiles are per-event** (not global). Simpler, avoids cross-event data leakage. Cross-event convenience is achieved via "duplicate event," not a CRM. Revisit only with real demand.
- **Multiple forms per event: yes.** Cheap if modeled from day one (e.g., main CFP + workshop CFP + sponsor intake). Each form has its own settings, admins, versioning.
- **Co-speakers: yes.** A submission has 1–N speakers; forms can cap co-speaker count. Fixed speaker fields repeat per speaker.
- **Event timezone is explicit and stored from day one.** All times stored as UTC + event timezone; public surfaces can display in viewer-local time.

### 3.1 Submission Lifecycle

```
Draft → Submitted → In Review → Accepted → Confirmed
                              → Declined
                              → Waitlisted
        (any post-submit state) → Withdrawn
```

- **Draft:** autosaved, soft validation only. Optional per form (allow-drafts toggle).
- **Submitted:** hard validation passed; confirmation email + post-submit message ("chance for joy").
- **In Review:** entered automatically when included in an active evaluation plan.
- **Accepted / Declined / Waitlisted:** organizer decision, individually or in bulk, with templated (per-send editable) decision emails. Decline emails support optional individual feedback.
- **Confirmed:** speaker explicitly confirms participation from the portal or decision email. This state gates public agenda display ("hide unconfirmed speakers") and triggers task generation.
- **Withdrawn:** formal speaker-initiated withdrawal procedure from the portal; notifies form admins; removes session from agenda with a conflict-free warning if already scheduled.

---

## 4. Feature Specification

### 4.1 Event Setup

Creating an event captures: name, slug (drives all public URLs, e.g. `app.com/devconf-2027`), dates, venue/online/hybrid flag, timezone (required), rooms, description, and theme (§4.12). Rooms and days can be edited later; the agenda builder derives its grid from them.

- **Event duplication** ("run it again"): clones structure — forms (as new versions with zero submissions), categories, task templates, evaluation plan templates, rooms, theme, email templates — never submissions or people. This is the answer to recurring-organizer needs and to SessionBoard's "Abstract Management" concept: reusable structure without a CRM.
- **Form templates:** any form can be saved as an org-level template and instantiated into future events.

### 4.2 Categories

Event-level taxonomies: **Track**, **Format**, and **Level** are provided as defaults; organizers can rename, remove, or add custom taxonomies (e.g., Audience, Region). Each taxonomy has ordered options with an optional color (used for agenda coloring).

Categories power:
1. Form fields (single/multi select bound to a taxonomy — answers stored as structured references, not free text).
2. **Category-based routing:** rules like "Track = AI → assign to Evaluation Plan: AI Reviewers" and "Format = Workshop → notify workshop chairs." Same clause machinery as conditional logic; different action.
3. Submissions table filters and saved views.
4. Agenda color coding and the public agenda's track filter.

### 4.3 Form Builder

The keystone component. One JSON schema per form version drives the builder, the public renderer, client-side validation, and server-side validation (single source of truth, validated twice — the server is the real gate).

#### 4.3.1 Fixed core fields (always present, always structured)

- Session: **title**, **abstract**, **format** (bound to the Format taxonomy).
- Per speaker: **name**, **email**, **bio**, **headshot**.

These stay fixed so review UI, sessions, agenda, and embeds rely on them with zero field-mapping.

#### 4.3.2 Custom field types

| Type | Validation options | Notes |
|---|---|---|
| Short text | min/max chars | |
| Long text | max chars and/or **max words**, live counter | Word limits are the CFP convention |
| Email | format | correct mobile keyboard |
| URL | format | auto-prepends `https://` on blur |
| Phone | light length/charset only | strict intl validation rejects real numbers |
| Number | integer/decimal, min/max | |
| Single select | required | radios ≤5 options, dropdown >5; paste-as-lines; country & timezone presets; may bind to a category taxonomy |
| Multi select | min/max selections | checkboxes; may bind to a taxonomy |
| Yes/no checkbox | "must be checked" mode | consent / code-of-conduct |
| Date | min/max | native pickers |
| File upload | extension whitelist, size cap, max count | direct-to-storage signed upload, virus scan, content-sniffed type check; attached only after validation |
| Section header + description | — | display-only; basic formatting + links; can carry a visibility condition for its whole group |

Explicitly excluded: signature, payment, matrix/grid, rating-scale fields.

#### 4.3.3 Per-field flags (applies to core and custom fields)

- **Visible on public agenda?** (drives what the published session shows)
- **Editable by speaker post-acceptance?** (locked vs. speaker-editable)
- **Visible to evaluators?** (hiding speaker-identifying fields = blind review for free)

#### 4.3.4 Conditional logic

- One **visibility rule** per field/section: "Show when [clauses]", clauses joined by ALL or ANY (no nested groups).
- Clause = source field + operator + value. Operators: is / is not (selects, checkbox); contains / does not contain (multi-select); is answered / is blank (any); greater/less than (numbers).
- **Load-bearing constraint: conditions may only reference fields earlier in the form.** Eliminates cycles, keeps evaluation a single top-down pass, keeps the builder simple.
- **Conditionally required** as a second slot with the same clause structure ("AV needs required when Format = Workshop").
- **Hidden-field hygiene:** hidden values are kept in drafts (toggling back doesn't destroy typed work) but stripped at submit and skipped by validation; the **server re-evaluates all conditions against the submitted payload** so hidden/required states can't be spoofed.
- Excluded: page-jump branching, calculated fields, answer piping, submitter-metadata conditions.

#### 4.3.5 Form settings (per form)

Open/close dates (opens and closes automatically) · submission limit per person · co-speaker limit per session · allow-drafts toggle · reminder schedule (to unsubmitted drafts) · thank-you email · post-submit message (designed as a moment of joy, with an optional shareable "I submitted to X" card) · assigned form admins (notified per submission; can edit form) · email notification on each submission · optional public list of submitted sessions (community-event mode) · **secret late-submission link** (bypasses close date for invited speakers) · controlled post-deadline editing (organizer unlocks specific submissions/fields).

#### 4.3.6 Robustness architecture

- **Stable field IDs** (immutable at creation; labels are display text only).
- **Form versioning:** first submission freezes the version; edits create a new version; every submission pins its version. Fields with data are archived (hidden from new submitters, visible on old submissions), never destroyed.
- **Drafts validate softly; submit validates hard**, with an error summary at top, inline errors, and scroll-to-first-error.
- **Preview mode** renders the live form inside the builder so organizers can flip answers and watch conditions fire — they debug themselves.

### 4.4 Public Submission Experience & Speaker Accounts

- Public link per form: `app.com/{event-slug}/{form-slug}` — themed (§4.12), fast, genuinely mobile-first (§5.2).
- **Magic-link email auth. No passwords.** Account auto-created on first draft. Speakers submit once a year and will never remember a password.
- **Agent mode:** "I'm submitting on behalf of someone else" — the assistant's email manages the submission; the speaker's email receives speaker-facing communications. Organizers can also create submissions on behalf of anyone (invited keynotes).
- Autosave with a visible sticky indicator; long forms navigable via section headers.
- Post-submit: confirmation page (post-submit message) + confirmation email.

**Speaker portal** (logged in): all my submissions with live status · editable drafts · my tasks (§4.8) · my profile · session details incl. schedule slot with **Add to Calendar** · withdrawal procedure.

### 4.5 Submissions Management (Organizer)

- **The table:** fast at 1,000+ rows (keyset pagination, virtualized). Columns configurable; filter by status, form, any category, evaluator progress, task completion, any custom field; full-text search; saved views.
- **Inline editing** of session fields directly in the list; full detail drawer per submission.
- **Bulk operations (Phase 1, not a nicety):** change status, assign to evaluation plan, add/remove category values, send templated email, mark informed, export selection.
- **Internal comments** on every submission: team-only thread with @-mentions (mention → notification). "She was great last year," "possible keynote?"
- **Activity log** per submission/session: every status change, edit (with before/after), email sent, evaluation completed — who and when. The answer to "did anyone tell this speaker their talk moved?"
- **CSV export everywhere** a table exists (Phase 1 — organizers won't trust a system they can't get data out of).
- Bulk submission **import** from CSV (map columns → fields) to migrate from spreadsheets or a prior tool.

### 4.6 Evaluation

**Evaluation Plan** = scope (filter by form/category/tag) + evaluators + rubric + settings.

- **Rubric:** 1–5 stars across a few named criteria + comment box. **Yes/no mode** = single-criterion variant. (Side-by-side comparison mode: deliberate fast-follow, not v1 — it is loved in the market but adds real complexity.)
- **Assignment:** everyone-evaluates-everything, or per-submission assignment, with optional **per-evaluator caps** (burnout control, fair distribution) and auto-balancing.
- **Category routing** auto-assigns incoming submissions to the right plan (§4.2).
- **Evaluator experience:** a queue ("12 of 40 done"), keyboard-friendly scoring, respects per-field evaluator visibility (blind review), cannot see others' scores before submitting their own (toggle).
- **Organizer view:** score averages + distribution per submission, sortable; evaluator progress dashboard; **reviewer reminders** (automated nags for incomplete scores); stats export.
- Deliberately excluded: multi-round review, weighted criteria, score normalization, conflict-of-interest declarations.

### 4.7 Decisions & Communication

- **Decision flow:** from the table (single or bulk) choose Accept / Decline / Waitlist → templated email with per-send editing → preview + explicit confirmation showing exactly who receives what. This is the emotionally heaviest email an organizer sends; the flow must feel safe.
- Decline emails support **optional individual feedback** per recipient.
- Accept emails request **confirmation** (→ Confirmed state).
- **Templates:** organizer-editable library (accept, decline, waitlist, reminder, task nag, schedule notice) with variables ({{speaker_name}}, {{session_title}}, {{slot_time}}...). Themed layout (§4.12); layout HTML is not organizer-editable (deliverability).
- **Group mailings** to any filtered set (e.g., all Confirmed workshop speakers).
- **Reminders (automated):** CFP-closing reminders to unsubmitted drafts · task deadline nags · reviewer reminders — each schedulable and per-form/plan configurable.
- **Calendar invites:** when a session is scheduled or its time/room changes, the speaker receives an email with a standards-compliant **.ics** invite (works natively in Gmail, Outlook, Apple Calendar — no OAuth integrations). METHOD:REQUEST with sequence bumps on updates and CANCEL on unscheduling. Portal shows an Add-to-Calendar button; optional per-speaker ICS feed URL.
- **Email log:** searchable record of every email the system sent (recipient, template, timestamp, delivery status), linked from each submission's activity log.

### 4.8 Speakers, Tasks & Onboarding

- **Speaker profile (per-event):** name, email, bio, headshot, plus organizer-defined custom profile fields. Per-field speaker-editability flags apply. Directory preview shows profiles exactly as they'll appear publicly before publishing.
- **Task templates (event-level):** e.g., Confirm participation · Complete profile · Upload headshot · Upload slides · AV requirements · Travel details. Applied automatically on acceptance/confirmation (configurable trigger), with due dates relative to acceptance or to event date.
- **Task types:**
  1. **Checkbox** (acknowledge/complete)
  2. **File request** (typed, size-capped, versioned — re-upload replaces with history)
  3. **Form** (a mini custom form: e.g., travel info, dietary needs — reuses the form engine)
  4. **Profile completion** (auto-completes when required profile fields are filled)
- **Speaker view:** checklist in the portal with due dates and status.
- **Organizer dashboard (spec feature #6):** real-time grid of speakers × tasks — complete / pending / overdue — filterable by track, form, session status. **Bulk reminders** triggered from the dashboard by task completion, session status, or deadline proximity.
- **Bulk content retrieval:** one-click ZIP downloads — all slides (organized by day/room), all headshots, all files for a filtered set. The organizer's "get every deck to the AV booth" job is a button, not an afternoon.

### 4.9 Sessions

Created three ways:
1. **From an accepted submission** (copies content; keeps a link back to the submission and its review history).
2. **Directly — sponsor sessions:** guaranteed slots that skip the pipeline; flagged `sponsored` (optional public badge).
3. **Directly — service sessions:** registration, lunches, coffee breaks, keynote intros. No speaker, no submission; can span all rooms. Every real agenda is half non-talk blocks; without these the published schedule looks broken.

Session fields: title, abstract, format, track/categories, speakers, room, slot, duration, publish flag, plus custom fields inherited from the submission. Per-field public-visibility flags govern what the agenda shows. Optional per-session or per-room **live stream / recording links** (hybrid events) — plain URL fields, no player integration.

### 4.10 Agenda Builder

- **Model:** days → time slots → rooms. Grid derived from event setup; slot granularity configurable.
- **Builder UX:** bin of unscheduled sessions → drag-and-drop into the grid; track color coding; quick-edit session cards in place (no losing your spot); session status indicators (confirmed / pending / draft) at a glance.
- **Conflict detection (never-forgive-a-miss feature):**
  - Same speaker in two places at once (across rooms and co-speakers)
  - Double-booked room
  - Session placed outside event days/hours
  - Warning (not block) with a collision preview before drop lands.
- **Views (spec feature #5):** the same schedule pivoted as **grid by day×room** (builder default), **list**, **by day**, **by track**, **by room**. Week view appears automatically for multi-day events. Public agenda gets list + day + track at minimum (list is what phones want).
- **Publishing controls:** per-session publish flag + event-level toggle (partial early publishing); **hide-unconfirmed-speakers** logic keeps placeholders off the public page (driven by the Confirmed state).

### 4.11 Publishing: Public Page, Embeds, API

- **Hosted agenda page:** `app.com/{event-slug}/agenda`. Fast, clean, mobile-first (attendees read agendas standing in hallways). Filters by day/track/room; session detail pages with speaker profiles; viewer-local timezone toggle. Statically generated + CDN-cached, revalidated on edit.
- **Embed:** iframe with transparent-background option so the agenda sits visually inside the host site. Real-time (reflects published changes without re-embedding).
- **Read-only JSON endpoint** of the published agenda for custom builds. (Plain-text schedule export for mailings/announcements: fast-follow.)
- **Local favorites (fast-follow, not v1):** browser-local "my schedule" starring on the public page — most of the attendee-app value with zero accounts.

### 4.12 Theming

**Themed:** every external surface — submission form, confirmation page, speaker portal, public agenda, embeds, all outbound email. **Never themed:** the admin.

Tokens: logo · primary color · accent color · page background · font from a curated list (~8 pairings). **No custom CSS** (permanent support tax; breaks on every UI change we ship).

Robustness details that make "basic" feel professional:
- **Automatic contrast enforcement:** system computes accessible text/hover colors from chosen brand colors; branded never means unreadable.
- **Derived states:** hover, focus, borders auto-generated from primary — one color in, coherent palette out.
- Email: logo + accent applied to a fixed, deliverability-tested layout.
- **Custom domains (cfp.theirconf.com): later**, not v1. Branded slugs cover launch.

### 4.13 Demo Sandbox (Top-of-Funnel)

"Try it" provisions a sandbox org with a realistic event **mid-lifecycle**: ~60 fake submissions across all states, evaluations half-done, a partially built agenda with conflicts to resolve, pending speaker tasks, themed public page. Every screen has data; the product demos itself in thirty seconds. Sign up to claim the sandbox or start clean. Treated as a launch feature, not polish.

---

## 5. Cross-Cutting Requirements

### 5.1 Performance ("no slow shit")

- Server-rendered pages; interactive islands only where needed (builder, agenda drag-and-drop).
- Submissions table: keyset pagination + virtualization; smooth at 1,000+ rows.
- All email via background jobs; nothing user-facing waits on SMTP.
- Public agenda: static generation + CDN cache, revalidate on edit.
- Budget intuition: admin pages interactive < 1s on decent connections; public pages near-instant globally.

### 5.2 Mobile (responsive web; no native app)

Priority order by real traffic:
1. **Submission form** — genuinely designed for phones: single column, correct native input types/keyboards, big touch targets, file upload from camera roll, sticky autosave indicator, navigable sections.
2. **Public agenda** — hallway-usable: list-first, fast, day/track filters thumb-reachable.
3. **Speaker portal** — task checklist and status checks from anywhere.
4. **Organizer admin** — responsive and usable (checking submission counts from bed) but designed desktop-first.
5. **Form builder** — desktop-only-ish by design; nobody builds a 20-field conditional form on a phone.

### 5.3 Trust, Security & Privacy

- Magic-link auth for speakers; standard email+password/SSO-later for organizers; role-based access per §2.
- Per-field evaluator-visibility respected server-side (blind review can't be defeated by API calls).
- Uploads: signed direct-to-storage, virus-scanned, content-sniffed; attached only after validation.
- Data ownership: CSV export everywhere; full-event export; email log; change history. "It's your data" as a stated principle.
- Deliverability: SPF/DKIM-correct sending domain; per-event reply-to; suppression list handling.
- GDPR posture from day one: delete-speaker-data workflow, consent checkbox support on forms (the "must be checked" mode exists for this).

### 5.4 Timezones

Event timezone required at creation. Times stored UTC + event TZ. Admin shows event time; public surfaces offer viewer-local display; ICS invites carry proper TZID. Retrofits here are misery — day-one architecture.

---

## 6. Non-Goals (Permanent Cut List)

Write-once, cite-forever. Every one of these will be requested.

- Speaker **CRM** / cross-event speaker database ("duplicate event" + form templates cover the real recurring-organizer job)
- Marketing suite, media library, content repurposing, transcription, awards, ePosters
- AI evaluators / AI agents
- **Payments** of any kind
- Attendee **accounts** (public agenda is anonymous; local favorites fast-follow)
- Native mobile app
- Custom CSS; white-label beyond theme tokens
- Page-jump branching, calculated fields, answer piping in forms
- Multi-round review, weighted criteria, score normalization, COI declarations
- Multi-language UI (English only)
- Integrations marketplace (JSON API + CSV are the integration story)

---

## 7. Build Phases

### Phase 1 — The core loop, shippable alone
Event setup (incl. timezone, rooms, categories) · form builder with fixed core + all field types + validation architecture + **conditional logic** + versioning + preview · public form + magic-link accounts + drafts/autosave · submissions table (fast) + inline edit + internal comments + activity log + **bulk status ops** + **CSV export/import** · manual accept/decline/waitlist with safe decision-email flow + confirmation loop · sessions (incl. **service sessions**) · agenda builder with conflict detection + day/list views · hosted public agenda (themed, cached) · theming tokens · email log.

### Phase 2 — The team and the speakers
Evaluation plans (rubric + yes/no, assignment, caps, blind-review field flags, reviewer reminders, category **routing**) · tasks (all four types) + speaker portal + onboarding **dashboard** + bulk reminders · **calendar invites (.ics)** · bulk file **ZIP downloads** · per-field visibility/editability flags (full) · sponsor sessions · reminder automations · secret late-link, agent mode, post-deadline editing, withdrawal flow · track/room agenda views · iframe embed · **demo sandbox** · group mailings.

### Phase 3 — Recurring use & fast-follows
Event duplication + form templates · JSON API · side-by-side **comparison evaluation** · local favorites on public agenda · plain-text schedule export · agenda versioning · optional public submissions list · saved table views polish · org-level template library.

**Sequencing rationale:** Phase 1 alone replaces "Google Form + spreadsheet + dread." Phase 2 makes it a SessionBoard-Program replacement. Phase 3 makes year two effortless.

---

## 8. Open Questions

1. **Product name & licensing.** The brief says "open source clone that you make (and keep)" — pick a license (AGPL vs. MIT + hosted offering?) and decide what "keep" means for the hosted vs. self-hosted split. This shapes auth, email, and storage abstraction choices.
2. **Evaluation anonymity default:** blind review off by default (toggle per plan) — confirm.
3. **Waitlist mechanics:** does promoting from waitlist re-trigger the accept email flow? (Proposed: yes, identical flow.)
4. **Submission cap semantics with co-speakers:** does a co-speaker slot count against a person's submission limit? (Proposed: no — only submissions they own.)
5. **How much of the session detail page is customizable** on the public agenda before it becomes a page builder? (Proposed: field visibility flags only; no layout control.)
6. **Sandbox data refresh:** does the demo sandbox reset nightly, or persist until claimed? (Proposed: persist 7 days, then reset.)

---

*End of spec v1.0. Next steps: settle §8, then detail the form-schema JSON and the database schema as engineering appendices.*
