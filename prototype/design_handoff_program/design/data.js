// Shared seed data — "DevConf 2027" sandbox, mid-lifecycle
export const EVENT = {
  name: 'DevConf 2027', slug: 'devconf-2027', tz: 'Europe/Berlin',
  dates: ['2027-10-14', '2027-10-15'], venue: 'Station Berlin', mode: 'hybrid',
  theme: { primary: '#e8590c', accent: '#1a1a2e', bg: '#faf8f5', font: 'Space Grotesk' }
};

export const TRACKS = [
  { id: 'ai', name: 'AI & ML', color: '#7048e8' },
  { id: 'web', name: 'Web Platform', color: '#1c7ed6' },
  { id: 'infra', name: 'Infrastructure', color: '#0ca678' },
  { id: 'sec', name: 'Security', color: '#e03131' },
  { id: 'dx', name: 'Developer Experience', color: '#e8590c' }
];
export const FORMATS = ['Talk (30 min)', 'Deep Dive (45 min)', 'Workshop (90 min)', 'Lightning (10 min)', 'Panel (45 min)'];
export const LEVELS = ['Intro', 'Intermediate', 'Advanced'];
export const ROOMS = ['Main Stage', 'Room 2', 'Room 3', 'Workshop Lab'];

// Submission forms — one event can run several, each aimed at a different cohort
export const FORMS = [
  { id: 'cfp', name: 'Call for Speakers — Main CFP', audience: 'Public link — anyone', status: 'open', closes: 'Aug 31, 2026', link: 'app.com/devconf-2027/cfp' },
  { id: 'sponsor', name: 'Sponsor Session Request', audience: 'Invited cohort — 12 sponsor contacts', status: 'open', closes: 'Sep 15, 2026', link: 'app.com/devconf-2027/sponsor' },
  { id: 'lightning', name: 'Lightning Talks — Wave 2', audience: 'Cohort — waitlisted speakers', status: 'draft', closes: '—', link: 'not published' }
];

export const STATUS = {
  submitted:  { label: 'Submitted',  fg: '#1c7ed6', bg: '#e7f1fb' },
  in_review:  { label: 'In Review',  fg: '#b08800', bg: '#fdf5dc' },
  accepted:   { label: 'Accepted',   fg: '#2b8a3e', bg: '#e6f4ea' },
  confirmed:  { label: 'Confirmed',  fg: '#087f5b', bg: '#dcf2eb' },
  declined:   { label: 'Declined',   fg: '#c92a2a', bg: '#fbe9e9' },
  waitlisted: { label: 'Waitlisted', fg: '#9c36b5', bg: '#f6e8f9' },
  withdrawn:  { label: 'Withdrawn',  fg: '#868e96', bg: '#f1f3f5' }
};

const S = (id, title, abstract, sp, track, format, level, status, evalDone, evalTotal, avg, days) => ({
  id: 'SUB-' + id, title, abstract, speakers: sp, track, format, level, status,
  evalDone, evalTotal, avg, submitted: `Jul ${days}, 2026`, form: 'cfp'
});
const sp = (name, email, bio) => ({ name, email, bio });

