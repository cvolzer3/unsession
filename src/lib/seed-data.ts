/**
 * Sandbox seed content — a TypeScript copy of the prototype's
 * `prototype/design_handoff_program/design/data.js`, extended with the form
 * field schemas from `Forms.dc.html`, the six task templates from
 * `Speakers.dc.html`, and the evaluation plans from `Evaluation.dc.html`.
 *
 * This file is data only. `src/lib/seed.ts` turns it into real rows.
 */

export const EVENT = {
  name: 'DevConf 2027',
  slug: 'devconf-2027',
  tz: 'Europe/Berlin',
  dates: ['2027-10-14', '2027-10-15'] as const,
  venue: 'Station Berlin',
  mode: 'hybrid',
  theme: { primary: '#e8590c', accent: '#1a1a2e', bg: '#faf8f5', font: 'Space Grotesk' },
};

export const TRACKS = [
  { id: 'ai', name: 'AI & ML', color: '#7048e8' },
  { id: 'web', name: 'Web Platform', color: '#1c7ed6' },
  { id: 'infra', name: 'Infrastructure', color: '#0ca678' },
  { id: 'sec', name: 'Security', color: '#e03131' },
  { id: 'dx', name: 'Developer Experience', color: '#e8590c' },
];

export const FORMATS = [
  { name: 'Talk', duration: 30, label: 'Talk (30 min)' },
  { name: 'Deep Dive', duration: 45, label: 'Deep Dive (45 min)' },
  { name: 'Workshop', duration: 90, label: 'Workshop (90 min)' },
  { name: 'Lightning', duration: 10, label: 'Lightning (10 min)' },
  { name: 'Panel', duration: 45, label: 'Panel (45 min)' },
];

export const LEVELS = ['Intro', 'Intermediate', 'Advanced'];

export const ROOMS = [
  { name: 'Main Stage', capacity: 900, priority: 1 },
  { name: 'Room 2', capacity: 250, priority: 2 },
  { name: 'Room 3', capacity: 180, priority: 3 },
  { name: 'Workshop Lab', capacity: 60, priority: 4 },
];

export type SeedSpeaker = { name: string; email: string; bio: string };
export type SeedSubmission = {
  id: string;
  title: string;
  abstract: string;
  speakers: SeedSpeaker[];
  track: string;
  format: string;
  level: string;
  status: string;
  evalDone: number;
  evalTotal: number;
  avg: number | null;
  submitted: string;
  form: string;
};

const sp = (name: string, email: string, bio: string): SeedSpeaker => ({ name, email, bio });
const S = (
  id: number,
  title: string,
  abstract: string,
  speakers: SeedSpeaker[],
  track: string,
  format: string,
  level: string,
  status: string,
  evalDone: number,
  evalTotal: number,
  avg: number | null,
  days: number
): SeedSubmission => ({
  id: 'SUB-' + id,
  title,
  abstract,
  speakers,
  track,
  format,
  level,
  status,
  evalDone,
  evalTotal,
  avg,
  submitted: `2026-07-${String(days).padStart(2, '0')}`,
  form: 'cfp',
});

