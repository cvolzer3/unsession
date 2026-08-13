# Spec B3 — Evaluation plans, evaluator workspace, reminders

Read `SPECS/B-shared.md` first. Prototypes: `design/Evaluation.dc.html` (admin, 3 sub-views + reminders modal) and `design/Evaluator Workspace.dc.html` (standalone evaluator portal). Your files per ownership map.

## Model mechanics (`src/lib/evals.ts`)

- `matchesRules(sub, rules)` exactly as prototype (track/form/format/level/status; status 'active' = submitted|in_review).
- Plan membership: materialize into `eval_plan_subs`? No. Compute dynamically from rules (simpler, always fresh); when a plan first includes a submitted submission, flip its status to `in_review` (activity: "Assigned to evaluation plan …" — do this in a `syncPlanMembership(env, planId)` called on plan save and on new submissions via a hook you export; wire the hook call into your own API paths and note in report that B1 submit path can call it later — Phase C wires it).
- Assignment: members (non-chair) round-robin per prototype `assignedFor` (seeded by submission id) honoring `reviews_per` cap. Chairs see everything, score nothing by default.
- Aggregates: per-submission per-criterion averages, cumulative score (sum of criteria) averaged across reviewers, plan progress done/total.

## Admin `/app/evaluation`

Port `Evaluation.dc.html`:
1. Top tabs **Scores | Plans** (org view; the prototype's Queue/Org toggle becomes: admins see Scores+Plans; "Open my queue" button appears if the current user is also a reviewer → links `/{event}/evaluate`).
2. **Scores tab**: stat cards (submissions in scope, fully scored, evaluations remaining, avg score), filters (search, track, plan), table: ID / TITLE / TRACK / per-reviewer chips (initials + score or —, tooltip name) / AVG / REMAINING / DECISION chip. Row → detail view: submission header + abstract + speakers, per-evaluator cards (criterion bars + note + PENDING state), avg + n, decision buttons **Approve / Waitlist / Deny** which deep-link to `/app/submissions?open=<id>&action=…` (per B-shared — decisions always go through the email modal). Show current status chip. "Stats CSV" button = real export (id, title, track, per-criterion avgs, per-reviewer cumulative, avg, status).
3. **Plans tab**: plan cards (name, ANON badge, criteria chips, reviewer avatars with chair highlight, progress bar, due, avg cumulative "x / max"); ＋ New plan → **edit view** (port fully): name, deadline date, anonymized + reminders toggles, instructions textarea, criteria rows (name/hint/scale 1–5 select, remove, add), reviewers (add from org members + invite-by-email creating a user + org membership 'collaborator'? NO — evaluator role: create user + eval_plan_reviewers row; email them an invite magic link to `/{event}/evaluate`), reviews-per select, scope rules (track/form/format/level/status selects) with LIVE match preview list + count, right rail: scoring-form live demo (star buttons per criterion, cumulative), scope summary lines, Create/Save with the prototype's validation toasts. **Detail view**: stats, per-submission table (criteria chips, reviewer chips, cumulative), reviewer progress bars, Remind button → reminders modal, auto-status line.
4. **Reminders modal** (port fully): Send tab (eligible evaluator rows: remaining counts, progress bar, deadline, last reminded [persist per plan+user, real], select-all/none, live preview of merged subject/body for first selected, "Send now to N evaluators" → real emails + log + toast), Automation tab (on/off toggle, min-left threshold, schedule checkboxes 14/7/3/overdue with chair-CC, cooldown, upcoming-sends preview computed from plan deadlines, Save → persist to `automation_json`), Editor tab (subject/body with `{first_name} {remaining} {deadline}` merge tags, Edit/Preview tabs, "Send test to me" → real email to current user).

## Evaluator portal `/{event}/evaluate` (`public-evaluate.tsx`)

Port `Evaluator Workspace.dc.html` — **admin-neutral chrome as in the mock** (it uses admin styling with a minimal sidebar):
1. Access: signed-in user who is a reviewer on ≥1 plan of this event (else friendly "no evaluation access" page). Queue = their assigned submissions across their plans (respect assignment + caps), minus already-scored/abstained.
2. Card mode: submission (title, abstract, meta; SPEAKERS **hidden when plan.anonymized**: meta cell shows "Hidden — blind review"; only evaluator-visible fields shown: filter answers by `flags.evaluatorVisible`), criteria star rows from the PLAN's criteria (name/hint/scale), keyboard 1–5 fills next empty criterion, Enter submits, comment box, Submit (validates all criteria scored — toast otherwise), Skip (stays in queue, moves to back), Abstain (records abstained row, removed). Progress "N of M done" + segment dots. Queue-clear ✓ state.
3. List mode ("Exit review"): searchable/filterable/paginated table of their queue + reviewed (score shown, "Review →" buttons); reviewed detail view (SCORE LOCKED — no editing; per prototype).
4. Scores are final (unique constraint; no edit UI).
5. If user reviews for 2+ plans, a small plan filter chip row above the queue.

Definition of done per B-shared. Curl-test with sandbox: plans list renders with real progress from seeded evaluations; scoring API writes evaluations + flips in_review; reminder send writes emails rows.
