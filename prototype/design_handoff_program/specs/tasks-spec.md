# Program — Spec Addendum: Tasks (Create, Edit, Assign)

**Version:** 1.0 (draft for review)
**Status:** Expands §4.8 of the Program spec into a full feature specification. Competitive input: SessionBoard Portals — task assignment, personalized tasks, file requests, task tracking.
**Slots into:** replaces the "Task templates / Task types / Speaker view / Organizer dashboard" bullets of §4.8; §§4.8.x numbering below assumes that placement.

---

## Design stance

SessionBoard's task system is genuinely good — it is the strongest part of their Portals product — and it is also a tour of what happens without discipline: tasks, file requests, portal forms, and wiki pages are four separate modules with four creation flows; tasks are created in one place and assigned in another via an "Edit Tasks" widget; per-portal aliases exist because the same task object is shared across portals; and their own help center has an article titled *"Why can't a portal user see any tasks assigned to them?"* (answer: the portal username and the communication email are different fields that don't sync).

Our version keeps their best ideas — session-scoped tasks, personalized descriptions and links, due dates with extensions, lock-on-complete, filter-based assignment, a lightweight file review loop — and rejects the module sprawl. **One task system, four task types, one assignment mechanism (rules + manual), living inside the speaker portal that magic-link auth already makes impossible to get locked out of.**

---

## 4.8.1 Model

```
Event
├── Task Template  (event-level; the reusable definition)
│     └── Assignment Rule  (trigger + optional filter clauses)
└── Task  (an instance: template × target, with its own state)
      ├── target: Speaker (per-event speaker profile)  — "upload your headshot"
      │       or Session                               — "upload the slides for this talk"
      └── state, due date, completions, file versions, activity
```

- **Template vs. instance.** Organizers author **task templates**; the system stamps out **task instances** when a rule fires or an organizer assigns manually. Editing a template updates future instances only; existing instances can be bulk-updated explicitly (never silently — speakers may have already acted on the old wording).
- **Two targets, settled per template:**
  - **Speaker tasks** attach to a person's per-event speaker profile. One instance per speaker. ("Confirm participation," "Complete profile," "Travel details.")
  - **Session tasks** attach to a session. One instance per session; it appears in the portal of **every co-speaker**, any of whom can complete it, and it completes once for the session. ("Upload slides," "AV requirements.") There is one deck per talk, not one per co-speaker, which kills the co-speaker duplication problem SessionBoard solves with session-type tasks.
- A speaker's portal checklist is the merge of their speaker tasks and their sessions' tasks, grouped by session where applicable.

## 4.8.2 Task types (unchanged four, one addition to Checkbox)

| Type | Completion | Notes |
|---|---|---|
| **Checkbox** | Speaker marks done | Now carries an **optional link** (personalizable, §4.8.4) — covers SessionBoard's "task with URL" pattern (visit the A/V portal, book your hotel). Honest caveat surfaced in the UI we borrow from their docs: an external action can't auto-complete the task; the speaker checks it off. |
| **File request** | Upload (+ optional review, §4.8.6) | Extension whitelist, size cap, versioned re-uploads with history (existing upload pipeline: signed direct-to-storage, virus scan, content sniff). Optional **sample/template file** attached by the organizer ("use this slide template"). One logical file per request; "upload 3 photos" is a max-count setting, not three tasks. |
| **Form** | Submit the mini-form | Reuses the form engine (fields, validation, conditional logic). Travel info, dietary needs, session-detail confirmations. |
| **Profile completion** | Auto-completes | Completes itself when the required profile fields are filled. The only self-completing type. |

Deliberately not types: wiki/resource pages (that's the portal's static content area, not a task), payments, e-signatures (a file request for a signed PDF covers the real cases), approvals-of-other-people's-tasks.

## 4.8.3 Creating & editing templates