export const SUBMISSIONS: SeedSubmission[] = [
  S(147, 'Postgres at the Edge: Read Replicas Everywhere', 'How we cut p99 latency 6x by pushing read replicas to 14 regions, and every mistake we made on the way.', [sp('Amara Diallo', 'amara@fastly.dev', 'Staff engineer, databases. Previously Citus.')], 'infra', 'Deep Dive (45 min)', 'Advanced', 'in_review', 2, 3, 4.3, 28),
  S(146, 'The Case Against Microservices (From Someone Who Sold Them)', 'A consultant who spent five years selling service meshes explains when a monolith is the grown-up choice.', [sp('Viktor Hansen', 'viktor@meshless.io', 'Independent consultant, ex-Istio contributor.')], 'infra', 'Talk (30 min)', 'Intermediate', 'confirmed', 3, 3, 4.7, 27),
  S(145, 'Prompt Injection Is the New SQL Injection', 'Live-exploiting an LLM-powered support bot on stage, then hardening it step by step.', [sp('Ines Kovač', 'ines@nullsec.eu', 'Security researcher. CVE collector.')], 'sec', 'Talk (30 min)', 'Intermediate', 'confirmed', 3, 3, 4.8, 26),
  S(144, 'CSS Grid Level 3: Masonry Is Finally Real', 'A tour of masonry layout in production browsers, with fallback strategies you can ship today.', [sp('Priya Raman', 'priya@webfoundry.co', 'Design engineer and CSSWG observer.')], 'web', 'Talk (30 min)', 'Intro', 'accepted', 3, 3, 4.1, 26),
  S(143, 'Fine-Tuning Is Dead, Long Live Fine-Tuning', 'When RAG fails, when adapters win, and the decision tree we use with every client.', [sp('Tomás Rivera', 'tomas@adapt.ml', 'ML lead at a 12-person applied-AI shop.')], 'ai', 'Deep Dive (45 min)', 'Advanced', 'in_review', 1, 3, 3.5, 25),
  S(142, 'Ship Your Design System Without a Design Team', 'How a 6-person startup maintains a coherent UI with tokens, lint rules, and zero designers.', [sp('Lena Fischer', 'lena@tinystack.app', 'Founding engineer. Accidental design lead.')], 'dx', 'Talk (30 min)', 'Intro', 'accepted', 3, 3, 3.9, 25),
  S(141, 'Kubernetes the Hard Way, Five Years Later', 'Re-running the classic exercise on 2027 infrastructure — what got easier, what still hurts.', [sp('Dmitri Volkov', 'dmitri@baremetal.sh', 'Platform engineer, on-prem believer.')], 'infra', 'Workshop (90 min)', 'Advanced', 'in_review', 2, 3, 3.2, 24),
  S(140, 'Passkeys in Production: 18 Months In', 'Adoption curves, support tickets, and the account-recovery flows nobody warns you about.', [sp('Sarah Okafor', 'sarah@authlayer.com', 'Product engineer, identity.'), sp('Jon Marsh', 'jon@authlayer.com', 'Support lead turned engineer.')], 'sec', 'Talk (30 min)', 'Intermediate', 'confirmed', 3, 3, 4.5, 24),
  S(139, 'A Love Letter to Boring Technology', 'Our stack is Django, Postgres, and cron. We serve 40M requests a day. Ask me anything.', [sp('Mei Chen', 'mei@steadyship.io', 'CTO. Professional resister of rewrites.')], 'infra', 'Talk (30 min)', 'Intro', 'accepted', 3, 3, 4.4, 23),
  S(138, 'WebGPU Beyond Graphics: Compute in the Browser', 'Running real ML inference client-side — architecture, quantization, and when not to bother.', [sp('Felix Braun', 'felix@gpuweb.dev', 'Graphics programmer gone rogue.')], 'web', 'Deep Dive (45 min)', 'Advanced', 'in_review', 2, 3, 4.0, 23),
  S(137, 'The Accessibility Audit That Saved Our Contract', 'A true story of a failed procurement, a 6-week remediation, and the checklist we now run weekly.', [sp('Grace Adeyemi', 'grace@a11yworks.co', 'Accessibility consultant, WCAG nerd.')], 'web', 'Talk (30 min)', 'Intermediate', 'waitlisted', 3, 3, 3.6, 22),
  S(136, 'Building a Data Platform With Three Engineers', 'DuckDB, dbt, and ruthless scope-cutting: analytics for a 200-person company on a shoestring.', [sp('Oscar Lindqvist', 'oscar@leandata.se', 'Data engineer #1 of 3.')], 'infra', 'Talk (30 min)', 'Intermediate', 'in_review', 0, 3, null, 22),
  S(135, 'LLM Evals Are Your New Unit Tests', 'A practical workshop: build an eval suite for a real feature, wire it into CI, catch a regression live.', [sp('Hana Yoshida', 'hana@evalcraft.jp', 'ML engineer, testing evangelist.')], 'ai', 'Workshop (90 min)', 'Intermediate', 'confirmed', 3, 3, 4.6, 21),
  S(134, 'Monorepo Migration: A Post-Mortem', 'We moved 400 repos into one. Half the team loved it. Here is the honest ledger of costs and wins.', [sp('Paul Nkemelu', 'paul@bigmerge.dev', 'DX lead, build-systems survivor.')], 'dx', 'Talk (30 min)', 'Intermediate', 'declined', 3, 3, 2.8, 21),
  S(133, 'Zero-Downtime Schema Changes at 2TB', 'gh-ost, logical replication, and the runbook we use for scary migrations.', [sp('Anouk Visser', 'anouk@dbops.nl', 'SRE, database whisperer.')], 'infra', 'Deep Dive (45 min)', 'Advanced', 'in_review', 1, 3, 4.5, 20),
  S(132, 'Rust for TypeScript Developers: A Gentle On-Ramp', 'Hands-on workshop porting a small Node service to Rust, pain points annotated.', [sp('Diego Fuentes', 'diego@oxidize.dev', 'Educator and systems programmer.')], 'dx', 'Workshop (90 min)', 'Intro', 'accepted', 3, 3, 4.2, 19),
  S(131, 'How We Got Pwned (and What It Cost)', 'A transparent incident review of a supply-chain compromise: timeline, blast radius, invoices.', [sp('Nadia Petrova', 'nadia@postmortem.io', 'CISO. Believes in public post-mortems.')], 'sec', 'Talk (30 min)', 'Intermediate', 'in_review', 2, 3, 4.9, 19),
  S(130, 'The Browser Is the Best App Platform (Fight Me)', 'PWAs in 2027: install rates, capability gaps, and three case studies that skipped the app store.', [sp('Marcus Webb', 'marcus@nostore.app', 'Web platform advocate.')], 'web', 'Panel (45 min)', 'Intro', 'declined', 3, 3, 2.5, 18),
  S(129, 'Streaming Postgres Changes Without Kafka', 'Logical decoding straight to consumers: simpler CDC for teams that do not want a Kafka bill.', [sp('Ayla Demir', 'ayla@cdclite.dev', 'Backend engineer, pragmatist.')], 'infra', 'Talk (30 min)', 'Intermediate', 'submitted', 0, 3, null, 17),
  S(128, 'Design Tokens at the Edge of Chaos', 'Multi-brand theming across 9 products: the token architecture that finally stuck.', [sp('Ravi Shankar', 'ravi@tokensmith.in', 'Design systems lead.')], 'dx', 'Talk (30 min)', 'Intermediate', 'submitted', 0, 3, null, 16),
  S(127, 'Agents That Do Not Hallucinate Your Infra Away', 'Guardrails for LLM-driven ops tooling: approvals, dry-runs, and blast-radius budgets.', [sp('Chloe Martin', 'chloe@opsguard.ai', 'Platform engineer, AI-tools skeptic.')], 'ai', 'Talk (30 min)', 'Advanced', 'submitted', 0, 3, null, 15),
  S(126, 'The Lightning Talk About Lightning Talks', 'Ten minutes on why your conference needs more ten-minute talks.', [sp('Ben Carter', 'ben@shortform.dev', 'Serial lightning-talker.')], 'dx', 'Lightning (10 min)', 'Intro', 'submitted', 0, 3, null, 14),
  S(125, 'Threat Modeling for Busy Teams', 'A 45-minute framework you can run in a sprint retro, with real worksheets.', [sp('Fatima Al-Rashid', 'fatima@shiftsec.io', 'AppSec engineer and facilitator.')], 'sec', 'Deep Dive (45 min)', 'Intermediate', 'submitted', 0, 3, null, 13),
  S(124, 'From Jupyter to Production in One Repo', 'Killing the notebook-to-service rewrite: our template for shipping models straight from research.', [sp('Emil Johansson', 'emil@mlship.se', 'MLOps engineer.')], 'ai', 'Talk (30 min)', 'Intermediate', 'submitted', 0, 3, null, 12),
  S(123, 'HTMX and the Return of the Server', 'We deleted 40k lines of React. A tour of what replaced it and where we drew the line.', [sp('Julia Novak', 'julia@hypermedia.dev', 'Full-stack engineer, simplicity zealot.')], 'web', 'Talk (30 min)', 'Intermediate', 'waitlisted', 3, 3, 3.7, 11),
  S(122, 'Chaos Engineering on a Budget', 'You do not need a chaos platform — you need a Tuesday, a script, and management buy-in.', [sp('Kwame Mensah', 'kwame@faultline.dev', 'SRE, professional breaker of staging.')], 'infra', 'Lightning (10 min)', 'Intro', 'declined', 3, 3, 2.2, 10),
  S(121, 'Local-First Apps: Sync Engines in Anger', 'CRDTs in production: conflict UX, storage costs, and the bug that ate a week of edits.', [sp('Sofia Rossi', 'sofia@syncable.app', 'Product engineer, local-first convert.'), sp('Tim Okada', 'tim@syncable.app', 'Distributed-systems engineer.')], 'web', 'Deep Dive (45 min)', 'Advanced', 'confirmed', 3, 3, 4.6, 9),
  S(120, 'Burnout-Proofing Your On-Call Rotation', 'Alert budgets, follow-the-sun handoffs, and the metric that predicted every resignation.', [sp('Aisha Khan', 'aisha@humanops.co', 'Engineering manager, SRE background.')], 'infra', 'Talk (30 min)', 'Intro', 'withdrawn', 2, 3, 4.0, 8),
  {
    id: 'SUB-S02', form: 'sponsor', title: 'Scaling Without Servers — Live Architecture Review',
    abstract: 'Vercel Cloud engineers rebuild a real attendee architecture on stage, serverless-first.',
    speakers: [sp('Rachel Kim', 'rachel@vercelcloud.com', 'DevRel lead, Vercel Cloud (Platinum sponsor).')],
    track: 'infra', format: 'Talk (30 min)', level: 'Intro', status: 'accepted',
    evalDone: 1, evalTotal: 1, avg: 3.8, submitted: '2026-08-02',
  },
  {
    id: 'SUB-S01', form: 'sponsor', title: 'Observability on Autopilot',
    abstract: 'Zero-code instrumentation of a polyglot stack with the new Datastack agent — live install included.',
    speakers: [sp('Marco Silva', 'marco@datastack.io', 'Solutions engineer, Datastack (Gold sponsor).')],
    track: 'infra', format: 'Talk (30 min)', level: 'Intermediate', status: 'in_review',
    evalDone: 1, evalTotal: 1, avg: 3.1, submitted: '2026-07-30',
  },
];

