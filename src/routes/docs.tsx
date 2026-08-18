/**
 * Public developer docs — `/docs/mcp` (spec C), with `/docs` and `/mcp` as
 * redirects into it.
 *
 * The MCP server has no discovery surface of its own: an agent needs a token
 * and a URL before it can call `tools/list`, so the instructions have to live
 * on a page someone can read without one. This is that page — token → connect
 * → tool reference → self-hosting → protocol details.
 *
 * Registered before the `/:event` catch-alls (see `index.tsx`), so `docs` and
 * `mcp` are effectively reserved slugs. Styling mirrors `landing.tsx` (same
 * tokens, same fonts) rather than the admin chrome — this page is public and
 * unauthenticated.
 */
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { Ctx } from '../types';
import { GOOGLE_FONTS } from '../views/layout';
import { SocialMeta } from '../views/meta';
import { GITHUB_URL } from '../lib/defaults';
import { ProductLogo } from '../views/brand';

const app = new Hono<Ctx>();

/* ------------------------------------------------------------------- css */

const CSS = `
  :root{
    --ink:#16171d; --ink2:#555a63; --ink3:#8b857a;
    --paper:#faf8f5; --line:#ece7de; --card:#ffffff;
    --indigo:#4c5fd5; --indigo-dk:#3a4ab8; --indigo-tint:#eef0fb;
    --amber:#ffd43b; --amber-dk:#8a6d00; --amber-tint:#fdf6dd;
    --green:#2f9e5f; --green-tint:#e7f6ee;
    --mono:'IBM Plex Mono',monospace;
  }
  *{box-sizing:border-box;}
  html{scroll-behavior:smooth;}
  html,body{margin:0;padding:0;color-scheme:light;background:var(--paper);color:var(--ink);font-family:'Space Grotesk',system-ui,sans-serif;}
  a{color:var(--indigo);text-decoration:none;}
  a:hover{text-decoration:underline;}
  .wrap{max-width:1120px;margin:0 auto;padding:0 32px;}
  .kicker{font-family:var(--mono);font-size:11px;letter-spacing:0.16em;color:var(--indigo);font-weight:600;}
  .btn{display:inline-block;padding:9px 16px;font-size:13.5px;font-weight:600;cursor:pointer;border:none;font-family:inherit;text-decoration:none;}
  .btn:hover{text-decoration:none;}
  .btn-primary{background:var(--indigo);color:#fff;box-shadow:0 2px 0 var(--indigo-dk);}

  /* ------------------------------------------------------------- nav */
  .nav{position:sticky;top:0;z-index:50;background:rgba(250,248,245,0.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);}
  .nav-inner{display:flex;align-items:center;gap:12px;padding-top:14px;padding-bottom:14px;}
  /* the wordmark shrinks instead of pushing the bar past a 320px viewport */
  .nav-brand{display:block;flex:0 1 143px;min-width:0;}
  .nav-links{margin-left:36px;display:flex;gap:24px;font-size:14px;}
  .nav-links a{color:var(--ink2);}
  .nav-links a.on{color:var(--ink);font-weight:600;}
  .nav-cta{margin-left:auto;flex:none;display:flex;gap:10px;align-items:center;}
  .nav-cta .signin{font-size:14px;font-weight:600;color:var(--ink);padding:9px 14px;}
  .cta-mini{display:none;}

  /* ---------------------------------------------------------- header */
  .head{border-bottom:1px solid var(--line);
    background:
      radial-gradient(ellipse 900px 380px at 76% -20%, rgba(76,95,213,0.10), transparent 60%),
      radial-gradient(circle at 1px 1px, #e4ded2 1px, transparent 0);
    background-size:auto, 26px 26px;}
  /* like .nav-inner: shares its element with .wrap, so vertical padding only
     — a "Npx 0" shorthand would zero .wrap's side gutters */
  .head-inner{padding-top:56px;padding-bottom:44px;}
  .head h1{margin:14px 0 16px;font-size:clamp(30px,4.4vw,46px);line-height:1.06;letter-spacing:-0.03em;max-width:20ch;}
  .head p{margin:0;font-size:17px;line-height:1.62;color:var(--ink2);max-width:64ch;}
  .endpoint{margin-top:28px;background:var(--ink);color:#fff;padding:18px 22px;max-width:640px;box-shadow:0 16px 40px rgba(22,23,29,0.16);}
  .endpoint .lbl{font-family:var(--mono);font-size:9.5px;letter-spacing:0.14em;color:#8f9bff;font-weight:600;}
  .endpoint .url{font-family:var(--mono);font-size:15px;margin-top:8px;word-break:break-all;}
  .endpoint .sub{font-family:var(--mono);font-size:11px;color:#9a9daa;margin-top:10px;line-height:1.6;}

  /* ---------------------------------------------------------- layout */
  .docs{display:grid;grid-template-columns:212px 1fr;gap:56px;padding-top:52px;padding-bottom:96px;align-items:start;}
  .toc{position:sticky;top:76px;}
  .toc-label{font-family:var(--mono);font-size:10px;letter-spacing:0.14em;color:var(--ink3);margin-bottom:12px;}
  .toc a{display:block;font-size:13.5px;color:var(--ink2);padding:4px 0;line-height:1.4;}
  .toc a.sub{padding-left:14px;font-size:12.5px;color:var(--ink3);}

  article{min-width:0;max-width:78ch;}
  article h2{margin:52px 0 14px;font-size:26px;letter-spacing:-0.025em;line-height:1.2;scroll-margin-top:84px;}
  article h2:first-child{margin-top:0;}
  article h3{margin:34px 0 10px;font-size:17px;letter-spacing:-0.015em;scroll-margin-top:84px;}
  article p{margin:0 0 14px;font-size:15px;line-height:1.68;color:var(--ink2);}
  article ul,article ol{margin:0 0 16px;padding-left:20px;}
  article li{font-size:15px;line-height:1.66;color:var(--ink2);margin-bottom:7px;}
  article b,article strong{color:var(--ink);font-weight:600;}
  code{font-family:var(--mono);font-size:0.87em;background:#f2efe9;padding:1.5px 5px;color:var(--ink);white-space:nowrap;}

  .code{background:var(--ink);margin:0 0 18px;}
  .code .cap{font-family:var(--mono);font-size:9.5px;letter-spacing:0.13em;color:#8f9bff;padding:10px 16px 0;font-weight:600;}
  .code pre{margin:0;padding:14px 16px;overflow-x:auto;font-family:var(--mono);font-size:12.5px;line-height:1.65;color:#e8e8ee;}

  table{width:100%;border-collapse:collapse;margin:0 0 18px;background:#fff;border:1px solid var(--line);display:block;overflow-x:auto;}
  th,td{text-align:left;padding:9px 13px;font-size:13.5px;line-height:1.5;border-bottom:1px solid #f2f0eb;vertical-align:top;}
  th{font-family:var(--mono);font-size:10px;letter-spacing:0.1em;color:var(--ink3);font-weight:600;white-space:nowrap;}
  td:first-child{font-family:var(--mono);font-size:12px;white-space:nowrap;color:var(--ink);}
  td{color:var(--ink2);}
  tr:last-child td{border-bottom:none;}

  .note{border-left:3px solid var(--indigo);background:var(--indigo-tint);padding:13px 16px;margin:0 0 18px;font-size:14px;line-height:1.6;color:#3a3d47;}
  .warn{border-left:3px solid var(--amber-dk);background:var(--amber-tint);padding:13px 16px;margin:0 0 18px;font-size:14px;line-height:1.6;color:#5c4a05;}
  .note b,.warn b{color:inherit;}
  .tag{display:inline-block;font-family:var(--mono);font-size:9px;letter-spacing:0.08em;padding:2.5px 7px;font-weight:600;vertical-align:middle;}
  .tag.w{background:#f6e8f9;color:#9c36b5;}
  .tag.r{background:#e7f1fb;color:#1c7ed6;}
  .tag.mail{background:var(--amber-tint);color:var(--amber-dk);}

  /* ---------------------------------------------------------- footer */
  .footer{border-top:1px solid var(--line);padding:26px 0;}
  .footer-inner{display:flex;flex-wrap:wrap;gap:14px;align-items:center;font-family:var(--mono);font-size:10.5px;letter-spacing:0.12em;color:var(--ink3);}
  .footer-inner .right{margin-left:auto;display:flex;gap:18px;}
  .footer-inner a{color:var(--ink3);}

  @media(max-width:900px){
    .docs{grid-template-columns:1fr;gap:0;padding-top:34px;}
    .toc{position:static;border:1px solid var(--line);background:#fff;padding:10px 18px;margin-bottom:34px;}
    /* the collapsed ToC is the page's nav on a phone — give each row a tappable row height */
    .toc a{padding:9px 0;}
    .toc a.sub{display:none;}
  }
  @media(max-width:720px){
    .wrap{padding-left:20px;padding-right:20px;}
    .nav-links{display:none;}
    /* the whole bar has to survive 320px: logo + Sign in + CTA */
    .nav-inner{gap:8px;}
    .nav-cta{gap:6px;}
    .nav-cta .signin{padding:11px 4px;white-space:nowrap;}
    .nav-cta .btn{padding:11px 10px;white-space:nowrap;}
    .cta-full{display:none;}
    .cta-mini{display:inline;}
    .head-inner{padding-top:38px;padding-bottom:32px;}
    .endpoint .url{font-size:13px;}
    article h2{font-size:22px;margin-top:40px;}
    /* footer links are 14px tall by default — too small to tap reliably */
    .footer-inner .right{gap:4px;}
    .footer-inner a{padding:12px 7px;}
    /* inline code keeps short tokens on one line on desktop; on a phone a long
       one (a curl header, a JSON blob) has to wrap instead of widening the page */
    code{white-space:normal;overflow-wrap:anywhere;}
    /* Every table here is name + description. Side-scrolling one on a phone
       clips the description mid-word, so the pair stacks instead: name on its
       own line, description under it. The header row is the column names,
       which the surrounding heading already says. */
    thead{display:none;}
    tbody,tr,td{display:block;}
    tr{border-bottom:1px solid var(--line);}
    tr:last-child{border-bottom:none;}
    td{border-bottom:none;padding:0 14px;}
    td:first-child{padding-top:12px;padding-bottom:3px;white-space:normal;overflow-wrap:anywhere;}
    td:last-child{padding-bottom:12px;}
  }
`;