export const SUBMISSIONS = [
  S(147, 'Postgres at the Edge: Read Replicas Everywhere', 'How we cut p99 latency 6x by pushing read replicas to 14 regions, and every mistake we made on the way.', [sp('Amara Diallo', 'amara@fastly.dev', 'Staff engineer, databases. Previously Citus.')], 'infra', 'Deep Dive (45 min)', 'Advanced', 'in_review', 2, 3, 4.3, 28),
  S(146, 'The Case Against Microservices (From Someone Who Sold Them)', 'A consultant who spent five years selling service meshes explains when a monolith is the grown-up choice.', [sp('Viktor Hansen', 'viktor@meshless.io', 'Independent consultant, ex-Istio contributor.')], 'infra', 'Talk (30 min)', 'Intermediate', 'confirmed', 3, 3, 4.7, 27),
  S(145, 'Prompt Injection Is the New SQL Injection', 'Live-exploiting an LLM-powered support bot on stage, then hardening it step by step.', [sp('Ines Kovač', 'ines@nullsec.eu', 'Security researcher. CVE collector.')], 'sec', 'Talk (30 min)', 'Intermediate', 'confirmed', 3, 3, 4.8, 26),
  S(144, 'CSS Grid Level 3: Masonry Is Finally Real', 'A tour of masonry layout in production browsers, with fallback strategies you can ship today.', [sp('Priya Raman', 'priya@webfoundry.co', 'Design engineer and CSSWG observer.')], 'web', 'Talk (30 min)', 'Intro', 'accepted', 3, 3, 4.1, 26),
  S(143, 'Fine-Tuning Is Dead, Long Live Fine-Tuning', 'When RAG fails, when adapters win, and the decision tree we use with every client.', [sp('Tomás Rivera', 'tomas@adapt.ml', 'ML lead at a 12-person applied-AI shop.')], 'ai', 'Deep Dive (45 min)', 'Advanced', 'in_review', 1, 3, 3.5, 25),
  S(142, 'Ship Your Design System Without a Design Team', 'How a 6-person startup maintains a coherent UI with tokens, lint rules, and zero designers.', [sp('Lena Fischer', 'lena@tinystack.app', 'Founding engineer. Accidental design lead.')], 'dx', 'Talk (30 min)', 'Intro', 'accepted', 3, 3, 3.9, 25),
  S(141, 'Kubernetes the Hard Way, Five Years Later', 'Re-running the classic exercise on 2027 infrastructure. What got easier, and what still hurts.', [sp('Dmitri Volkov', 'dmitri@baremetal.sh', 'Platform engineer, on-prem believer.')], 'infra', 'Workshop (90 min)', 'Advanced', 'in_review', 2, 3, 3.2, 24),
  S(140, 'Passkeys in Production: 18 Months In', 'Adoption curves, support tickets, and the account-recovery flows nobody warns you about.', [sp('Sarah Okafor', 'sarah@authlayer.com', 'Product engineer, identity.'), sp('Jon Marsh', 'jon@authlayer.com', 'Support lead turned engineer.')], 'sec', 'Talk (30 min)', 'Intermediate', 'confirmed', 3, 3, 4.5, 24),
  S(139, 'A Love Letter to Boring Technology', 'Our stack is Django, Postgres, and cron. We serve 40M requests a day. Ask me anything.', [sp('Mei Chen', 'mei@steadyship.io', 'CTO. Professional resister of rewrites.')], 'infra', 'Talk (30 min)', 'Intro', 'accepted', 3, 3, 4.4, 23),
  S(138, 'WebGPU Beyond Graphics: Compute in the Browser', 'Running real ML inference client-side. Covers architecture, quantization, and when not to bother.', [sp('Felix Braun', 'felix@gpuweb.dev', 'Graphics programmer gone rogue.')], 'web', 'Deep Dive (45 min)', 'Advanced', 'in_review', 2, 3, 4.0, 23),
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
  S(122, 'Chaos Engineering on a Budget', 'You do not need a chaos platform. You need a Tuesday, a script, and management buy-in.', [sp('Kwame Mensah', 'kwame@faultline.dev', 'SRE, professional breaker of staging.')], 'infra', 'Lightning (10 min)', 'Intro', 'declined', 3, 3, 2.2, 10),
  S(121, 'Local-First Apps: Sync Engines in Anger', 'CRDTs in production: conflict UX, storage costs, and the bug that ate a week of edits.', [sp('Sofia Rossi', 'sofia@syncable.app', 'Product engineer, local-first convert.'), sp('Tim Okada', 'tim@syncable.app', 'Distributed-systems engineer.')], 'web', 'Deep Dive (45 min)', 'Advanced', 'confirmed', 3, 3, 4.6, 9),
  S(120, 'Burnout-Proofing Your On-Call Rotation', 'Alert budgets, follow-the-sun handoffs, and the metric that predicted every resignation.', [sp('Aisha Khan', 'aisha@humanops.co', 'Engineering manager, SRE background.')], 'infra', 'Talk (30 min)', 'Intro', 'withdrawn', 2, 3, 4.0, 8),
  { id: 'SUB-S02', form: 'sponsor', title: 'Scaling Without Servers — Live Architecture Review', abstract: 'Vercel Cloud engineers rebuild a real attendee architecture on stage, serverless-first.', speakers: [sp('Rachel Kim', 'rachel@vercelcloud.com', 'DevRel lead, Vercel Cloud (Platinum sponsor).')], track: 'infra', format: 'Talk (30 min)', level: 'Intro', status: 'accepted', evalDone: 1, evalTotal: 1, avg: 3.8, submitted: 'Aug 2, 2026' },
  { id: 'SUB-S01', form: 'sponsor', title: 'Observability on Autopilot', abstract: 'Zero-code instrumentation of a polyglot stack with the new Datastack agent. Includes a live install.', speakers: [sp('Marco Silva', 'marco@datastack.io', 'Solutions engineer, Datastack (Gold sponsor).')], track: 'infra', format: 'Talk (30 min)', level: 'Intermediate', status: 'in_review', evalDone: 1, evalTotal: 1, avg: 3.1, submitted: 'Jul 30, 2026' }
];