/** Agenda placements — start/end in minutes from 08:00. type: talk|service|sponsor */
export const AGENDA = [
  { id: 'A1', title: 'Registration & Coffee', type: 'service', room: 'ALL', day: 0, start: 30, end: 90 },
  { id: 'A2', title: 'Opening Keynote: The Next Decade of Dev Tools', type: 'talk', speakers: 'Mei Chen', track: 'dx', room: 'Main Stage', day: 0, start: 90, end: 150, sub: 'SUB-139', status: 'confirmed' },
  { id: 'A3', title: 'Coffee Break', type: 'service', room: 'ALL', day: 0, start: 150, end: 180 },
  { id: 'A4', title: 'Prompt Injection Is the New SQL Injection', type: 'talk', speakers: 'Ines Kovač', track: 'sec', room: 'Main Stage', day: 0, start: 180, end: 210, sub: 'SUB-145', status: 'confirmed' },
  { id: 'A5', title: 'Passkeys in Production: 18 Months In', type: 'talk', speakers: 'Sarah Okafor, Jon Marsh', track: 'sec', room: 'Room 2', day: 0, start: 180, end: 210, sub: 'SUB-140', status: 'confirmed' },
  { id: 'A6', title: 'LLM Evals Are Your New Unit Tests', type: 'talk', speakers: 'Hana Yoshida', track: 'ai', room: 'Workshop Lab', day: 0, start: 180, end: 270, sub: 'SUB-135', status: 'confirmed' },
  { id: 'A7', title: 'Lunch', type: 'service', room: 'ALL', day: 0, start: 270, end: 330 },
  { id: 'A8', title: 'Scaling Without Servers — Vercel Cloud', type: 'sponsor', speakers: 'Sponsor session', track: 'infra', room: 'Room 3', day: 0, start: 330, end: 360, sub: 'SUB-S02' },
  { id: 'A9', title: 'The Case Against Microservices', type: 'talk', speakers: 'Viktor Hansen', track: 'infra', room: 'Main Stage', day: 0, start: 330, end: 360, sub: 'SUB-146', status: 'confirmed' },
  // deliberate conflict: Ines Kovač double-booked at 14:00 (A10 vs A11)
  { id: 'A10', title: 'Live Threat Hunting Q&A', type: 'talk', speakers: 'Ines Kovač', track: 'sec', room: 'Room 2', day: 0, start: 360, end: 390, status: 'pending' },
  { id: 'A11', title: 'Security AMA Panel', type: 'talk', speakers: 'Ines Kovač, Nadia Petrova', track: 'sec', room: 'Room 3', day: 0, start: 360, end: 390, status: 'pending' },
  { id: 'A12', title: 'Local-First Apps: Sync Engines in Anger', type: 'talk', speakers: 'Sofia Rossi, Tim Okada', track: 'web', room: 'Main Stage', day: 0, start: 390, end: 435, sub: 'SUB-121', status: 'confirmed' },
  { id: 'A13', title: 'Afternoon Break', type: 'service', room: 'ALL', day: 0, start: 435, end: 465 },
  { id: 'A14', title: 'CSS Grid Level 3: Masonry Is Finally Real', type: 'talk', speakers: 'Priya Raman', track: 'web', room: 'Room 2', day: 1, start: 90, end: 120, sub: 'SUB-144', status: 'pending' },
  { id: 'A15', title: 'Rust for TypeScript Developers', type: 'talk', speakers: 'Diego Fuentes', track: 'dx', room: 'Workshop Lab', day: 1, start: 90, end: 180, sub: 'SUB-132', status: 'pending' },
  { id: 'A16', title: 'Registration & Coffee', type: 'service', room: 'ALL', day: 1, start: 30, end: 90 },
  { id: 'A17', title: 'Lunch', type: 'service', room: 'ALL', day: 1, start: 270, end: 330 },
];