Template fields: **name** · **description** (rich-lite: bold/links/lists) · **type + type settings** (per table above) · **target** (speaker/session) · **required?** · **due date** (relative: *N days after assignment* or *N days before event start*; or absolute) · **assignment rule** (§4.8.5) · **reminder schedule** (inherits event defaults; overridable).

- **Personalization via template variables, not a parallel mechanism.** Description and link fields accept the same variables as email templates — `{{speaker_name}}`, `{{session_title}}`, `{{session_slot}}`, plus any custom submission/profile field by reference. This is SessionBoard's "Use Field" feature ("personalized tasks") implemented with machinery we already have. A task link like `https://av-portal.example.com/?talk={{session_id}}` gives every speaker a unique URL from one template.
- **Editing safety mirrors form versioning in spirit, lighter in mechanism:** templates aren't versioned (overkill), but editing a template with live instances prompts: *apply to future assignments only* (default) or *also update N open instances* (completed instances never change). Every applied change lands in the activity log.
- **No aliases.** SessionBoard needs per-portal display aliases because one task object serves many portals. Our templates are per-event; the name is the name. Event duplication (§4.1) clones task templates, which covers reuse.
- Templates can be **archived** (stop assigning; history intact), never hard-deleted while instances exist.

## 4.8.4 Due dates, extensions & the required flag