/* ------------------------------------------------------------ components */

const Code = (props: { cap?: string; text: string }) => (
  <div class="code">
    {props.cap ? <div class="cap">{props.cap}</div> : null}
    <pre>{props.text}</pre>
  </div>
);

/* ----------------------------------------------------------------- data */

const TOC: { href: string; label: string; sub?: boolean }[] = [
  { href: '#what', label: 'What it is' },
  { href: '#token', label: '1 · Create a token' },
  { href: '#connect', label: '2 · Connect your agent' },
  { href: '#claude-code', label: 'Claude Code', sub: true },
  { href: '#project', label: 'Check into a repo', sub: true },
  { href: '#claude-apps', label: 'Claude apps', sub: true },
  { href: '#cursor', label: 'Cursor', sub: true },
  { href: '#vscode', label: 'VS Code', sub: true },
  { href: '#other', label: 'Any other client', sub: true },
  { href: '#ask', label: '3 · Ask for something' },
  { href: '#tools', label: 'Tool reference' },
  { href: '#safety', label: 'Scopes & side effects' },
  { href: '#selfhost', label: 'Host your own' },
  { href: '#protocol', label: 'Protocol details' },
  { href: '#trouble', label: 'Troubleshooting' },
  { href: '#rest', label: 'The REST API' },
];