export const UNSCHEDULED = [
  { id: 'U1', title: 'A Love Letter to Boring Technology', speakers: 'Mei Chen', track: 'infra', dur: 30, sub: 'SUB-139', status: 'confirmed' },
  { id: 'U2', title: 'Ship Your Design System Without a Design Team', speakers: 'Lena Fischer', track: 'dx', dur: 30, sub: 'SUB-142', status: 'accepted' },
  { id: 'U3', title: 'Zero-Downtime Schema Changes at 2TB', speakers: 'Anouk Visser', track: 'infra', dur: 45, sub: 'SUB-133', status: 'accepted' },
  { id: 'U4', title: 'How We Got Pwned (and What It Cost)', speakers: 'Nadia Petrova', track: 'sec', dur: 30, sub: 'SUB-131', status: 'accepted' },
  { id: 'U5', title: 'Postgres at the Edge', speakers: 'Amara Diallo', track: 'infra', dur: 45, sub: 'SUB-147', status: 'accepted' },
];

export const TASKS = ['Confirm participation', 'Complete profile', 'Upload headshot', 'Upload slides', 'AV requirements', 'Travel details'];

/** t: c=complete, p=pending, o=overdue, -=n/a — indexes line up with TASK_TEMPLATES. */
export const SPEAKER_TASKS = [
  { name: 'Viktor Hansen', session: 'The Case Against Microservices', track: 'infra', t: ['c', 'c', 'c', 'p', 'c', 'c'] },
  { name: 'Ines Kovač', session: 'Prompt Injection Is the New SQL Injection', track: 'sec', t: ['c', 'c', 'c', 'o', 'c', 'p'] },
  { name: 'Sarah Okafor', session: 'Passkeys in Production', track: 'sec', t: ['c', 'c', 'p', 'p', 'c', 'p'] },
  { name: 'Jon Marsh', session: 'Passkeys in Production', track: 'sec', t: ['c', 'p', 'o', 'p', 'p', 'p'] },
  { name: 'Mei Chen', session: 'A Love Letter to Boring Technology', track: 'infra', t: ['c', 'c', 'c', 'c', 'c', 'c'] },
  { name: 'Hana Yoshida', session: 'LLM Evals Are Your New Unit Tests', track: 'ai', t: ['c', 'c', 'c', 'p', 'o', 'c'] },
  { name: 'Sofia Rossi', session: 'Local-First Apps', track: 'web', t: ['c', 'c', 'p', 'p', 'p', 'p'] },
  { name: 'Tim Okada', session: 'Local-First Apps', track: 'web', t: ['c', 'o', 'o', 'p', 'p', 'p'] },
  { name: 'Priya Raman', session: 'CSS Grid Level 3', track: 'web', t: ['p', 'p', 'p', 'p', 'p', 'p'] },
  { name: 'Diego Fuentes', session: 'Rust for TypeScript Developers', track: 'dx', t: ['p', 'c', 'p', 'p', 'p', 'p'] },
  { name: 'Lena Fischer', session: 'Ship Your Design System', track: 'dx', t: ['p', 'p', 'p', 'p', 'p', 'p'] },
];