- **Due date** computed per instance at assignment from the template's relative rule; organizer can override per instance (and per instance only — one speaker's extension isn't a policy change).
- **Grace period (SessionBoard's "extended due date," simplified):** optional *N days* on the template. Past due, the task shows **Overdue** to speaker and organizer but stays completable through the grace period; after it, submission locks and the portal shows "contact the organizers." Default: no lock — for most content jobs a late deck beats no deck; hard-locking is for things like program-guide print deadlines.
- **Required** tasks sort first, are badged, and drive the portal's "3 of 5 required tasks done" summary. Optional tasks never trigger overdue nags.
- **Lock on complete** (per template, default off): once complete (or approved, §4.8.6), the speaker can no longer change or re-upload — for legal documents and final print assets. Otherwise speakers may self-serve corrections until the due date; that's a feature.

## 4.8.5 Assignment

One mechanism, three entry points — no separate "assign to portal" step. If a speaker has a task, it is in their portal; magic-link auth means there is no portal-access state to desynchronize.

1. **Automatic (rules).** Each template has a trigger — **on acceptance** or **on confirmation** (default: confirmation, per §3.1 — tasks generate when the speaker commits) — plus optional **filter clauses** using the same clause machinery as conditional logic and category routing (§4.2): *Format = Workshop → "AV requirements"*; *Track = Keynote → "Extended bio."* Filters may reference categories and form answers. This is SessionBoard's assign-by filter without their three-filter cap or its confinement to session tasks.
2. **Manual.** From any speaker/session detail view: assign any template, or a **one-off task** (same fields, no template, not reusable) for the exceptions — "Maria: re-record your intro video."
3. **Bulk.** From the submissions/speakers table, assign a template to any filtered selection. Assignment preview ("this will create 34 tasks") before commit, consistent with the decision-email confirmation pattern (§4.7).

Rules are evaluated on state change only (accept/confirm), not retroactively on rule edit; a rule edit offers an explicit "apply to existing matching speakers/sessions" action with the same preview. De-assignment: organizer removes an instance (logged); withdrawal (§3.1) auto-cancels the speaker's open tasks.

## 4.8.6 File review (lightweight, opt-in)

Per file-request template: **"requires review"** toggle (default off).

- Off: upload → **Complete**. Organizers spot-check via dashboard and ZIP export.
- On: upload → **Pending review**. Organizer, from dashboard or task detail: **Approve** (→ Complete; locks if lock-on-complete) or **Request changes** with a required short message → task returns to **Open**, speaker is **notified by email** with the message, re-upload versions the file. (SessionBoard denies silently — "a notification is not sent to the contact" — and tells admins to chase people manually. We will not ship a rejection that doesn't notify.)

That's the whole state machine: Open → (Pending review) → Complete. No deny-vs-revert distinction, no resubmission threads — the changes-requested message plus internal comments (§4.5) cover discussion.

## 4.8.7 Speaker experience (portal)

- **Checklist**, required-first then by due date; per-session grouping for session tasks; progress summary; overdue badging. Statuses a human can read — **To do / Pending review / Done / Overdue** — not an icon legend.
- Each task: description (variables resolved), link, sample file, uploader/form inline, file version history.
- Session tasks show which co-speaker completed them ("Slides uploaded by Maria ✓").
- Mobile priority 3 (§5.2): the checklist and file-upload-from-camera-roll must be excellent on phones.
- Task-related email (assignment digest, reminders, changes-requested, deadline nags) uses templates from the §4.7 library, themed per §4.12, logged in the email log.

## 4.8.8 Organizer tracking (the dashboard, restated)

- **Grid: speakers × task templates** (session tasks roll up to their speakers), cells = To do / Pending review / Done / Overdue; filterable by track, form, session status, template, status; sortable by completion %. Equivalent view pivoted by session.
- **Bulk reminders from the dashboard** by any filter — replaces SessionBoard's pattern of bolting task-reporting fields onto module views; the dashboard *is* the report.
- Counts surface on the event overview ("14 speakers have overdue required tasks").
- **Organizer override:** mark any task complete/incomplete on behalf of a speaker (logged with actor) — for the keynote speaker who emailed the deck instead. Organizers can also upload a file *into* a speaker's file request (versioned, attributed to the organizer).
- Every task event — assigned, completed, approved, changes requested, due-date changed, overridden — lands in the activity log (§4.5); CSV export of the grid, per the export-everywhere rule.
- **Bulk content retrieval** as specced: one-click ZIPs of slides by day/room, headshots, or all files for a filtered set.

## 4.8.9 Cut from SessionBoard's task system (add to §6 citations)

Per-portal task **aliases** · separate **File Requests / Forms / Wiki** modules (one task system; portal static content is theming's job) · portal-access grants and portal usernames as a distinct auth surface (magic links) · task-reporting fields on other modules' views (the dashboard is the report) · five-icon status legend · silent denial · approval workflows beyond the single review toggle · tasks for sponsor/exhibitor **groups** (we have no exhibitor management; sponsor-session contacts are speakers/submitters like anyone else) · manual task ordering (required-first + due date is the order).

---

## Phasing (amends §7)

Unchanged in substance — tasks remain Phase 2. Suggested slicing within Phase 2: **2a** — templates, checkbox + file request (no review), rule/manual/bulk assignment, portal checklist, reminders; **2b** — form and profile-completion types, review toggle, dashboard grid + bulk reminders, grace periods, lock-on-complete, ZIP retrieval, organizer override. One-off tasks and organizer file upload-on-behalf can trail into Phase 3 without hurting the story.

## Open questions (append to §8)

7. **Trigger default:** tasks on *confirmation* by default (proposed) — but "Confirm participation" itself is naturally an on-*acceptance* task. Ship both triggers with confirmation as the template default, and make the built-in confirm-participation template the documented exception?
8. **Session tasks after speaker changes:** if a session's only speaker is swapped, open session tasks follow the session (proposed: yes — they're the session's tasks; new speaker sees them, activity log records the handoff).
9. **Grace-period visibility:** does the speaker see the real due date only, or "due X, accepted until Y"? (Proposed: real due date only; the grace period is the organizer's slack, not a second deadline to procrastinate toward.)
10. **Pending-review and the Confirmed gate:** does an unapproved headshot block "hide unconfirmed speakers" publication logic? (Proposed: no — publication gates on Confirmed state only; content readiness is the dashboard's job.)

---

*End of addendum. Merge target: spec v1.1, replacing the §4.8 bullets and appending §6/§7/§8 items as noted.*