const READ_TOOLS: [string, string][] = [
  ['list_events', 'Events this token can see — id, name, slug, dates, timezone, venue, published.'],
  ['get_event', 'One event with its rooms and taxonomies (Track / Format / Level options and their ids).'],
  ['list_forms', 'An event’s submission forms — id, name, slug, status, open/close dates, public URL.'],
  ['get_form', 'One form in full: settings, open state, and the hydrated field schema with flags and conditions.'],
  [
    'list_submissions',
    'Submissions with answers, speakers, status and resolved track/format/level. Filters: status, form, track, free-text q. Cursor-paginated (default 100, max 500).',
  ],
  ['get_submission', 'One submission in full: answers, speakers, status, evaluation score summary, recent activity.'],
  ['list_sessions', 'Sessions including schedule (day / start / end / room), type, status and publish flag.'],
  ['get_session', 'One session — schedule, speakers, track/format, publish flag.'],
  ['list_speakers', 'Speaker profiles — name, email, bio, job title, company, pronouns, links, headshot — with task progress counts.'],
  ['get_speaker', 'One speaker in full: profile, travel notes, sessions, tasks with latest files, version history.'],
  ['get_agenda', 'The published public agenda, same shape as /{slug}/agenda.json. Fails while the agenda is unpublished.'],
  ['get_schedule_conflicts', 'Double-booked rooms, speakers in two places, sessions past the day end — per session or all.'],
  ['list_tasks', 'Speaker and session task instances with status, due date and target.'],
  ['list_task_templates', 'Task templates: type, target, trigger, due rule, clauses, reminders, live instance counts.'],
  ['preview_task_rule', 'Who an assignment rule (trigger + clauses) reaches right now, before saving a template.'],
  ['list_evaluation_plans', 'Evaluation plans: criteria, scope rules, reviewers with per-reviewer load, progress.'],
  ['list_evaluations', 'Recorded evaluations — scores per criterion, notes, abstentions. Filters: plan, submission, reviewer.'],
  ['get_evaluation_scores', 'Score summary per submission across plans: average, done, expected, remaining.'],
  ['list_email_templates', 'Email templates with subject, body and sent counts.'],
  ['list_email_log', 'The email log — every recorded email with status (sent / simulated / failed). Cursor-paginated.'],
  ['get_email', 'One logged email in full, body and failure error included.'],
  ['get_outbox', 'Queued decisions and task reminders that have not been sent yet.'],
  ['list_files', 'The files library grouped by version chain — deliverables, headshots, samples — with comment counts.'],
  ['get_file', 'One file’s version chain and its cross-role comment thread.'],
  ['list_embeds', 'Saved website embeds with snippets and URLs, plus the widget/format catalog.'],
  ['list_content_versions', 'Version history for a session’s title/abstract or a speaker profile.'],
  ['list_activity', 'The event activity feed — every logged action with actor and detail. Cursor-paginated.'],
  ['list_contacts', 'The org-wide speaker CRM directory. Filters: q, company, jobTitle, tag. Org-wide tokens only.'],
  ['get_contact', 'One CRM contact: fields, tags, custom fields, notes, cross-event history, pipeline card.'],
  ['get_pipeline', 'The speaker-pipeline board — every card by stage in column order.'],
  ['get_pipeline_card', 'One pipeline card with contact, notes and stage history.'],
  ['list_team', 'Org members with roles, plus pending invites.'],
];

const WRITE_TOOLS: [string, string, boolean][] = [
  [
    'create_submission',
    'Create a submission on a form on a speaker’s behalf (organizer-import semantics). Answer keys may be field ids or field labels; unmatched keys are reported back, not stored.',
    false,
  ],
  ['update_submission', 'Update title, abstract and/or answers. Answers merge; a null value removes a key.', false],
  [
    'decide_submission',
    'Accept, decline or waitlist — immediately. Runs the real decision engine: flips the status, creates the public Session on accept, mints a 7-day confirmation link, and emails the speaker unless sendEmail is false.',
    true,
  ],
  [
    'queue_decision',
    'Queue decisions into the outbox instead — the admin modal’s semantics. Nothing happens (and nothing is visible to speakers) until send_outbox.',
    false,
  ],
  [
    'send_outbox',
    'Send the outbox: applies queued decisions (status, sessions, tasks, decision emails) and queued task reminders, 40 rows per call.',
    true,
  ],
  ['remove_from_outbox', 'Remove queued decisions or reminders before they send — the outbox undo.', false],
  ['create_session', 'Create a sponsor or service session. Talk sessions only ever arrive by accepting a submission.', false],
  [
    'update_session',
    'Edit title, abstract, track/format/level, duration, room, publish flag, sponsor badge, or the slot. Moving a confirmed session emails its speakers a schedule notice and bumps the calendar-file sequence.',
    true,
  ],
  ['schedule_session', 'Put a session in a slot (day, startMin, optional room) or unschedule it. Same engine, same schedule notice.', true],
  ['delete_session', 'Delete a sponsor or service session. Talks can only be unscheduled or unpublished.', false],
  ['auto_schedule', 'Fill the unscheduled bin — deterministic greedy packer. Deliberately sends no schedule emails.', false],
  ['publish_agenda', 'Publish the agenda (or push pending edits live) and bump the public revision.', false],
  ['create_form', 'Create a form from a preset (cfp, contact, session intake, empty). Starts as a draft.', false],
  ['update_form', 'Rename, open/close, set the submission window, and merge settings (welcome copy, notifications, late link…).', false],
  [
    'update_form_schema',
    'Replace the field list through the builder pipeline: normalize, validate, cascade option renames. Copy-on-write versioning keeps old answers intact.',
    false,
  ],
  ['delete_form', 'Delete a form — refused once it has submissions.', false],
  ['save_evaluation_plan', 'Create or update an evaluation plan: criteria, scope rules, reviewers. Newly added reviewers are emailed their queue link.', true],
  ['record_evaluation', 'Record a score or abstention for a named reviewer — same guards as the reviewer queue; scores are final.', false],
  ['remind_evaluators', 'Email evaluators with outstanding reviews, immediately. Reviewers with nothing left are skipped.', true],
  ['update_email_template', 'Edit a template’s name, subject, body (rich-lite sanitized).', false],
  ['duplicate_email_template', 'Copy a template as a same-key variant, usable as decide_submission’s templateId.', false],
  ['update_speaker', 'Update a speaker profile — name, bio, job title, company, pronouns, links, organizer-only travel notes.', false],
  ['create_speaker', 'Add a speaker profile to an event (keyed by email, idempotent) and mirror them into the CRM directory.', false],
  [
    'assign_task',
    'Assign a task template to speakers or a session, or a one-off task to one speaker. Already-assigned and no-session speakers are skipped and reported. New assignments email each speaker a digest.',
    true,
  ],
  ['complete_task', 'Mark a task instance done as an organizer override. Idempotent.', false],
  ['remove_task', 'Cancel an open task. Completed tasks are kept for the record.', false],
  ['review_task', 'Approve a pending deliverable, or request changes — which emails the speakers with your message.', true],
  ['queue_task_reminder', 'Queue reminders for one task or all of a speaker’s open tasks; they send as one email from the outbox.', false],
  ['email_speaker', 'Email one speaker directly, immediately, with merge tags.', true],
  ['save_task_template', 'Create or edit a task template. Edits pin the old wording onto live instances first.', false],
  ['archive_task_template', 'Archive (or restore) a template — stops assigning, keeps open instances.', false],
  ['comment_on_file', 'Reply on a file’s comment thread as the organizer. Deliberately sends no email.', false],
  ['restore_content_version', 'Restore a session or speaker content version — appends a new version, never rewrites history.', false],
  ['create_embed', 'Create a website embed and get its snippet/URL. Also toggle_embed and delete_embed.', false],
  ['toggle_embed', 'Enable or disable an embed — disabled embeds 404 publicly but keep their config.', false],
  ['delete_embed', 'Delete an embed; its public URL stops working.', false],
  ['create_event', 'Create an event with the standard defaults. Org-wide tokens only.', false],
  ['update_event', 'Update event settings and theme — name, slug, dates, timezone, venue, mode, colors.', false],
  ['save_room', 'Add or edit a room (name, capacity, priority). delete_room untags sessions first.', false],
  ['delete_room', 'Delete a room — sessions in it keep their slot, lose the room.', false],
  ['create_taxonomy', 'Add a taxonomy (option set) with optional per-option color and duration.', false],
  ['save_taxonomy_option', 'Add or rename a taxonomy option — renames cascade into form conditions and stored answers.', false],
  ['delete_taxonomy_option', 'Delete an option — tagged sessions are untagged, never deleted.', false],
  ['save_contact', 'Create (upsert by email) or update a CRM contact; manage tags and custom fields. Org-wide tokens only.', false],
  ['add_contact_note', 'Note on a CRM contact’s record.', false],
  ['add_contact_to_event', 'Add a CRM contact to an event as a speaker profile — idempotent by email.', false],
  ['email_contacts', 'Bulk-email directory contacts (max 100 per call) with merge tags.', true],
  ['enroll_pipeline_card', 'Put a contact on the speaker-pipeline board.', false],
  ['update_pipeline_card', 'Move a card between stages (history-logged), set score/rationale, add notes.', false],
  ['remove_pipeline_card', 'Take a card off the board; the contact stays in the directory.', false],
  ['invite_teammate', 'Invite a teammate (admin or collaborator) — emails a one-shot accept link.', true],
  ['revoke_invite', 'Revoke a pending team invite.', false],
];