export type SeedPerson = {
  id: string;
  name: string;
  email: string;
  /** Drives `org_members.role` — what the Team screen shows and permissions key off. */
  orgRole: 'owner' | 'admin' | 'collaborator';
};

/**
 * The org's roster. Everyone here becomes a user *and* an org member, which is
 * also what makes them offerable in the evaluation plan editor's reviewer
 * picker — that dropdown is fed by the org's members plus anyone already on a
 * plan, so an evaluator who is not a member is invisible to it.
 */
export const PEOPLE: SeedPerson[] = [
  // Organizer — owns the sandbox org and is the visitor's organizer seat.
  { id: 'marta', name: 'Marta Keller', email: 'marta@devconf.org', orgRole: 'owner' },

  // Program team — the people who run the event day to day.
  { id: 'nils', name: 'Nils Bergström', email: 'nils@devconf.org', orgRole: 'admin' },
  { id: 'rosa', name: 'Rosa Delgado', email: 'rosa@devconf.org', orgRole: 'admin' },
  { id: 'kenji', name: 'Kenji Mori', email: 'kenji@devconf.org', orgRole: 'collaborator' },
  { id: 'hannah', name: 'Hannah Boateng', email: 'hannah@devconf.org', orgRole: 'collaborator' },
  { id: 'luca', name: 'Luca Ferrari', email: 'luca@devconf.org', orgRole: 'collaborator' },
  { id: 'zoe', name: 'Zoë Martens', email: 'zoe@devconf.org', orgRole: 'collaborator' },

  // Evaluators — outside reviewers invited as collaborators. Some sit on plans
  // below, the rest are unassigned so the reviewer picker has real choices.
  { id: 'deniz', name: 'Deniz Aksoy', email: 'deniz@aksoy.dev', orgRole: 'collaborator' },
  { id: 'priya', name: 'Priya Nair', email: 'priya.n@webfoundry.co', orgRole: 'collaborator' },
  { id: 'sam', name: 'Sam Ortiz', email: 'sam@ortiz.codes', orgRole: 'collaborator' },
  { id: 'jonas', name: 'Jonas Weber', email: 'jonas@sec-audit.de', orgRole: 'collaborator' },
  { id: 'elif', name: 'Elif Şahin', email: 'elif@mlberlin.io', orgRole: 'collaborator' },
  { id: 'tom', name: 'Tom Baker', email: 'tom@devrel.uk', orgRole: 'collaborator' },
  { id: 'grace', name: 'Grace Osei', email: 'grace@platformlab.gh', orgRole: 'collaborator' },
  { id: 'iris', name: 'Iris Lindholm', email: 'iris@stackcraft.fi', orgRole: 'collaborator' },
  { id: 'omar', name: 'Omar Benali', email: 'omar@edgeworks.ma', orgRole: 'collaborator' },
  { id: 'yuki', name: 'Yuki Tanaka', email: 'yuki@frontendjp.dev', orgRole: 'collaborator' },
  { id: 'ana', name: 'Ana Sousa', email: 'ana@devbrasil.io', orgRole: 'collaborator' },
];

/** Invites that were sent but not accepted — the Team screen's pending rows. */
export const INVITES = [
  { email: 'petra@devconf.org', role: 'admin' },
  { email: 'rafael@a11yworks.co', role: 'collaborator' },
];

