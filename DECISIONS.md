# Decisions & Open Questions

Decisions I made on your behalf while you were away (each reversible — flag any you disagree with), plus questions queued for you. — Claude

## Build outcome (2026-08-12)

**Live at https://unsession.dev** (admin `/app`, workers.dev URL also works). All 15 prototype screens are implemented and functional; the golden path was verified in a real browser against production: sandbox → submissions table → accept with decision email → tokenized confirm → tasks generated → speakers grid → agenda placement → publish → public agenda + agenda.json. The cron reminder engine fired a real (simulated-mode) task reminder in production. Full walkthrough details are in the session log; per-track verification evidence is in the git history's commit messages.

Post-integration notes, minor, for later polish: (a) the Submissions score denominator counts every plan covering a submission (so an AI-track talk reads "1/5" where the mock said "1/3") — data-honest, revisit if it reads oddly; (b) sandbox events accumulate in the production DB (a few test sandboxes exist from the build); a retention job awaits your Q5 call; (c) builder drag-and-drop was verified by the agenda track's own browser run — synthetic automation can't fire HTML5 drag events, so re-test by hand when you're back.

## Decisions made

- **D1 · Naming/branding:** Product is **Unsession** (the prototype's placeholder name "Program" is replaced everywhere; logo block "P" → "U"). Hosted at **unsession.dev** — your Cloudflare account already has the zone active, so public URLs are `unsession.dev/{event}/{form}` and admin is `unsession.dev/app`.
- **D2 · Organizer auth is passwordless too.** The mock shows email+password for organizers, but the spec's own §8 leaves auth open, you asked for "Google auth + email magic links", and shipping password storage/reset flows adds surface for zero benefit. Sign-in = magic link for everyone + "Continue with Google" for organizers. The Sign In screen's password field is dropped; visual style kept.
- **D3 · Speaker accounts auto-create on first draft save** (per spec §4.4). The public form asks for your email up front only when you first save/submit; a verify link makes the draft portable across devices. Unverified drafts still work in-session (cookie).
- **D4 · Evaluation org-view decision buttons open the decision-email modal** rather than silently flipping status — spec §4.7 says decisions always go through preview+confirm. One decision flow everywhere.
- **D5 · Sessions page gets a "New session" button** for sponsor & service sessions (spec §4.9 requires them; the mock only had a dead-end toast in the agenda builder).
- **D6 · Email architecture:** Cloudflare Email Service sending from `no-reply@unsession.dev` (or `program@…`), with an abstraction layer. Until domain onboarding is finished (needs a dashboard step), emails are recorded in the email log as `simulated` and magic links are surfaced on-screen in dev mode — so every flow is testable end to end today and flips to real sending with zero code change.
- **D7 · Roles v1:** Owner/Admin/Collaborator at the org level (per spec §2); Evaluators are per-event, invited via evaluation plans; speakers are just accounts tied to submissions. Form-level admins deferred to Phase C.
- **D8 · Event scoping via session-stored "active event" + header switcher** (clean URLs like the prototype, `/app/submissions` not `/app/events/123/submissions`).
- **D9 · Agenda time model follows the prototype:** minutes-from-08:00 grid, 15-minute snap, day ends 18:00 (600 min) with "runs past end" as a warning; stored per event so future events can differ.
- **D10 · Client-side stack is vanilla JS islands** (no React/build step) — server renders everything; the form builder, agenda drag-drop and conditional-form logic are ported from the prototype's logic classes.
- **D11 · Sandbox = launch feature (spec §4.13):** "Try the sandbox" on the landing page provisions a DevConf 2027 event mid-lifecycle from the prototype seed data, including the deliberate Ines Kovač double-booking.
- **D12 · Google OAuth ships dark** until you create a GCP OAuth client (needs your Google account). The button appears automatically once `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` secrets are set.
- **D13 · File uploads via R2**, but R2 needs a one-time dashboard enable (Cloudflare error 10042). I'll attempt it via browser; if it requires a payment method on file, uploads show a friendly "not yet enabled" state and everything else works.

## Questions for you (when you're back)

- **Q1 — Google OAuth:** Create a GCP OAuth client (I'll give you exact steps + redirect URI) or should I walk you through it live? Until then, magic links cover all sign-ins.
- **Q2 — Real email sending (the one decision that costs money):** Cloudflare **Email Sending requires the Workers Paid plan ($5/month)** — I stopped at that screen since you authorized free tier only. Until then the app runs in "simulated email" mode: every email is recorded in the email log, and magic links are surfaced on-screen, so all flows work end to end today. Options: **(a) Workers Paid $5/mo — my recommendation** (native sending from unsession.dev, plus 30s CPU limit instead of 10ms, Queues, higher limits — the platform-native path for this product); (b) free Resend account (100 emails/day) — you'd create the account + API key and I've built the email layer so it plugs in with two secrets; (c) stay simulated for now.
- **Q3 — R2: DONE, $0.** Your card ending 4122 was already on file; I activated the R2 subscription at $0/month (10GB free tier, charged only on overage) under your "free tier" authorization. Uploads are live.
- **Q4 — unsession.dev root:** I'm putting the product landing page at `unsession.dev/`. If you had other plans for the root domain (marketing site elsewhere), say so and I'll move the app to `app.unsession.dev`.
- **Q5 — Sandbox retention** (spec §8.6): proposal is persist 7 days then reset; nightly reset is the alternative. Not load-bearing for v1 (sandboxes persist until claimed for now).
- **Q6 — Waitlist promotion** re-runs the accept-email flow identically (spec §8.3 proposal) — implemented that way; confirm.

## Prototype ambiguities I resolved (FYI, low stakes)

- The prototype's Evaluation screen has both "committees" and "plans" describing the same object — the spec's **Evaluation Plans** vocabulary wins; `COMMITTEES` seed data is folded into plans.
- Dashboard "attention" items are computed live (conflicts, overdue tasks, unreviewed submissions, unscheduled sessions) instead of the mock's hardcoded list.
- The Submissions table's demo "sandbox/empty" localStorage toggle is dropped; the real empty state shows for genuinely empty events.
- Speaker Portal's hardcoded "CRDTs for Mortals" draft row = the real "my drafts" list.
- Evaluator queue progress ("9 of 14") becomes real per-reviewer assignment counts from plan scope/caps.
