/**
 * Sandbox provisioning (spec §4.13, DECISIONS D11).
 *
 * Turns `seed-data.ts` (the prototype's `data.js` + the Forms / Speakers /
 * Evaluation seeds) into a complete DevConf 2027 event mid-lifecycle: forms
 * with schemas, ~30 submissions in every state, part-done evaluations whose
 * averages match the prototype, an agenda that still contains the deliberate
 * Ines Kovač double-booking, speaker profiles, and the speakers × tasks grid.
 *
 * The visitor is never a throwaway user: the three picker personas (Marta
 * Keller the org owner, Sofia Rossi the speaker, Deniz Aksoy the evaluator)
 * are real seeded users whose emails are plus-suffixed per sandbox, and
 * `routes/sandbox.tsx` signs the visitor in as one of them.
 */
import { batch, now, run } from './db';
import { newId, shortCode } from './ids';
import { slugify } from './slugify';
import { DEFAULT_EMAIL_TEMPLATES } from './defaults';
import { seedOf } from './evals';
import { filesEnabled, saveUpload } from './files';
import { abstractPdf } from './seed-pdf';
import * as D from './seed-data';
import type { Bindings } from '../types';

type Stmt = [string, unknown[]];

export type SandboxPersonaUser = { userId: string; email: string; name: string };

export type SandboxResult = {
  orgId: string;
  eventId: string;
  slug: string;
  suffix: string;
  /** The three picker seats — real users the visitor signs in as (spec §4.13). */
  personas: Record<D.SandboxPersonaKey, SandboxPersonaUser>;
};

/** Split "A, B" speaker strings from the agenda seed. */
function names(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x && x !== 'Sponsor session');
}

/**
 * Integer 1..5 scores whose mean lands on `avg` (within rounding), spread
 * deterministically across `reviewers × criteria` slots.
 */
function scoreMatrix(avg: number | null, reviewers: number, criteria: number): number[][] {
  const slots = reviewers * criteria;
  if (!slots) return [];
  const target = Math.round((avg ?? 3) * slots);
  const base = Math.max(1, Math.min(5, Math.floor(target / slots)));
  let remainder = target - base * slots;
  const flat: number[] = [];
  for (let i = 0; i < slots; i++) {
    let v = base;
    if (remainder > 0 && base < 5) {
      v = base + 1;
      remainder--;
    }
    flat.push(Math.max(1, Math.min(5, v)));
  }
  const out: number[][] = [];
  for (let r = 0; r < reviewers; r++) out.push(flat.slice(r * criteria, (r + 1) * criteria));
  return out;
}

function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Generates the extended-abstract PDFs of `D.SUBMISSION_PAPERS` and stores
 * them through the normal upload path, so a seeded attachment is
 * indistinguishable from one a speaker uploaded — same R2 key shape, same
 * `files` row, same `/files/:id` download. Without an R2 binding the sandbox
 * simply has no attachments; every other screen is unaffected.
 */
async function seedPapers(
  env: Bindings,
  eventId: string,
  submissionId: Map<string, string>
): Promise<Map<string, { field: string; fileId: string }>> {
  const out = new Map<string, { field: string; fileId: string }>();
  if (!filesEnabled(env)) return out;

  for (const paper of D.SUBMISSION_PAPERS) {
    const s = D.SUBMISSIONS.find((x) => x.id === paper.sub);
    const subId = submissionId.get(paper.sub);
    if (!s || !subId) continue;
    const pdf = abstractPdf({
      event: D.EVENT.name,
      title: s.title,
      byline: s.speakers.map((sp) => `${sp.name} · ${sp.email}`).join(' · '),
      meta: [D.TRACKS.find((t) => t.id === s.track)?.name, s.format, s.level].filter(Boolean).join(' · '),
      summary: [s.abstract, ...paper.summary],
      takeaways: paper.takeaways,
      minutes: D.FORMATS.find((f) => f.label === s.format)?.duration ?? 30,
      submitted: s.submitted,
    });
    const res = await saveUpload(env, {
      eventId,
      kind: 'upload',
      subjectType: 'submission',
      subjectId: `${subId}:${paper.field}`,
      file: new File([pdf], paper.filename, { type: 'application/pdf' }),
      maxMb: 10,
      allowedExts: 'pdf',
    });
    if (res.ok) out.set(paper.sub, { field: paper.field, fileId: res.file.id });
  }
  return out;
}