export const EVAL_PLANS = [
  {
    id: 'main', name: 'Main CFP Review', deadline: '2026-08-24', anonymized: true, reminders: true, reviewsPer: 3,
    rules: { track: 'all', form: 'cfp', format: 'all', level: 'all', status: 'active' },
    instructions:
      'Score every criterion on the 1–5 scale. Reserve 5s for talks you would put on the main stage. Judge the proposal, not the speaker — identities are hidden. If you recognize the submitter anyway, abstain instead of scoring.',
    criteria: [
      { name: 'Relevance', hint: 'Fits this audience?', scale: 5 },
      { name: 'Depth', hint: 'Substance over hype?', scale: 5 },
      { name: 'Delivery', hint: 'Will it land on stage?', scale: 5 },
    ],
    reviewers: [
      { id: 'marta', role: 'chair' }, { id: 'nils', role: 'chair' },
      { id: 'deniz', role: 'member' }, { id: 'priya', role: 'member' }, { id: 'sam', role: 'member' },
      { id: 'grace', role: 'member' }, { id: 'jonas', role: 'member' }, { id: 'iris', role: 'member' },
    ],
    subs: ['SUB-147', 'SUB-143', 'SUB-141', 'SUB-138', 'SUB-136', 'SUB-133', 'SUB-131', 'SUB-129', 'SUB-128', 'SUB-127', 'SUB-126', 'SUB-125', 'SUB-124'],
  },
  {
    id: 'ai', name: 'AI Track Second Opinion', deadline: '2026-08-28', anonymized: false, reminders: true, reviewsPer: 2,
    rules: { track: 'ai', form: 'all', format: 'all', level: 'all', status: 'active' },
    instructions:
      'Expert pass on AI & ML proposals. Program fit is already covered by the main review — judge technical substance only.',
    criteria: [
      { name: 'Novelty', hint: 'New ground, not a rehash?', scale: 5 },
      { name: 'Rigor', hint: 'Would an expert nod along?', scale: 5 },
    ],
    reviewers: [
      { id: 'rosa', role: 'chair' }, { id: 'elif', role: 'member' }, { id: 'deniz', role: 'member' },
      { id: 'omar', role: 'member' }, { id: 'yuki', role: 'member' },
    ],
    subs: ['SUB-143', 'SUB-127', 'SUB-124'],
  },
  {
    id: 'sponsor', name: 'Sponsor Session Check', deadline: '2026-09-18', anonymized: false, reminders: false, reviewsPer: 1,
    rules: { track: 'all', form: 'sponsor', format: 'all', level: 'all', status: 'all' },
    instructions: 'Light-touch quality check of invited sponsor slots. Flag anything that reads as a pure sales pitch.',
    criteria: [
      { name: 'Audience value', hint: 'Useful even if you never buy?', scale: 5 },
      { name: 'Stage-ready', hint: 'Demo survives a live room?', scale: 5 },
    ],
    reviewers: [{ id: 'marta', role: 'chair' }, { id: 'tom', role: 'member' }, { id: 'hannah', role: 'member' }],
    subs: ['SUB-S01', 'SUB-S02'],
  },
];

/* ------------------------------------------------------------ forms (Forms.dc.html) */

export type SeedField = {
  id: string;
  core?: boolean;
  type: 'TXT' | 'LONG' | 'SEL' | 'GRP' | 'URL' | 'CHK';
  label: string;
  req?: boolean;
  agenda?: boolean;
  edit?: boolean;
  eval?: boolean;
  opts?: string[];
  val?: string;
  ph?: string;
  cond?: { src: string; op: string; val: string; alsoReq?: boolean };
};

export type SeedForm = {
  id: string;
  slug: string;
  name: string;
  audience: string;
  status: 'draft' | 'open' | 'closed';
  opensAt: string | null;
  closesAt: string | null;
  fields: SeedField[];
};