const REST_READ: [string, string][] = [
  ['GET /events', 'Events this token can see — id, name, slug, dates, timezone, venue, published.'],
  ['GET /events/:event', 'One event with its rooms and taxonomies (Track / Format / Level options).'],
  ['GET /events/:event/forms', 'Submission forms — id, name, slug, status, open/close dates, public URL.'],
  [
    'GET /events/:event/submissions',
    'Submissions with answers and speakers. Filters: status, form, track, free-text q. Cursor-paginated.',
  ],
  ['GET /submissions/:id', 'One submission in full: answers, speakers, status, score summary, recent activity.'],
  ['GET /events/:event/sessions', 'Sessions including schedule (day / start / end / room), type and publish flag.'],
  ['GET /sessions/:id', 'One session.'],
  ['GET /events/:event/speakers', 'Speaker profiles — bio, pronouns, links, headshot — with task progress counts.'],
  ['GET /events/:event/agenda', 'The published agenda, same shape as /{slug}/agenda.json.'],
  ['GET /events/:event/tasks', 'Task instances with status, due date and speaker/session target.'],
  ['GET /events/:event/forms/:form', 'One form in full — settings, open state, hydrated field schema.'],
  ['GET /speakers/:id', 'One speaker in full — profile, travel notes, tasks with files, version history.'],
  ['GET /events/:event/evaluation/plans', 'Evaluation plans with criteria, reviewers and progress.'],
  ['GET /events/:event/evaluations', 'Recorded evaluations. Filters: plan, submission, reviewer.'],
  ['GET /events/:event/evaluation/scores', 'Score summary per submission across plans.'],
  ['GET /events/:event/email-templates', 'Email templates with sent counts.'],
  ['GET /events/:event/emails', 'The email log, cursor-paginated. GET /emails/:id for one in full.'],
  ['GET /events/:event/outbox', 'Queued decisions and task reminders awaiting send.'],
  ['GET /events/:event/files', 'The files library by version chain. GET /files/:id for one chain + thread.'],
  ['GET /events/:event/embeds', 'Saved embeds with snippets, plus the widget/format catalog.'],
  ['GET /events/:event/task-templates', 'Task templates with rules and instance counts.'],
  ['GET /events/:event/agenda/conflicts', 'Schedule conflicts, per session (?session=) or all.'],
  ['GET /events/:event/activity', 'The activity feed, cursor-paginated.'],
  ['GET /content-versions/:subjectType/:id', 'Version history for a session or speaker.'],
  ['GET /org/contacts', 'The CRM directory (org-wide tokens). GET /org/contacts/:id for one.'],
  ['GET /org/pipeline', 'The pipeline board. GET /org/pipeline/:id for one card.'],
  ['GET /org/team', 'Org members and pending invites.'],
];