// Agenda: day 1 grid placements. start/end in minutes from 08:00. type: talk|service|sponsor
export const AGENDA = [
  { id: 'A1', title: 'Registration & Coffee', type: 'service', room: 'ALL', day: 0, start: 30, end: 90 },
  { id: 'A2', title: 'Opening Keynote: The Next Decade of Dev Tools', type: 'talk', speakers: 'Mei Chen', track: 'dx', room: 'Main Stage', day: 0, start: 90, end: 150, sub: 'SUB-139', status: 'confirmed' },
  { id: 'A3', title: 'Coffee Break', type: 'service', room: 'ALL', day: 0, start: 150, end: 180 },
  { id: 'A4', title: 'Prompt Injection Is the New SQL Injection', type: 'talk', speakers: 'Ines Kovač', track: 'sec', room: 'Main Stage', day: 0, start: 180, end: 210, sub: 'SUB-145', status: 'confirmed' },
  { id: 'A5', title: 'Passkeys in Production: 18 Months In', type: 'talk', speakers: 'Sarah Okafor, Jon Marsh', track: 'sec', room: 'Room 2', day: 0, start: 180, end: 210, sub: 'SUB-140', status: 'confirmed' },
  { id: 'A6', title: 'LLM Evals Are Your New Unit Tests', type: 'talk', speakers: 'Hana Yoshida', track: 'ai', room: 'Workshop Lab', day: 0, start: 180, end: 270, sub: 'SUB-135', status: 'confirmed' },
  { id: 'A7', title: 'Lunch', type: 'service', room: 'ALL', day: 0, start: 270, end: 330 },
  { id: 'A8', title: 'Scaling Without Servers — Vercel Cloud', type: 'sponsor', speakers: 'Sponsor session', track: 'infra', room: 'Room 3', day: 0, start: 330, end: 360 },
  { id: 'A9', title: 'The Case Against Microservices', type: 'talk', speakers: 'Viktor Hansen', track: 'infra', room: 'Main Stage', day: 0, start: 330, end: 360, sub: 'SUB-146', status: 'confirmed' },
  // deliberate conflict: Ines Kovač double-booked at 14:00 (A10 vs A11)
  { id: 'A10', title: 'Live Threat Hunting Q&A', type: 'talk', speakers: 'Ines Kovač', track: 'sec', room: 'Room 2', day: 0, start: 360, end: 390, status: 'pending' },
  { id: 'A11', title: 'Security AMA Panel', type: 'talk', speakers: 'Ines Kovač, Nadia Petrova', track: 'sec', room: 'Room 3', day: 0, start: 360, end: 390, status: 'pending' },
  { id: 'A12', title: 'Local-First Apps: Sync Engines in Anger', type: 'talk', speakers: 'Sofia Rossi, Tim Okada', track: 'web', room: 'Main Stage', day: 0, start: 390, end: 435, sub: 'SUB-121', status: 'confirmed' },
  { id: 'A13', title: 'Afternoon Break', type: 'service', room: 'ALL', day: 0, start: 435, end: 465 },
  { id: 'A14', title: 'CSS Grid Level 3: Masonry Is Finally Real', type: 'talk', speakers: 'Priya Raman', track: 'web', room: 'Room 2', day: 1, start: 90, end: 120, sub: 'SUB-144', status: 'pending' },
  { id: 'A15', title: 'Rust for TypeScript Developers', type: 'talk', speakers: 'Diego Fuentes', track: 'dx', room: 'Workshop Lab', day: 1, start: 90, end: 180, sub: 'SUB-132', status: 'pending' },
  { id: 'A16', title: 'Registration & Coffee', type: 'service', room: 'ALL', day: 1, start: 30, end: 90 },
  { id: 'A17', title: 'Lunch', type: 'service', room: 'ALL', day: 1, start: 270, end: 330 }
];