export const FORMS: SeedForm[] = [
  {
    id: 'cfp', slug: 'cfp', name: 'Call for Speakers — Main CFP', audience: 'Public link — anyone',
    status: 'open', opensAt: '2026-07-01', closesAt: '2026-08-31',
    fields: [
      { id: 'f_title', core: true, type: 'TXT', label: 'Session title', req: true, agenda: true, edit: false, eval: true, val: 'min 8 · max 90 chars' },
      { id: 'f_abstract', core: true, type: 'LONG', label: 'Abstract', req: true, agenda: true, edit: true, eval: true, val: 'max 150 words · live counter', ph: 'What will the audience walk away with?' },
      { id: 'f_format', core: true, type: 'SEL', label: 'Format', req: true, agenda: true, edit: false, eval: true, opts: ['Talk (30 min)', 'Deep Dive (45 min)', 'Workshop (90 min)', 'Lightning (10 min)', 'Panel (45 min)'], val: 'bound to taxonomy: Format' },
      { id: 'f_speaker', core: true, type: 'GRP', label: 'Speaker — name, email, bio, headshot', req: true, agenda: true, edit: true, eval: false, val: 'repeats per co-speaker · cap 3' },
      { id: 'f_track', type: 'SEL', label: 'Track', req: true, agenda: true, edit: false, eval: true, opts: ['AI & ML', 'Web Platform', 'Infrastructure', 'Security', 'Developer Experience'], val: 'bound to taxonomy: Track — powers routing, filters, agenda colors' },
      { id: 'f_level', type: 'SEL', label: 'Audience level', req: false, agenda: true, edit: false, eval: true, opts: ['Intro', 'Intermediate', 'Advanced'], val: 'bound to taxonomy: Level' },
      { id: 'f_av', type: 'LONG', label: 'AV & room requirements', req: false, agenda: false, edit: true, eval: false, ph: 'Power strips, second screen, network…', cond: { src: 'f_format', op: 'is', val: 'Workshop (90 min)', alsoReq: true } },
      { id: 'f_prev', type: 'URL', label: 'Link to a previous recorded talk', req: false, agenda: false, edit: false, eval: true, val: 'auto-prepends https:// on blur' },
      { id: 'f_travel', type: 'SEL', label: 'Do you need travel support?', req: false, agenda: false, edit: false, eval: false, opts: ['No', 'Yes — flights', 'Yes — flights + hotel'] },
      { id: 'f_coc', type: 'CHK', label: 'Code of conduct agreement', req: true, agenda: false, edit: false, eval: false, ph: 'I have read and agree to the [DevConf 2027 code of conduct](https://www.youtube.com/watch?v=dQw4w9WgXcQ).', val: '“must be checked” mode — consent/GDPR' },
    ],
  },
  {
    id: 'sponsor', slug: 'sponsor', name: 'Sponsor Session Request', audience: 'Invited cohort — 12 sponsor contacts',
    status: 'open', opensAt: '2026-07-01', closesAt: '2026-09-15',
    fields: [
      { id: 's_company', core: true, type: 'TXT', label: 'Company', req: true, agenda: true, edit: false, eval: true },
      { id: 's_tier', type: 'SEL', label: 'Sponsorship tier', req: true, agenda: false, edit: false, eval: true, opts: ['Platinum', 'Gold', 'Silver'], val: 'prefilled from the invite link' },
      { id: 's_title', core: true, type: 'TXT', label: 'Session title', req: true, agenda: true, edit: true, eval: true, val: 'min 8 · max 90 chars' },
      { id: 's_abstract', core: true, type: 'LONG', label: 'Session description', req: true, agenda: true, edit: true, eval: true, val: 'max 120 words · live counter', ph: 'What will attendees learn? No pure product pitches.' },
      { id: 's_demo', type: 'SEL', label: 'Includes a live product demo?', req: true, agenda: false, edit: false, eval: true, opts: ['No', 'Yes'] },
      { id: 's_av', type: 'LONG', label: 'Demo AV requirements', req: false, agenda: false, edit: true, eval: false, ph: 'Hardwired network, HDMI capture…', cond: { src: 's_demo', op: 'is', val: 'Yes', alsoReq: true } },
      { id: 's_speaker', core: true, type: 'GRP', label: 'Speaker — name, email, bio, headshot', req: true, agenda: true, edit: true, eval: false, val: 'repeats per co-speaker · cap 2' },
    ],
  },
  {
    id: 'lightning', slug: 'lightning', name: 'Lightning Talks — Wave 2', audience: 'Cohort — waitlisted speakers',
    status: 'draft', opensAt: null, closesAt: null,
    fields: [
      { id: 'l_title', core: true, type: 'TXT', label: 'Talk title', req: true, agenda: true, edit: false, eval: true, val: 'max 60 chars' },
      { id: 'l_pitch', core: true, type: 'LONG', label: 'One-paragraph pitch', req: true, agenda: false, edit: false, eval: true, val: 'max 80 words · live counter' },
      { id: 'l_speaker', core: true, type: 'GRP', label: 'Speaker — name, email', req: true, agenda: true, edit: true, eval: false, val: 'solo only · cap 1' },
    ],
  },
];

export const FORM_WELCOME_MD =
  '## Welcome to the DevConf 2027 CFP\n\nWe want **practical, hard-won lessons** — no product pitches.\n\n- 30 or 45-minute slots\n- Decisions by **Sep 20**\n- Travel support on request\n\nDrafts save automatically, so you can return any time before the deadline.';

/* --------------------------------------------------- task templates (Speakers.dc.html) */

export const REM_SUBJ = 'Reminder: “{{task_name}}” is due {{due_date}}';
export const REM_BODY =
  'Hi {{speaker_name}},\n\nA quick reminder that “{{task_name}}” for {{event_name}} is due {{due_date}} — {{days_left}} to go.\n\nEverything you need is in your speaker portal:\n{{portal_link}}\n\nAlready done? Reminders stop automatically once a task is complete, so you can ignore this.\n\n— The {{event_name}} program team';

export type SeedTaskTemplate = {
  id: string;
  name: string;
  type: 'checkbox' | 'file' | 'form' | 'profile';
  description: string;
  target: 'speaker' | 'session';
  required: boolean;
  trigger: 'confirmation' | 'acceptance' | 'manual';
  due: { mode: 'after' | 'before' | 'abs'; n: number; date?: string | null };
  grace: { mode: 'none' | 'lock'; days: number };
  lock: boolean;
  settings: Record<string, unknown>;
  clauses: { field: string; value: string }[];
  reminders: { on: boolean; days: number[]; subject: string; body: string };
};

