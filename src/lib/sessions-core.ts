/**
 * Session ≠ Submission (spec §3): accepting a submission creates a Session
 * copy, editable for publication without touching the submission or its
 * review history. This is the one place that copy happens — B2's decision
 * engine and any future accept path call through here.
 */
import { all, one, now, run } from './db';
import { newId } from './ids';
import { slugify } from './slugify';
import { logActivity } from './activity';
import type { Bindings } from '../types';

type SubRow = {
  id: string;
  event_id: string;
  seq: number;
  title: string;
  abstract: string;
  answers_json: string;
  status: string;
};

type SpeakerRow = { id: string; name: string; email: string; bio: string; headshot_file_id: string | null; user_id: string | null; position: number };

type OptionRow = { id: string; name: string; duration_min: number | null; taxonomy: string };

/** Resolve a form answer like "Talk (30 min)" or "AI & ML" to a taxonomy option. */
function matchOption(options: OptionRow[], taxonomy: string, answer: unknown): OptionRow | null {
  if (typeof answer !== 'string' || !answer) return null;
  const pool = options.filter((o) => o.taxonomy === taxonomy);
  const exact = pool.find((o) => o.name === answer);
  if (exact) return exact;
  const stripped = answer.replace(/\s*\(.+\)\s*$/, '');
  return pool.find((o) => o.name === stripped) ?? null;
}

/** Ensure a per-event speaker profile exists for each submission speaker; returns profile ids in position order. */
export async function ensureSpeakerProfiles(env: Bindings, eventId: string, speakers: SpeakerRow[]): Promise<string[]> {
  const ids: string[] = [];
  for (const sp of speakers) {
    if (!sp.email) continue;
    const existing = await one<{ id: string }>(
      env.DB,
      `SELECT id FROM speaker_profiles WHERE event_id = ? AND email = ?`,
      eventId,
      sp.email
    );
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const base = slugify(sp.name || sp.email.split('@')[0], 'speaker');
    let slug = base;
    let n = 2;
    while (await one(env.DB, `SELECT 1 FROM speaker_profiles WHERE event_id = ? AND slug = ?`, eventId, slug)) {
      slug = `${base}-${n++}`;
    }
    const id = newId('spk');
    await run(
      env.DB,
      `INSERT INTO speaker_profiles (id, event_id, user_id, email, name, bio, headshot_file_id, slug, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      id,
      eventId,
      sp.user_id ?? null,
      sp.email,
      sp.name || sp.email,
      sp.bio || '',
      sp.headshot_file_id ?? null,
      slug,
      now()
    );
    ids.push(id);
  }
  return ids;
}

export type CreateSessionOpts = {
  /** 'sponsor' for session-intake forms (B5); default 'talk'. */
  type?: 'talk' | 'sponsor';
  /** Shown as the session's sponsor (sessions.sponsor_name). */
  sponsorName?: string | null;
  /**
   * Session-intake submissions skip the decision/confirmation emails, so their
   * sessions start 'confirmed' like manually created sponsor sessions.
   */
  sessionStatus?: 'pending' | 'confirmed';
};

/**
 * Create (or return the existing) session for an accepted submission.
 * Copies title/abstract, resolves track/format/level from answers, links
 * speaker profiles. Session starts unscheduled, status 'pending' until the
 * speaker confirms (unless `opts.sessionStatus` says otherwise).
 */
export async function createSessionFromSubmission(
  env: Bindings,
  submissionId: string,
  actor: string,
  opts: CreateSessionOpts = {}
): Promise<{ sessionId: string; created: boolean }> {
  const existing = await one<{ id: string }>(
    env.DB,
    `SELECT id FROM sessions WHERE submission_id = ? LIMIT 1`,
    submissionId
  );
  if (existing) return { sessionId: existing.id, created: false };

  const sub = await one<SubRow>(env.DB, `SELECT * FROM submissions WHERE id = ?`, submissionId);
  if (!sub) throw new Error(`submission not found: ${submissionId}`);

  const speakers = await all<SpeakerRow>(
    env.DB,
    `SELECT * FROM submission_speakers WHERE submission_id = ? ORDER BY position`,
    submissionId
  );
  const options = await all<OptionRow>(
    env.DB,
    `SELECT o.id, o.name, o.duration_min, t.name AS taxonomy
     FROM taxonomy_options o JOIN taxonomies t ON t.id = o.taxonomy_id
     WHERE t.event_id = ?`,
    sub.event_id
  );

  let answers: Record<string, unknown> = {};
  try {
    answers = JSON.parse(sub.answers_json || '{}');
  } catch {
    /* tolerate malformed answers */
  }
  // Track/format/level answers may live under any field id — find by taxonomy match across all answers.
  const answerValues = Object.values(answers);
  const track = answerValues.map((v) => matchOption(options, 'Track', v)).find(Boolean) ?? null;
  const format = answerValues.map((v) => matchOption(options, 'Format', v)).find(Boolean) ?? null;
  const level = answerValues.map((v) => matchOption(options, 'Level', v)).find(Boolean) ?? null;

  const sessionId = newId('ses');
  await run(
    env.DB,
    `INSERT INTO sessions (id, event_id, submission_id, type, title, abstract, track_option_id, format_option_id,
       level, duration_min, room_id, all_rooms, day, start_min, end_min, status, published, sponsor_name,
       stream_url, visibility_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL,0,NULL,NULL,NULL,?,1,?,NULL,NULL,?,?)`,
    sessionId,
    sub.event_id,
    submissionId,
    opts.type ?? 'talk',
    sub.title,
    sub.abstract,
    track?.id ?? null,
    format?.id ?? null,
    level?.name ?? null,
    format?.duration_min ?? 30,
    opts.sessionStatus ?? 'pending',
    opts.sponsorName?.trim() || null,
    now(),
    now()
  );

  const profileIds = await ensureSpeakerProfiles(env, sub.event_id, speakers);
  for (let i = 0; i < profileIds.length; i++) {
    await run(
      env.DB,
      `INSERT OR IGNORE INTO session_speakers (session_id, speaker_profile_id, position) VALUES (?,?,?)`,
      sessionId,
      profileIds[i],
      i
    );
  }

  await logActivity(env.DB, {
    eventId: sub.event_id,
    subjectType: 'submission',
    subjectId: submissionId,
    actor,
    action: 'Session created from submission',
    detail: sub.title,
  });

  return { sessionId, created: true };
}