export const UNSCHEDULED = [
  { id: 'U1', title: 'A Love Letter to Boring Technology', speakers: 'Mei Chen', track: 'infra', dur: 30, sub: 'SUB-139', status: 'confirmed' },
  { id: 'U2', title: 'Ship Your Design System Without a Design Team', speakers: 'Lena Fischer', track: 'dx', dur: 30, sub: 'SUB-142', status: 'accepted' },
  { id: 'U3', title: 'Zero-Downtime Schema Changes at 2TB', speakers: 'Anouk Visser', track: 'infra', dur: 45, sub: 'SUB-133', status: 'accepted' },
  { id: 'U4', title: 'How We Got Pwned (and What It Cost)', speakers: 'Nadia Petrova', track: 'sec', dur: 30, sub: 'SUB-131', status: 'accepted' },
  { id: 'U5', title: 'Postgres at the Edge', speakers: 'Amara Diallo', track: 'infra', dur: 45, sub: 'SUB-147', status: 'accepted' }
];

export const TASKS = ['Confirm participation', 'Complete profile', 'Upload headshot', 'Upload slides', 'AV requirements', 'Travel details'];
// t: c=complete, p=pending, o=overdue, -=n/a
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
  { name: 'Lena Fischer', session: 'Ship Your Design System', track: 'dx', t: ['p', 'p', 'p', 'p', 'p', 'p'] }
];

// Evaluation committees — people who can be assigned as evaluators
export const PEOPLE = [
  { id: 'marta', name: 'Marta Keller', email: 'marta@devconf.org', role: 'Organizer' },
  { id: 'deniz', name: 'Deniz Aksoy', email: 'deniz@aksoy.dev', role: 'Evaluator' },
  { id: 'priya', name: 'Priya Nair', email: 'priya.n@webfoundry.co', role: 'Evaluator' },
  { id: 'sam', name: 'Sam Ortiz', email: 'sam@ortiz.codes', role: 'Evaluator' },
  { id: 'jonas', name: 'Jonas Weber', email: 'jonas@sec-audit.de', role: 'Evaluator' },
  { id: 'elif', name: 'Elif Şahin', email: 'elif@mlberlin.io', role: 'Evaluator' },
  { id: 'tom', name: 'Tom Baker', email: 'tom@devrel.uk', role: 'Evaluator' },
  { id: 'grace', name: 'Grace Osei', email: 'grace@platformlab.gh', role: 'Evaluator' }
];

// Committees: members review the committee's submissions. rules == saved scope (variation C).
export const COMMITTEES = [
  { id: 'main', name: 'Main CFP Committee', desc: 'Blind review of every open public-CFP submission.', blind: true, reviewsPer: 3, deadline: 'Aug 24, 2026', dist: '3',
    members: [{ id: 'marta', role: 'chair' }, { id: 'deniz', role: 'reviewer' }, { id: 'priya', role: 'reviewer' }, { id: 'sam', role: 'reviewer' }, { id: 'grace', role: 'reviewer' }],
    rules: [{ field: 'form', value: 'cfp' }, { field: 'status', value: 'needs_review' }],
    subs: ['SUB-147', 'SUB-143', 'SUB-141', 'SUB-138', 'SUB-136', 'SUB-133', 'SUB-131', 'SUB-129', 'SUB-128', 'SUB-127', 'SUB-126', 'SUB-125', 'SUB-124'] },
  { id: 'ai', name: 'AI Track Deep-Dive', desc: 'Second-opinion pass on AI & ML proposals by domain experts.', blind: false, reviewsPer: 2, deadline: 'Aug 28, 2026', dist: 'all',
    members: [{ id: 'elif', role: 'chair' }, { id: 'deniz', role: 'reviewer' }],
    rules: [{ field: 'track', value: 'ai' }, { field: 'status', value: 'needs_review' }],
    subs: ['SUB-143', 'SUB-127', 'SUB-124'] },
  { id: 'sponsor', name: 'Sponsor Sessions', desc: 'Light-touch quality check of invited sponsor slots.', blind: false, reviewsPer: 1, deadline: 'Sep 18, 2026', dist: 'all',
    members: [{ id: 'marta', role: 'chair' }, { id: 'tom', role: 'reviewer' }],
    rules: [{ field: 'form', value: 'sponsor' }],
    subs: ['SUB-S01', 'SUB-S02'] }
];