export async function seedSandbox(env: Bindings): Promise<SandboxResult> {
  const db = env.DB;
  const suffix = shortCode(4);
  const stamp = now();
  const orgId = newId('org');
  const eventId = newId('evt');
  const slug = `${D.EVENT.slug}-${suffix}`;

  await run(db, `INSERT INTO orgs (id, name, is_sandbox, created_at) VALUES (?,?,1,?)`, orgId, 'DevConf (sandbox)', stamp);
  await run(
    db,
    `INSERT INTO events (id, org_id, name, slug, start_date, end_date, timezone, venue, mode, description,
       theme_json, day_start_min, day_end_min, published, hide_unconfirmed, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    eventId,
    orgId,
    D.EVENT.name,
    slug,
    D.EVENT.dates[0],
    D.EVENT.dates[1],
    D.EVENT.tz,
    D.EVENT.venue,
    D.EVENT.mode,
    'Two days of practical, hard-won engineering lessons in Berlin and online.',
    JSON.stringify(D.EVENT.theme),
    30,
    600,
    1,
    1,
    stamp
  );

  const stmts: Stmt[] = [];

  /* ---------------------------------------------------------------- rooms */
  const roomIds = new Map<string, string>();
  D.ROOMS.forEach((r) => {
    const id = newId('rom');
    roomIds.set(r.name, id);
    stmts.push([
      `INSERT INTO rooms (id, event_id, name, capacity, priority) VALUES (?,?,?,?,?)`,
      [id, eventId, r.name, r.capacity, r.priority],
    ]);
  });

  /* ----------------------------------------------------------- taxonomies */
  const trackOptId = new Map<string, string>(); // seed track id -> option id
  const trackOptByName = new Map<string, string>();
  const formatOptByLabel = new Map<string, string>();

  const trackTaxId = newId('tax');
  stmts.push([
    `INSERT INTO taxonomies (id, event_id, name, has_color, has_duration, position) VALUES (?,?,?,1,0,0)`,
    [trackTaxId, eventId, 'Track'],
  ]);
  D.TRACKS.forEach((t, i) => {
    const id = newId('tpo');
    trackOptId.set(t.id, id);
    trackOptByName.set(t.name, id);
    stmts.push([
      `INSERT INTO taxonomy_options (id, taxonomy_id, name, color, duration_min, position) VALUES (?,?,?,?,NULL,?)`,
      [id, trackTaxId, t.name, t.color, i],
    ]);
  });

  const formatTaxId = newId('tax');
  stmts.push([
    `INSERT INTO taxonomies (id, event_id, name, has_color, has_duration, position) VALUES (?,?,?,0,1,1)`,
    [formatTaxId, eventId, 'Format'],
  ]);
  D.FORMATS.forEach((f, i) => {
    const id = newId('tpo');
    formatOptByLabel.set(f.label, id);
    stmts.push([
      `INSERT INTO taxonomy_options (id, taxonomy_id, name, color, duration_min, position) VALUES (?,?,?,NULL,?,?)`,
      [id, formatTaxId, f.name, f.duration, i],
    ]);
  });

  const levelTaxId = newId('tax');
  stmts.push([
    `INSERT INTO taxonomies (id, event_id, name, has_color, has_duration, position) VALUES (?,?,?,0,0,2)`,
    [levelTaxId, eventId, 'Level'],
  ]);
  D.LEVELS.forEach((l, i) => {
    stmts.push([
      `INSERT INTO taxonomy_options (id, taxonomy_id, name, color, duration_min, position) VALUES (?,?,?,NULL,NULL,?)`,
      [newId('tpo'), levelTaxId, l, i],
    ]);
  });

  const durationOf = (label: string) => D.FORMATS.find((f) => f.label === label)?.duration ?? 30;

  /* --------------------------------------------------------------- forms */
  const formIds = new Map<string, string>();
  const formVersionIds = new Map<string, string>();
  D.FORMS.forEach((f) => {
    const id = newId('frm');
    const vid = newId('fvr');
    formIds.set(f.id, id);
    formVersionIds.set(f.id, vid);
    stmts.push([
      `INSERT INTO forms (id, event_id, name, slug, status, opens_at, closes_at, settings_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        id,
        eventId,
        f.name,
        f.slug,
        f.status,
        f.opensAt,
        f.closesAt,
        JSON.stringify({
          allowDrafts: true,
          lateLinkSecret: null,
          welcomeMd: f.id === 'cfp' ? D.FORM_WELCOME_MD : '',
          coSpeakerCap: f.id === 'cfp' ? 3 : f.id === 'sponsor' ? 2 : 1,
          postSubmitMsg: '',
          notifyEmails: [],
          audience: f.audience,
        }),
        stamp,
      ],
    ]);
    stmts.push([
      `INSERT INTO form_versions (id, form_id, version, schema_json, created_at) VALUES (?,?,1,?,?)`,
      [vid, id, JSON.stringify({ fields: f.fields }), stamp],
    ]);
  });

  /* --------------------------------------------------------- email templates */
  for (const t of DEFAULT_EMAIL_TEMPLATES) {
    stmts.push([
      `INSERT INTO email_templates (id, event_id, key, name, subject, body, updated_at) VALUES (?,?,?,?,?,?,?)`,
      [newId('etp'), eventId, t.key, t.name, t.subject, t.body, stamp],
    ]);
  }

  /* ---------------------------------------------------------- seeded people */
  // Every seeded person's email is plus-addressed per sandbox so several
  // sandboxes can coexist (users.email is globally unique, and the speaker
  // portal / evaluate queue match people by email).
  const personUserId = new Map<string, string>();
  D.PEOPLE.forEach((p) => {
    const id = newId('usr');
    personUserId.set(p.id, id);
    stmts.push([
      `INSERT INTO users (id, email, name, google_id, created_at) VALUES (?,?,?,NULL,?)`,
      [id, D.suffixEmail(p.email, suffix), p.name, stamp],
    ]);
  });

  // Speaker persona — Sofia Rossi gets a real user so the picker can sign the
  // visitor in as her; her speaker profile links back via user_id below.
  const speakerPersonaEmail = D.suffixEmail(D.SANDBOX_PERSONAS.speaker.email, suffix);
  const speakerPersonaUserId = newId('usr');
  stmts.push([
    `INSERT INTO users (id, email, name, google_id, created_at) VALUES (?,?,?,NULL,?)`,
    [speakerPersonaUserId, speakerPersonaEmail, D.SANDBOX_PERSONAS.speaker.name, stamp],
  ]);

  // The whole roster joins the org: Marta Keller as owner (the organizer
  // persona — the visitor's session IS Marta, there is no throwaway owner
  // user), the program team as admins/collaborators, and the outside
  // evaluators as collaborators so the reviewer picker can offer them.
  D.PEOPLE.forEach((p) => {
    stmts.push([
      `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?,?,?,?)`,
      [orgId, personUserId.get(p.id)!, p.orgRole, stamp],
    ]);
  });

  D.INVITES.forEach((i) => {
    stmts.push([
      `INSERT INTO invites (id, org_id, email, role, invited_by, status, created_at) VALUES (?,?,?,?,?,'pending',?)`,
      [newId('inv'), orgId, D.suffixEmail(i.email, suffix), i.role, personUserId.get('marta')!, stamp],
    ]);
  });

  /* ---------------------------------------------------------- submissions */
  const submissionId = new Map<string, string>(); // 'SUB-147' -> row id
  let seq = 0;
  const ordered = [...D.SUBMISSIONS].sort((a, b) => a.submitted.localeCompare(b.submitted));
  const seqOf = new Map<string, number>();
  ordered.forEach((s) => {
    const m = /^SUB-(\d+)$/.exec(s.id);
    seqOf.set(s.id, m ? Number(m[1]) : ++seq);
  });
  // Sponsor submissions keep going after the highest CFP number.
  let maxSeq = Math.max(...[...seqOf.values()].filter((n) => n > 0));
  D.SUBMISSIONS.filter((s) => !/^SUB-\d+$/.test(s.id)).forEach((s) => {
    seqOf.set(s.id, ++maxSeq);
  });

  // Row ids first: the attachment PDFs below are stored against their
  // submission before any of these INSERTs run.
  D.SUBMISSIONS.forEach((s) => submissionId.set(s.id, newId('sub')));
  const paperFileIds = await seedPapers(env, eventId, submissionId);

  D.SUBMISSIONS.forEach((s) => {
    const id = submissionId.get(s.id)!;
    const answers: Record<string, unknown> = {};
    if (s.form === 'cfp') {
      answers.f_title = s.title;
      answers.f_abstract = s.abstract;
      answers.f_format = s.format;
      answers.f_track = D.TRACKS.find((t) => t.id === s.track)?.name ?? '';
      answers.f_level = s.level;
      answers.f_coc = true;
      // FILE answers are id lists, exactly as the public form posts them.
      const paper = paperFileIds.get(s.id);
      if (paper) answers[paper.field] = [paper.fileId];
    } else {
      answers.s_title = s.title;
      answers.s_abstract = s.abstract;
      answers.s_company = s.speakers[0]?.bio.includes('Vercel') ? 'Vercel Cloud' : 'Datastack';
      answers.s_tier = s.id === 'SUB-S02' ? 'Platinum' : 'Gold';
      answers.s_demo = 'Yes';
    }
    const submittedAt = `${s.submitted}T09:00:00Z`;
    stmts.push([
      `INSERT INTO submissions (id, event_id, form_id, form_version_id, seq, status, title, abstract, answers_json,
         owner_user_id, agent_mode, withdraw_reason, submitted_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,0,?,?,?,?)`,
      [
        id,
        eventId,
        formIds.get(s.form)!,
        formVersionIds.get(s.form)!,
        seqOf.get(s.id)!,
        s.status,
        s.title,
        s.abstract,
        JSON.stringify(answers),
        s.status === 'withdrawn' ? 'Schedule conflict — cannot travel that week' : null,
        submittedAt,
        submittedAt,
        submittedAt,
      ],
    ]);
    s.speakers.forEach((sp, i) => {
      const email = D.suffixEmail(sp.email, suffix);
      stmts.push([
        `INSERT INTO submission_speakers (id, submission_id, position, name, email, bio, headshot_file_id, user_id)
         VALUES (?,?,?,?,?,?,NULL,?)`,
        [newId('ssp'), id, i, sp.name, email, sp.bio, email === speakerPersonaEmail ? speakerPersonaUserId : null],
      ]);
    });
  });

  stmts.push([
    `INSERT INTO counters (event_id, key, value) VALUES (?,?,?)`,
    [eventId, 'submission', maxSeq],
  ]);

  /* ------------------------------------------------------- speaker profiles */
  // Profile emails are the plus-suffixed ones — the portal finds a speaker's
  // profile, submissions and tasks by the signed-in user's email.
  const profileId = new Map<string, string>(); // speaker name -> profile id
  const seenSlugs = new Set<string>();
  const addProfile = (name: string, email: string, bio: string) => {
    if (profileId.has(name)) return;
    let s = slugify(name, 'speaker');
    let n = 2;
    while (seenSlugs.has(s)) s = `${slugify(name, 'speaker')}-${n++}`;
    seenSlugs.add(s);
    const id = newId('spk');
    profileId.set(name, id);
    stmts.push([
      `INSERT INTO speaker_profiles (id, event_id, user_id, email, name, bio, headshot_file_id, slug, created_at)
       VALUES (?,?,?,?,?,?,NULL,?,?)`,
      [id, eventId, email === speakerPersonaEmail ? speakerPersonaUserId : null, email, name, bio, s, stamp],
    ]);
  };
  D.SUBMISSIONS.forEach((s) => s.speakers.forEach((sp) => addProfile(sp.name, D.suffixEmail(sp.email, suffix), sp.bio)));

  /* ------------------------------------------------------------- sessions */
  const sessionIdBySub = new Map<string, string>();
  const sessionIdByGridName = new Map<string, string>();

  const pushSession = (opts: {
    subKey?: string;
    type: string;
    title: string;
    abstract?: string;
    track?: string;
    speakerNames: string[];
    room?: string | null;
    allRooms?: boolean;
    day: number | null;
    start: number | null;
    end: number | null;
    status: string;
    duration: number;
    format?: string | null;
    level?: string | null;
    sponsorName?: string | null;
  }) => {
    const id = newId('ses');
    if (opts.subKey && !sessionIdBySub.has(opts.subKey)) sessionIdBySub.set(opts.subKey, id);
    stmts.push([
      `INSERT INTO sessions (id, event_id, submission_id, type, title, abstract, track_option_id, format_option_id,
         level, duration_min, room_id, all_rooms, day, start_min, end_min, status, published, sponsor_name,
         stream_url, visibility_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?)`,
      [
        id,
        eventId,
        opts.subKey ? submissionId.get(opts.subKey) ?? null : null,
        opts.type,
        opts.title,
        opts.abstract ?? '',
        opts.track ? trackOptId.get(opts.track) ?? null : null,
        opts.format ? formatOptByLabel.get(opts.format) ?? null : null,
        opts.level ?? null,
        opts.duration,
        opts.allRooms ? null : opts.room ? roomIds.get(opts.room) ?? null : null,
        opts.allRooms ? 1 : 0,
        opts.day,
        opts.start,
        opts.end,
        opts.status,
        opts.type === 'service' ? 1 : 1,
        opts.sponsorName ?? null,
        stamp,
        stamp,
      ],
    ]);
    opts.speakerNames.forEach((n, i) => {
      const pid = profileId.get(n);
      if (!pid) return;
      stmts.push([
        `INSERT INTO session_speakers (session_id, speaker_profile_id, position) VALUES (?,?,?)`,
        [id, pid, i],
      ]);
      if (!sessionIdByGridName.has(n)) sessionIdByGridName.set(n, id);
    });
    return id;
  };

  D.AGENDA.forEach((a) => {
    const sub = a.sub ? D.SUBMISSIONS.find((s) => s.id === a.sub) : undefined;
    const speakerNames = sub ? sub.speakers.map((s) => s.name) : names(a.speakers);
    pushSession({
      subKey: a.sub,
      type: a.type,
      title: a.title,
      abstract: sub?.abstract ?? '',
      track: a.track,
      speakerNames,
      room: a.room === 'ALL' ? null : a.room,
      allRooms: a.room === 'ALL',
      day: a.day,
      start: a.start,
      end: a.end,
      status: (a as { status?: string }).status ?? (a.type === 'service' ? 'confirmed' : 'pending'),
      duration: a.end - a.start,
      format: sub?.format ?? null,
      level: sub?.level ?? null,
      sponsorName: a.type === 'sponsor' ? (sub?.speakers[0]?.bio.includes('Vercel') ? 'Vercel Cloud' : 'Datastack') : null,
    });
  });

  D.UNSCHEDULED.forEach((u) => {
    const sub = D.SUBMISSIONS.find((s) => s.id === u.sub);
    pushSession({
      subKey: u.sub,
      type: 'talk',
      title: u.title,
      abstract: sub?.abstract ?? '',
      track: u.track,
      speakerNames: sub ? sub.speakers.map((s) => s.name) : names(u.speakers),
      room: null,
      day: null,
      start: null,
      end: null,
      status: u.status === 'confirmed' ? 'confirmed' : 'pending',
      duration: u.dur,
      format: sub?.format ?? null,
      level: sub?.level ?? null,
    });
  });

  /* ---------------------------------------------------------- eval plans */
  const planId = new Map<string, string>();
  D.EVAL_PLANS.forEach((p) => {
    const id = newId('epl');
    planId.set(p.id, id);
    stmts.push([
      `INSERT INTO eval_plans (id, event_id, name, instructions, deadline, anonymized, reminders, reviews_per,
         rules_json, criteria_json, automation_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        eventId,
        p.name,
        p.instructions,
        p.deadline,
        p.anonymized ? 1 : 0,
        p.reminders ? 1 : 0,
        p.reviewsPer,
        JSON.stringify({
          ...p.rules,
          form: p.rules.form === 'all' ? 'all' : formIds.get(p.rules.form) ?? 'all',
          track: p.rules.track === 'all' ? 'all' : trackOptId.get(p.rules.track) ?? 'all',
        }),
        JSON.stringify(p.criteria),
        JSON.stringify({ on: p.reminders, minLeft: 1, d14: true, d7: true, d3: true, over: true, cooldown: 3 }),
        stamp,
      ],
    ]);
    p.reviewers.forEach((r) => {
      const uid = personUserId.get(r.id);
      if (!uid) return;
      stmts.push([
        `INSERT INTO eval_plan_reviewers (plan_id, user_id, role) VALUES (?,?,?)`,
        [id, uid, r.role],
      ]);
    });
  });

  /* -------------------------------------------------------- evaluations */
  // Sponsor-form submissions score under the sponsor plan; everything else
  // under Main CFP Review. The AI second-opinion plan starts empty, matching
  // the prototype's "not started yet" state.
  D.SUBMISSIONS.forEach((s) => {
    if (!s.evalDone) return;
    const key = s.form === 'sponsor' ? 'sponsor' : 'main';
    const plan = D.EVAL_PLANS.find((p) => p.id === key)!;
    const pid = planId.get(key)!;
    const subId = submissionId.get(s.id)!;
    // Score as the people the app itself assigns — `assignedFor()` in evals.ts
    // hands each submission `reviewsPer` members, seeded by its id — so a
    // part-reviewed submission names the right reviewers as still pending
    // instead of showing done and pending rows for disjoint sets of people.
    const members = plan.reviewers.filter((r) => r.role !== 'chair' && personUserId.has(r.id));
    const rp = Math.max(1, Math.min(plan.reviewsPer, members.length));
    const start = seedOf(subId) % members.length;
    const assigned = Array.from({ length: rp }, (_, i) => members[(start + i) % members.length]);
    const matrix = scoreMatrix(s.avg, s.evalDone, plan.criteria.length);
    matrix.forEach((row, i) => {
      const reviewer = assigned[i % assigned.length];
      const scores: Record<string, number> = {};
      plan.criteria.forEach((c, ci) => {
        scores[c.name] = row[ci];
      });
      stmts.push([
        `INSERT INTO evaluations (id, plan_id, submission_id, reviewer_id, scores_json, note, abstained, created_at)
         VALUES (?,?,?,?,?,?,0,?)`,
        [
          newId('evl'),
          pid,
          subId,
          personUserId.get(reviewer.id)!,
          JSON.stringify(scores),
          '',
          stamp,
        ],
      ]);
    });
  });

  /* ------------------------------------------------- task templates + tasks */
  const templateIds: string[] = [];
  D.TASK_TEMPLATES.forEach((t) => {
    const id = newId('tsk');
    templateIds.push(id);
    stmts.push([
      `INSERT INTO task_templates (id, event_id, name, description, type, target, settings_json, required,
         lock_on_complete, due_json, grace_json, trigger, clauses_json, reminders_json, archived, builtin_key, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
      [
        id,
        eventId,
        t.name,
        t.description,
        t.type,
        t.target,
        JSON.stringify(t.settings),
        t.required ? 1 : 0,
        t.lock ? 1 : 0,
        JSON.stringify(t.due),
        JSON.stringify(t.grace),
        t.trigger,
        JSON.stringify(t.clauses),
        JSON.stringify(t.reminders),
        t.name === 'Confirm participation' ? 'confirm_participation' : null,
        stamp,
      ],
    ]);
  });

  const overdueDue = daysFromNow(-10);
  const openDue = daysFromNow(21);
  D.SPEAKER_TASKS.forEach((row) => {
    const pid = profileId.get(row.name);
    if (!pid) return;
    const sid = sessionIdByGridName.get(row.name) ?? null;
    row.t.forEach((state, i) => {
      if (state === '-') return;
      const tpl = D.TASK_TEMPLATES[i];
      const status = state === 'c' ? 'done' : 'open';
      const due = state === 'o' ? overdueDue : openDue;
      stmts.push([
        `INSERT INTO tasks (id, event_id, template_id, one_off_json, target_type, speaker_profile_id, session_id,
           status, due_date, completed_by, completed_at, review_note, created_at)
         VALUES (?,?,?,NULL,?,?,?,?,?,?,?,NULL,?)`,
        [
          newId('tsi'),
          eventId,
          templateIds[i],
          tpl.target,
          pid,
          tpl.target === 'session' ? sid : null,
          status,
          due,
          status === 'done' ? row.name : null,
          status === 'done' ? stamp : null,
          stamp,
        ],
      ]);
    });
  });

  await batch(db, stmts);

  // Marta and Deniz come from D.PEOPLE ('marta' owns the org; 'deniz' is a
  // collaborator on the Main CFP + AI second-opinion rosters via EVAL_PLANS).
  const personas: SandboxResult['personas'] = {
    organizer: {
      userId: personUserId.get('marta')!,
      email: D.suffixEmail(D.SANDBOX_PERSONAS.organizer.email, suffix),
      name: D.SANDBOX_PERSONAS.organizer.name,
    },
    speaker: {
      userId: speakerPersonaUserId,
      email: speakerPersonaEmail,
      name: D.SANDBOX_PERSONAS.speaker.name,
    },
    evaluator: {
      userId: personUserId.get('deniz')!,
      email: D.suffixEmail(D.SANDBOX_PERSONAS.evaluator.email, suffix),
      name: D.SANDBOX_PERSONAS.evaluator.name,
    },
  };
  return { orgId, eventId, slug, suffix, personas };
}