const TT = (o: Partial<SeedTaskTemplate> & { id: string; name: string; type: SeedTaskTemplate['type'] }): SeedTaskTemplate => ({
  description: '',
  target: 'speaker',
  required: false,
  trigger: 'confirmation',
  due: { mode: 'before', n: 14, date: '2027-09-14' },
  grace: { mode: 'none', days: 3 },
  lock: false,
  settings: {},
  clauses: [],
  reminders: { on: true, days: [7, 2], subject: REM_SUBJ, body: REM_BODY },
  ...o,
});

export const TASK_TEMPLATES: SeedTaskTemplate[] = [
  TT({
    id: 't1', name: 'Confirm participation', type: 'checkbox', required: true, trigger: 'acceptance',
    due: { mode: 'after', n: 7 },
    description: 'Confirm you can make it — this puts {{session_title}} on the public agenda and unlocks your checklist.',
  }),
  TT({
    id: 't2', name: 'Complete profile', type: 'profile', required: true,
    due: { mode: 'before', n: 30, date: '2027-09-14' },
    description: 'Name, bio and headshot appear on the public agenda exactly as entered.',
  }),
  TT({
    id: 't3', name: 'Upload headshot', type: 'file', required: true,
    due: { mode: 'before', n: 30, date: '2027-09-14' },
    settings: { ext: 'jpg, png', capMb: 25, maxFiles: 1 },
    description: 'A recent photo of {{speaker_name}} for the agenda page. Square crop preferred.',
  }),
  TT({
    id: 't4', name: 'Upload slides', type: 'file', target: 'session', required: true,
    due: { mode: 'before', n: 3, date: '2027-09-14' },
    grace: { mode: 'lock', days: 2 },
    settings: { ext: 'pdf, key', capMb: 100, maxFiles: 1, sampleFile: 'DevConf-2027-slide-template.key', review: true },
    reminders: { on: true, days: [14, 7, 3, 1], subject: REM_SUBJ, body: REM_BODY },
    description: 'One deck per session — any co-speaker can upload for {{session_title}}.',
  }),
  TT({
    id: 't5', name: 'AV requirements', type: 'form', target: 'session',
    settings: { formSpec: 'AV requirements (mini-form)' },
    description: 'Stage setup for {{session_title}} — mics, demos, machine or ours.',
  }),
  TT({
    id: 't6', name: 'Travel details', type: 'form',
    settings: { formSpec: 'Travel details (mini-form)' },
    clauses: [{ field: 'Form answer', value: 'Travel support = Yes' }],
    description: 'Flights and hotel — assigned because you requested travel support.',
  }),
];

/* --------------------------------------------------- sandbox personas (spec §4.13) */

/**
 * The three seats a sandbox visitor can occupy. The picker (`/sandbox/:org`),
 * the bottom-right role switcher and the seeding all key off this table.
 * `email` is the base address — every sandbox plus-suffixes it (see
 * `suffixEmail`), so personas never collide across sandboxes.
 */
export type SandboxPersonaKey = 'organizer' | 'speaker' | 'evaluator';

export const SANDBOX_PERSONA_KEYS: SandboxPersonaKey[] = ['organizer', 'speaker', 'evaluator'];

export const SANDBOX_PERSONAS: Record<
  SandboxPersonaKey,
  { name: string; first: string; email: string; title: string; blurb: string; color: string }
> = {
  organizer: {
    name: 'Marta Keller', first: 'Marta', email: 'marta@devconf.org', title: 'Organizer',
    blurb: 'Run the program: submissions, decisions, agenda.', color: '#4c5fd5',
  },
  speaker: {
    name: 'Sofia Rossi', first: 'Sofia', email: 'sofia@syncable.app', title: 'Speaker',
    blurb: 'The speaker portal: tasks, profile, schedule.', color: '#e8590c',
  },
  evaluator: {
    name: 'Deniz Aksoy', first: 'Deniz', email: 'deniz@aksoy.dev', title: 'Evaluator',
    blurb: 'The review queue.', color: '#2b8a3e',
  },
};

/** Client-readable cookie the public layout's role-switcher widget keys off. */
export const SANDBOX_COOKIE = 'us_sandbox';

/** `local@domain` + suffix → `local+suffix@domain` — one identity per sandbox. */
export function suffixEmail(email: string, suffix: string): string {
  const [local, domain] = email.split('@');
  return `${local}+${suffix}@${domain}`;
}

/** Which sandbox persona (if any) an email belongs to, across any sandbox suffix. */
export function personaKeyForEmail(email: string | null | undefined): SandboxPersonaKey | null {
  if (!email) return null;
  for (const key of SANDBOX_PERSONA_KEYS) {
    const [local, domain] = SANDBOX_PERSONAS[key].email.split('@');
    if (email.startsWith(`${local}+`) && email.endsWith(`@${domain}`)) return key;
  }
  return null;
}