const REST_WRITE: [string, string][] = [
  ['POST /events/:event/submissions', 'Create a submission on a form on a speaker’s behalf.'],
  ['PATCH /submissions/:id', 'Update title, abstract and/or answers. Answers merge; null removes a key.'],
  [
    'POST /submissions/:id/decision',
    'Accept, decline or waitlist immediately. Runs the real decision engine and emails the speaker unless sendEmail is false.',
  ],
  ['POST /events/:event/outbox/decisions', 'Queue decisions for the outbox instead (the admin modal’s semantics).'],
  ['POST /events/:event/outbox/send', 'Send the outbox — queued decisions then task reminders, 40 rows per call.'],
  ['POST /events/:event/outbox/remove', 'Remove queued items before they send.'],
  ['POST /events/:event/sessions', 'Create a sponsor or service session. DELETE /sessions/:id removes one.'],
  ['PATCH /sessions/:id', 'Edit fields. { day, startMin, roomId } schedules; nulls unschedule; published toggles.'],
  ['POST /events/:event/agenda/autoschedule', 'Fill the unscheduled bin. No emails.'],
  ['POST /events/:event/agenda/publish', 'Publish the agenda / push edits live.'],
  ['POST /events/:event/forms', 'Create a form from a preset. PATCH /forms/:id edits; DELETE removes; PUT /forms/:id/schema replaces the fields.'],
  ['POST /events/:event/evaluation/plans', 'Create or update an evaluation plan (emails new reviewers).'],
  ['POST /events/:event/evaluations', 'Record a score or abstention for a named reviewer.'],
  ['POST /events/:event/evaluation/remind', 'Email evaluators with outstanding reviews.'],
  ['PATCH /email-templates/:id', 'Edit a template. POST /email-templates/:id/duplicate copies it.'],
  ['PATCH /speakers/:id', 'Update a speaker profile — name, bio, pronouns, links, travel notes.'],
  ['POST /events/:event/speakers', 'Add a speaker profile (keyed by email, idempotent).'],
  ['POST /tasks', 'Assign a template or one-off task to a speaker or session.'],
  ['POST /tasks/:id/complete', 'Mark a task done as an organizer override. Idempotent.'],
  ['POST /tasks/:id/remove', 'Cancel an open task. POST /tasks/:id/review approves or requests changes (emails).'],
  ['POST /task-reminders', 'Queue reminders for a speaker’s task(s) into the outbox.'],
  ['POST /speakers/email', 'Email one speaker directly.'],
  ['POST /events/:event/task-templates', 'Create or edit a task template. …/preview previews a rule; /task-templates/:id/archive toggles.'],
  ['POST /files/:id/comments', 'Reply on a file’s comment thread.'],
  ['POST /content-versions/:subjectType/:id/restore', 'Restore a session/speaker content version.'],
  ['POST /events/:event/embeds', 'Create an embed. PATCH /embeds/:id toggles; DELETE removes.'],
  ['POST /events', 'Create an event (org-wide tokens). PATCH /events/:event updates settings and theme.'],
  ['POST /events/:event/rooms', 'Add or edit a room. DELETE /events/:event/rooms/:id removes one.'],
  ['POST /events/:event/taxonomies', 'Add a taxonomy. POST …/taxonomy-options adds/renames options (renames cascade); DELETE …/taxonomy-options/:id removes.'],
  ['POST /org/contacts', 'Create or update a CRM contact (org-wide tokens). POST /org/contacts/:id/notes, …/add-to-event, /org/contacts/email.'],
  ['POST /org/pipeline', 'Enroll a contact on the pipeline. PATCH /org/pipeline/:id moves/scores/notes; DELETE removes the card.'],
  ['POST /org/team/invite', 'Invite a teammate (emails the accept link). POST /org/team/invites/:id/revoke.'],
];

const METHODS: [string, string][] = [
  ['initialize', 'Negotiates the protocol version (2025-06-18 or 2025-03-26) and returns capabilities { tools: {} } and serverInfo unsession/<version>.'],
  ['notifications/*', 'Any notification (no id) — including notifications/initialized — gets 202 with an empty body.'],
  ['ping', 'Returns an empty result.'],
  ['tools/list', 'Lists the tools this token may call. Write tools are omitted entirely for read-only tokens.'],
  ['tools/call', 'Runs a tool. Results come back as content: [{ type: "text", text: <JSON> }].'],
];

/* ----------------------------------------------------------------- page */