export const fmtTime = (m) => { const h = Math.floor((480 + m) / 60), mm = (480 + m) % 60; return `${h}:${mm.toString().padStart(2, '0')}`; };
export const trackOf = (id) => TRACKS.find(t => t.id === id) || { name: '—', color: '#adb5bd' };

// Plan-first evaluation: a plan bundles reviewer instructions/criteria, reviewers, and the submissions they score.
// Reviewers rate each criterion; a submission's result is the average cumulative (summed) score across reviewers.
export const EVAL_PLANS = [
  { id: 'main', name: 'Main CFP Review', deadline: 'Aug 24, 2026', anonymized: true, reminders: true, reviewsPer: 3,
    rules: { track: 'all', form: 'cfp', format: 'all', level: 'all', status: 'active' },
    instructions: 'Score every criterion on the 1–5 scale. Reserve 5s for talks you would put on the main stage. Judge the proposal, not the speaker. Identities are hidden. If you recognize the submitter anyway, abstain instead of scoring.',
    criteria: [
      { name: 'Relevance', hint: 'Fits this audience?', scale: 5 },
      { name: 'Depth', hint: 'Substance over hype?', scale: 5 },
      { name: 'Delivery', hint: 'Will it land on stage?', scale: 5 }
    ],
    reviewers: [{ id: 'marta', role: 'chair' }, { id: 'deniz', role: 'member' }, { id: 'priya', role: 'member' }, { id: 'sam', role: 'member' }, { id: 'grace', role: 'member' }],
    subs: ['SUB-147', 'SUB-143', 'SUB-141', 'SUB-138', 'SUB-136', 'SUB-133', 'SUB-131', 'SUB-129', 'SUB-128', 'SUB-127', 'SUB-126', 'SUB-125', 'SUB-124'] },
  { id: 'ai', name: 'AI Track Second Opinion', deadline: 'Aug 28, 2026', anonymized: false, reminders: true, reviewsPer: 2,
    rules: { track: 'ai', form: 'all', format: 'all', level: 'all', status: 'active' },
    instructions: 'Expert pass on AI & ML proposals. Program fit is already covered by the main review. Judge technical substance only.',
    criteria: [
      { name: 'Novelty', hint: 'New ground, not a rehash?', scale: 5 },
      { name: 'Rigor', hint: 'Would an expert nod along?', scale: 5 }
    ],
    reviewers: [{ id: 'elif', role: 'member' }, { id: 'deniz', role: 'member' }],
    subs: ['SUB-143', 'SUB-127', 'SUB-124'] },
  { id: 'sponsor', name: 'Sponsor Session Check', deadline: 'Sep 18, 2026', anonymized: false, reminders: false, reviewsPer: 1,
    rules: { track: 'all', form: 'sponsor', format: 'all', level: 'all', status: 'all' },
    instructions: 'Light-touch quality check of invited sponsor slots. Flag anything that reads as a pure sales pitch.',
    criteria: [
      { name: 'Audience value', hint: 'Useful even if you never buy?', scale: 5 },
      { name: 'Stage-ready', hint: 'Demo survives a live room?', scale: 5 }
    ],
    reviewers: [{ id: 'marta', role: 'chair' }, { id: 'tom', role: 'member' }],
    subs: ['SUB-S01', 'SUB-S02'] }
];
