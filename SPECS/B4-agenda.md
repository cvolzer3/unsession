# Spec B4 — Sessions, agenda builder, public agenda, speaker pages, ICS

Read `SPECS/B-shared.md` first. Prototypes: `design/Sessions.dc.html`, `design/Agenda Builder.dc.html`, `design/Agenda.dc.html`, `design/Speaker Profile.dc.html`. Your files per ownership map. `src/lib/sessions-core.ts` exists (createSessionFromSubmission); extend it if needed.

## `/app/sessions`

Port `Sessions.dc.html`:
1. Table: ID (#seq or SP-/SV- prefix for sponsor/service) / SESSION (title+speakers, abstract line via prop) / TRACK / TYPE select (format options; inline persist + duration sync) / SLOT duration select / ROOM select (amber border when unassigned; assigning room ≠ scheduling) / STATUS badge (Scheduled Day N · time | Ready for agenda | Needs room). Chips All/Needs room/Ready/Scheduled with counts, track filter, search. Row → edit drawer (port: ON AGENDA banner with slot when scheduled, title/abstract/track/level/type/duration/room, speakers cards read-only, Save → persist + toast "Saved — synced to agenda and public pages").
2. **"＋ New session" button (header)** → dialog: type select **Sponsor | Service**; sponsor: title, sponsor company name, abstract, track, format/duration, optional speaker (name/email/bio → speaker_profile), SPONSORED badge preview; service: title (Registration/Coffee/Lunch presets + custom), duration, spans-all-rooms checkbox (default on). Creates session rows (`type`, `sponsor_name`, `all_rooms`). Talk sessions cannot be created here (they come from accepted submissions) — note in dialog footer.
3. Sessions list includes sponsor/service sessions (they were missing from the prototype's list — include, filterable).

## `/app/agenda` — the builder

Port `Agenda Builder.dc.html` (read its full template incl. lines 1–300):
1. Left rail: **unscheduled bin** (accepted/confirmed sessions with no day/start) — card: title, speakers, track edge, duration, status mono chip; draggable; "Schedule" affordance in list view opens the schedule dialog.
2. Views: **Rooms** (default; columns per room, layout toggle cols/lanes), **Day**, **Week**, **List** — port geometry exactly (K=1.3 px/min vertical, KB=1.75 horizontal, day 08:30–18:00 grid, hour lines, 15-min snap, drag ghost with time label, service blocks spanning all rooms as gray bands, sponsor blocks tinted `#fff4e6`).
3. Drag-drop: bin→grid places (creates schedule: day/start/end/room), grid→grid moves, grid→bin unschedules. **Conflict detection** exactly as prototype (`conflicts()`): same room overlap, same speaker two places (across co-speakers), runs past day end — amber warning panel "Placed with conflicts" with per-message list + **Undo** (restore snapshot) + Replace (keep). Conflicted blocks tinted `#fdecec` with red border persistently (recompute on render). Warn, never block.
4. Selection cards (fixed bottom-right): talk card (title, meta, speakers, day toggle, start select, room select, "Back to bin", **Quick edit** now REAL: inline title input + publish-flag checkbox + save), service card (title input, day toggle, start/end selects, Copy to other day, Delete). "＋ Service block" creates + selects. "＋ Sponsor session" opens the same dialog as Sessions' New session (sponsor pre-selected).
5. **Publish** button: sets event.published=1, bumps a `published_rev` (add tiny migration or reuse counters), purges public agenda cache, toast "Published — public agenda updated". Show "Unpublished changes" dot when any session.updated_at > last publish (cheap check).
6. Persistence: every placement/move/unschedule → `POST /app/api/agenda/place` etc. immediately (optimistic UI, revert on error).
7. Day tabs from event start/end dates (support 1–5 days; label "Day N · Mon DD").

## Public `/{event}/agenda` (+ `/{event}` → redirect here)

Port `Agenda.dc.html`:
1. Views LIST/DAY/WEEK(multi-day only)/TRACK/ROOMS; day tabs; track chips (colors from taxonomy); search in list; sortable list headers; session detail popover (track chip, SPONSORED badge, time/day/room meta, abstract, speaker links); tz toggle EVENT TIME ↔ YOUR TIME (client JS converts using event tz + viewer tz, relabels button; times re-render client-side).
2. Content = sessions where `published=1 AND (status='confirmed' OR type != 'talk')` when event.hide_unconfirmed, all published otherwise; only when event.published. Unpublished event → tasteful "agenda not published yet" page.
3. Cache: `Cache-Control: public, max-age=60` + Cache API keyed by URL+published_rev; purge on publish (delete keys or vary by rev — simplest: include rev in an internal cache key).
4. `/{event}/agenda.json`: read-only JSON of published agenda (sessions with public fields only).

## `/{event}/speakers/{slug}` (`public-speaker.tsx`)

Port `Speaker Profile.dc.html` minus the dev top-bar picker: headshot (real file or initials block), name, bio, sessions list (scheduled slots with time/day/room; unscheduled confirmed → TBA row), "← Full agenda" link, not-found state. Only show speakers attached to ≥1 publishable session; respect per-field public flags for bio/email (email hidden by default).

## ICS (`src/lib/ics.ts`)

`sessionIcs(event, session, speakers) -> string`: VCALENDAR METHOD:REQUEST, UID `<sessionId>@unsession.dev`, DTSTART/DTEND with TZID (event tz; convert day+start_min from the 08:00 grid origin + event start_date), SUMMARY, LOCATION (room · venue), DESCRIPTION (abstract), SEQUENCE from session update counter (add `ics_sequence` INTEGER DEFAULT 0 via new migration; bump on schedule change), ORGANIZER (event name, EMAIL_FROM). `cancelIcs(...)` METHOD:CANCEL. Routes: `GET /{event}/portal/session/:id.ics` (auth: speaker of that session). **Schedule-change notifications**: when a confirmed session's slot/room changes (place/move API), queue `schedule_notice` email to its speakers with the new slot + portal link (activity-logged). Fresh ICS is pulled from the portal link (attachments unsupported in simulated mode; when real email lands Phase C can attach).

Definition of done per B-shared. Curl-test with sandbox: builder page renders seeded agenda incl. the Ines Kovač conflict highlighted; place API moves a session; public agenda hides pending talks; ICS endpoint returns valid VCALENDAR (validate DTSTART format).