app.get('/docs/mcp', (c) => {
  const origin = (c.env.APP_ORIGIN || new URL(c.req.url).origin).replace(/\/$/, '');
  const endpoint = `${origin}/api/mcp`;
  const title = 'Unsession MCP server — connect your AI agent to your CFP';
  const description = `Unsession ships an MCP server at ${endpoint}. Create an API token, point Claude Code, Claude, Cursor or any MCP client at it, and your agent can read submissions, make decisions, and build the agenda.`;

  return c.html(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <SocialMeta title={title} description={description} url={`${origin}/docs/mcp`} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href={GOOGLE_FONTS} rel="stylesheet" />
        <style>{raw(CSS)}</style>
      </head>
      <body>
        {/* ---------------------------------------------------------- nav */}
        <div class="nav">
          <div class="wrap nav-inner">
            <a href="/" aria-label="Unsession home" class="nav-brand" style="color:var(--ink);text-decoration:none;">
              <ProductLogo height={22} style="width:100%;height:auto;" />
            </a>
            <div class="nav-links">
              <a href="/#how">How it works</a>
              <a class="on" href="/docs">
                Docs
              </a>
              <a href={GITHUB_URL}>GitHub</a>
            </div>
            <div class="nav-cta">
              <a class="signin" href="/signin">
                Sign in
              </a>
              <form method="post" action="/sandbox" style="margin:0;">
                <button type="submit" class="btn btn-primary">
                  <span class="cta-full">Try the sandbox →</span>
                  <span class="cta-mini">Sandbox →</span>
                </button>
              </form>
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------- header */}
        <div class="head">
          <div class="wrap head-inner">
            <div class="kicker">DEVELOPER DOCS · MODEL CONTEXT PROTOCOL</div>
            <h1>Point your agent at your call for speakers</h1>
            <p>
              Unsession ships an MCP server, so an AI agent can work your CFP alongside you: read the queue, pull
              evaluation scores, accept a talk, add a sponsor session, move it on the agenda, chase an outstanding
              speaker task. It runs the same engines the admin UI does, honours the same permissions, and lands in
              the same activity log — an agent is just another organizer with a name badge.
            </p>
            <div class="endpoint">
              <div class="lbl">MCP ENDPOINT</div>
              <div class="url">POST {endpoint}</div>
              <div class="sub">
                OAuth 2.1 · dynamic client registration — no token needed
                <br />
                Streamable HTTP · stateless JSON-RPC 2.0 · 84 tools
              </div>
            </div>
          </div>
        </div>

        <div class="wrap docs">
          {/* ------------------------------------------------------- toc */}
          <aside class="toc">
            <div class="toc-label">ON THIS PAGE</div>
            {TOC.map((t) => (
              <a class={t.sub ? 'sub' : ''} href={t.href}>
                {t.label}
              </a>
            ))}
          </aside>

          <article>
            {/* -------------------------------------------------- what */}
            <h2 id="what">What it is</h2>
            <p>
              The <a href="https://modelcontextprotocol.io">Model Context Protocol</a> is how AI agents plug into
              outside systems. Unsession's MCP server exposes <b>84 tools</b> — 32 read, 52 write, covering
              everything an organizer can do in the admin UI — over the hosted service and over any instance you
              host yourself.
            </p>
            <p>
              Every tool dispatches into the same functions behind the REST API and the admin screens. There is no
              parallel implementation to drift: accepting a talk over MCP creates the session, mints the
              confirmation link and sends the decision email exactly the way the Submissions page does.
            </p>
            <ul>
              <li>
                <b>No extra service to run.</b> The endpoint is part of the worker — no SDK, no Durable Objects, no
                separate process, no additional dependency.
              </li>
              <li>
                <b>Stateless.</b> One <code>POST</code>, one JSON-RPC response. No SSE stream, no session id to keep
                alive, nothing to reconnect.
              </li>
              <li>
                <b>Scoped like a person.</b> A token is read-only or read-write, and optionally restricted to one
                event. A read-only token cannot even see that the write tools exist.
              </li>
            </ul>

            {/* ------------------------------------------------- token */}
            <h2 id="token">1 · Create an API token</h2>
            <div class="note">
              <b>Connecting an MCP client? Skip this step.</b> Clients that speak OAuth — claude.ai, Claude Code,
              Cursor, VS Code and most modern MCP clients — register themselves via dynamic client registration.
              You sign in on a consent page and never handle a token. Tokens are for the REST API and for clients
              without OAuth support.
            </div>
            <p>When you do need one, mint it in the admin:</p>
            <ol>
              <li>
                Sign in and open <b>Workspace → API</b> (<code>/app/api</code>). Owners and admins only.
              </li>
              <li>
                Hit <b>＋ New token</b> and name it after the agent that will hold it — “Claude Code”, “Program bot”.
                The name shows up in the activity log on every write it makes.
              </li>
              <li>
                Pick a <b>scope</b>. <i>Read only</i> for an agent that answers questions about the CFP;{' '}
                <i>Read &amp; write</i> for one that changes things.
              </li>
              <li>
                Optionally <b>restrict it to one event</b>. Everything outside that event then 404s, which is the
                safest default when you run several events from one workspace.
              </li>
              <li>
                <b>Copy the secret.</b> It looks like <code>uns_…</code> and is shown exactly once — there is no
                recovery, only revoke-and-mint-again.
              </li>
            </ol>
            <div class="warn">
              <b>Sandbox workspaces can’t create tokens.</b> The sandbox personas are shared and throwaway, so token
              creation is blocked there. Create your own event to use the API.
            </div>

            {/* ----------------------------------------------- connect */}
            <h2 id="connect">2 · Connect your agent</h2>
            <p>
              Most clients need only the endpoint URL. The server supports OAuth 2.1 with dynamic client
              registration, so an OAuth-capable client (claude.ai connectors, Claude Code, VS Code, Cursor and
              most modern MCP clients) registers itself and sends you to a consent page — sign in, pick a
              workspace and a scope, and the connection appears under <b>API access</b> like any other token.
              Only a client without OAuth support needs the fallback: a remote HTTP server with a custom header,
              the URL above plus <code>Authorization: Bearer uns_…</code>.
            </p>

            <h3 id="claude-code">Claude Code</h3>
            <p>One command — no token:</p>
            <Code cap="TERMINAL" text={`claude mcp add --transport http unsession ${endpoint}`} />
            <p>
              Run <code>/mcp</code> inside Claude Code, pick <b>unsession</b> and choose <b>Authenticate</b> — it
              registers via OAuth and opens the consent page. Add <code>--scope user</code> to make the server
              available in every project on your machine instead of just the current one. On a headless machine or
              in CI, use a static token instead: append{' '}
              <code>--header "Authorization: Bearer uns_your_token_here"</code>.
            </p>

            <h3 id="project">Check it into a repo</h3>
            <p>
              For a shared repo, put the server in <code>.mcp.json</code> at the project root. Claude Code expands{' '}
              <code>${'{VAR}'}</code> in both <code>url</code> and <code>headers</code>, so the file is safe to
              commit — each person exports their own token.
            </p>
            <Code
              cap=".mcp.json"
              text={`{
  "mcpServers": {
    "unsession": {
      "type": "http",
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer \${UNSESSION_TOKEN}"
      }
    }
  }
}`}
            />

            <h3 id="claude-apps">Claude apps (claude.ai and desktop)</h3>
            <p>
              Add it as a <b>custom connector</b>: <b>Settings → Connectors → Add custom connector</b>, paste the
              endpoint URL, and click <b>Connect</b>. Claude registers itself via OAuth and sends you to the
              Unsession consent page — sign in, pick the workspace and scope, and you’re connected. No token to
              paste; the connection shows up under <b>API access</b> and is revoked from there.
            </p>
            <div class="note">
              Prefer a static token? The <b>Request headers</b> section (beta) still works: add{' '}
              <code>authorization</code> with the value <code>Bearer uns_your_token_here</code> — including the
              word <code>Bearer</code> and the space, since Claude sends the value exactly as you type it.
            </div>

            <h3 id="cursor">Cursor</h3>
            <p>
              Project-level <code>.cursor/mcp.json</code>, or <code>~/.cursor/mcp.json</code> to have it everywhere:
            </p>
            <Code
              cap=".cursor/mcp.json"
              text={`{
  "mcpServers": {
    "unsession": {
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer \${env:UNSESSION_TOKEN}"
      }
    }
  }
}`}
            />

            <h3 id="vscode">VS Code</h3>
            <p>
              <code>.vscode/mcp.json</code>, with the token as a prompted input so it never lands in the repo:
            </p>
            <Code
              cap=".vscode/mcp.json"
              text={`{
  "inputs": [
    {
      "type": "promptString",
      "id": "unsession-token",
      "description": "Unsession API token",
      "password": true
    }
  ],
  "servers": {
    "unsession": {
      "type": "http",
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer \${input:unsession-token}"
      }
    }
  }
}`}
            />

            <h3 id="other">Any other client</h3>
            <p>
              Point it at the endpoint as a <b>Streamable HTTP</b> (sometimes <code>streamable-http</code>) server
              and give it the <code>Authorization</code> header. To check the credential before you wire anything
              up, ask the server for its tool list by hand:
            </p>
            <Code
              cap="TERMINAL"
              text={`curl -s ${endpoint} \\
  -H "Authorization: Bearer uns_your_token_here" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}
            />
            <p>
              A list of tool names comes back as JSON. If you get{' '}
              <code>{'{"ok":false,"error":"Unknown API token"}'}</code> with a 401, the secret is wrong or revoked.
            </p>

            {/* --------------------------------------------------- ask */}
            <h2 id="ask">3 · Ask for something</h2>
            <p>
              Once connected, talk to your agent in plain language — it picks the tools. Things that work well on
              day one:
            </p>
            <ul>
              <li>“How many submissions are still in review for DevConf, and which tracks are thinnest?”</li>
              <li>“Show me the five highest-scoring proposals nobody has decided on yet.”</li>
              <li>“Which accepted speakers still haven’t uploaded slides? Assign them the slides task.”</li>
              <li>“Add a 30-minute sponsor session for Acme on day 2 at 14:00 in Studio B.”</li>
              <li>“Move the WASM talk to 11:00 and tell me who that affects.”</li>
              <li>“Diff the published agenda against our website copy and list what’s stale.”</li>
            </ul>
            <div class="note">
              Agents work best when you name the event. Most tools take an <code>event</code> argument that accepts
              the slug or the id, and <code>list_events</code> is how the agent finds it.
            </div>

            {/* ------------------------------------------------- tools */}
            <h2 id="tools">Tool reference</h2>
            <h3>Read — any token</h3>
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>What it returns</th>
                </tr>
              </thead>
              <tbody>
                {READ_TOOLS.map(([name, desc]) => (
                  <tr>
                    <td>{name}</td>
                    <td>{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>
              Write — <span class="tag w">READ · WRITE</span> tokens only
            </h3>
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>What it does</th>
                </tr>
              </thead>
              <tbody>
                {WRITE_TOOLS.map(([name, desc, mails]) => (
                  <tr>
                    <td>{name}</td>
                    <td>
                      {mails ? (
                        <span class="tag mail" style="margin-right:7px;">
                          SENDS EMAIL
                        </span>
                      ) : null}
                      {desc}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              The tool surface now matches what an organizer can do in the admin UI. Deliberately still UI-only:
              file <i>uploads</i>, CRM contact deletion and merging, team role changes and member removal, and CSV
              / XLSX exports (the API returns the same data as JSON) — interactive or destructive operations that
              want a human at the wheel. Org-level tools (CRM, pipeline, team) additionally require an org-wide
              token; event-restricted tokens stay inside their event.
            </p>

            {/* ------------------------------------------------ safety */}
            <h2 id="safety">Scopes, side effects &amp; safety</h2>
            <p>
              Handing an agent write access to a live CFP is a real decision, so the server is built to make the
              blast radius legible.
            </p>
            <ul>
              <li>
                <b>Read-only tokens don’t see write tools.</b> They are filtered out of <code>tools/list</code>
                entirely, so the agent never proposes an action it can’t take. If it calls one anyway, the result
                explains that the token is read-only rather than failing cryptically.
              </li>
              <li>
                <b>Event-restricted tokens can’t reach past their event.</b> Everything else 404s.
              </li>
              <li>
                <b>Every write is on the record.</b> Activity entries name the actor{' '}
                <code>api:&lt;token name&gt;</code>, so “who moved this session?” has the same answer for an agent
                as it does for a person.
              </li>
              <li>
                <b>Emailing tools are labeled.</b> The senders: <code>decide_submission</code> (suppressible with{' '}
                <code>sendEmail: false</code>), <code>send_outbox</code> (that is its whole job),{' '}
                <code>update_session</code> / <code>schedule_session</code> (a schedule notice, but only when a{' '}
                <i>confirmed</i> session actually moves), <code>assign_task</code> and{' '}
                <code>save_evaluation_plan</code> (digests for genuinely new assignments/reviewers),{' '}
                <code>remind_evaluators</code>, <code>review_task</code> (request-changes only),{' '}
                <code>email_speaker</code>, <code>email_contacts</code>, and <code>invite_teammate</code>. Every
                other tool is silent — including the <code>queue_*</code> tools, which only stage work for{' '}
                <code>send_outbox</code>.
              </li>
              <li>
                <b>Revoking is instant.</b> Revoke on <code>/app/api</code> and the next request gets a 401. The
                page also shows each token’s last-used timestamp.
              </li>
            </ul>
            <div class="warn">
              <b>Two ways to decide.</b> <code>queue_decision</code> + <code>send_outbox</code> is the admin UI’s
              two-phase flow: queueing is invisible to speakers and freely undoable with{' '}
              <code>remove_from_outbox</code>, and nothing happens until the outbox is sent.{' '}
              <code>decide_submission</code> skips the outbox and applies the decision immediately — status flip,
              session copy, confirmation link and email — because a machine caller is being explicit. Prefer the
              queue when a human should review before anything reaches a speaker; use a read-only token for an
              agent that should only recommend.
            </div>

            {/* ---------------------------------------------- selfhost */}
            <h2 id="selfhost">Host your own</h2>
            <p>
              Unsession is AGPL-3.0 and the hosted service at <a href={origin}>{origin.replace(/^https?:\/\//, '')}</a>{' '}
              runs this repository unmodified. Self-hosting gives you the same MCP server on your own domain — it is
              part of the worker, so there is nothing extra to enable, deploy or pay for.
            </p>
            <Code
              cap="TERMINAL"
              text={`git clone ${GITHUB_URL}
cd unsession
npm install

npx wrangler d1 create unsession-db      # copy the id into wrangler.jsonc
npx wrangler r2 bucket create unsession-files
npx wrangler d1 migrations apply unsession-db --remote
npx wrangler deploy`}
            />
            <p>
              Set <code>vars.APP_ORIGIN</code> in <code>wrangler.jsonc</code> to the origin your worker answers on,
              and point <code>routes</code> at your domain (or delete the block to use the <code>workers.dev</code>{' '}
              URL). Then:
            </p>
            <ul>
              <li>
                Your MCP endpoint is <code>https://your-domain/api/mcp</code> — the same path on your origin.
              </li>
              <li>
                Mint the token on <i>your</i> instance, at <code>https://your-domain/app/api</code>. Tokens from the
                hosted service are meaningless on yours and vice versa.
              </li>
              <li>
                Everything above works unchanged with your URL substituted. Nothing about the MCP server depends on
                the hosted deployment.
              </li>
            </ul>
            <p>
              The full self-hosting notes — email sending through Cloudflare Email Service, sign-in, local
              development — are in the <a href={`${GITHUB_URL}#self-hosting`}>repository README</a>.
            </p>

            {/* ---------------------------------------------- protocol */}
            <h2 id="protocol">Protocol details</h2>
            <p>
              Only needed if you are writing a client by hand. Everything is JSON-RPC 2.0 over a single{' '}
              <code>POST</code>; the server is stateless, so requests are independent and can be issued in any
              order.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Behaviour</th>
                </tr>
              </thead>
              <tbody>
                {METHODS.map(([name, desc]) => (
                  <tr>
                    <td>{name}</td>
                    <td>{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul>
              <li>
                <b>Tool failures are results, not errors.</b> A failed tool call returns{' '}
                <code>isError: true</code> with a human-readable message in the content, so the agent can read what
                went wrong and adapt. JSON-RPC error objects are reserved for protocol problems — unparseable body
                (<code>-32700</code>), malformed request (<code>-32600</code>), unknown method (<code>-32601</code>
                ), unknown tool (<code>-32602</code>).
              </li>
              <li>
                <b>Notifications get 202 and an empty body.</b> That includes{' '}
                <code>notifications/initialized</code>.
              </li>
              <li>
                <b>Batch requests are rejected.</b> Send one request object per POST.
              </li>
              <li>
                <b>GET and DELETE return 405.</b> There is no SSE stream to open and no session to delete.
              </li>
              <li>
                <b>Auth failures are plain HTTP.</b> A missing, unknown or revoked token gets a 401 with{' '}
                <code>{'{ ok: false, error }'}</code> rather than a JSON-RPC envelope — the request never reaches
                the protocol layer.
              </li>
            </ul>
            <Code
              cap="EXAMPLE · tools/call"
              text={`{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "list_submissions",
    "arguments": { "event": "devconf-2027", "status": "in_review", "limit": 50 }
  }
}`}
            />

            {/* --------------------------------------------- trouble */}
            <h2 id="trouble">Troubleshooting</h2>
            <table>
              <thead>
                <tr>
                  <th>Symptom</th>
                  <th>Cause</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>401 Missing bearer token</td>
                  <td>
                    The header never arrived. Check the client actually forwards custom headers, and that the value
                    starts with <code>Bearer</code> and a space.
                  </td>
                </tr>
                <tr>
                  <td>401 Unknown API token</td>
                  <td>Wrong secret, or a token from a different instance. Mint a new one at /app/api.</td>
                </tr>
                <tr>
                  <td>401 revoked</td>
                  <td>Someone revoked it. Tokens can’t be un-revoked — create a replacement.</td>
                </tr>
                <tr>
                  <td>Only the read tools listed</td>
                  <td>Read-only token. The write tools are hidden by design; mint a read-write one.</td>
                </tr>
                <tr>
                  <td>405 Method not allowed</td>
                  <td>The client opened a GET/SSE stream. This server is POST-only and stateless.</td>
                </tr>
                <tr>
                  <td>404 on a known event</td>
                  <td>The token is restricted to a different event.</td>
                </tr>
                <tr>
                  <td>get_agenda fails</td>
                  <td>That event’s agenda isn’t published yet. Publish it, or read sessions with list_sessions.</td>
                </tr>
              </tbody>
            </table>

            {/* ------------------------------------------------- rest */}
            <h2 id="rest">The REST API</h2>
            <p>
              The same operations, for anything that isn’t an agent — scripts, integrations, a scheduled export.
              Unlike MCP, REST always authenticates with a <a href="#token">token</a>. Base URL{' '}
              <code>{origin}/api/v1</code>:
            </p>
            <Code cap="TERMINAL" text={`curl -H "Authorization: Bearer uns_your_token_here" ${origin}/api/v1/events`} />
            <p>
              Responses are <code>{'{ ok: true, data }'}</code> or <code>{'{ ok: false, error }'}</code>.
            </p>

            <h3>Read — any token</h3>
            <table>
              <thead>
                <tr>
                  <th>Route</th>
                  <th>What it returns</th>
                </tr>
              </thead>
              <tbody>
                {REST_READ.map(([route, desc]) => (
                  <tr>
                    <td>{route}</td>
                    <td>{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>
              Write — <span class="tag w">READ · WRITE</span> tokens only
            </h3>
            <table>
              <thead>
                <tr>
                  <th>Route</th>
                  <th>What it does</th>
                </tr>
              </thead>
              <tbody>
                {REST_WRITE.map(([route, desc]) => (
                  <tr>
                    <td>{route}</td>
                    <td>{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              Full request and response shapes live in{' '}
              <a href={`${GITHUB_URL}/blob/main/SPECS/C-api-mcp.md`}>SPECS/C-api-mcp.md</a>.
            </p>
          </article>
        </div>

        {/* ------------------------------------------------------- footer */}
        <div class="footer">
          <div class="wrap footer-inner">
            <ProductLogo height={16} />
            <span class="right">
              <a href="/">HOME</a>
              <a href="/events">EVENTS</a>
              <a href={GITHUB_URL}>SOURCE</a>
              <span>AGPL-3.0</span>
            </span>
          </div>
        </div>
      </body>
    </html>
  );
});

/** `/docs` and `/mcp` are the URLs people guess — send both to the real page. */
app.get('/docs', (c) => c.redirect('/docs/mcp', 302));
app.get('/mcp', (c) => c.redirect('/docs/mcp', 302));

export default app;
