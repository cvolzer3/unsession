/**
 * API domain: the org-level speaker CRM and team (spec C parity round 2).
 *
 * Contacts directory, notes, custom fields, the speaker pipeline board, bulk
 * contact outreach, and team invites. All of this is org-level data that spans
 * events, so every tool here requires an ORG-WIDE token — an event-restricted
 * token 403s rather than reading beyond its scope. Contact deletion and
 * merging stay UI-only (interactive, destructive record surgery).
 */
import type { Hono } from 'hono';
import type { Bindings } from '../types';
import { apiActor, type ApiAuth, type ApiCtx } from '../lib/api-tokens';
import {
  ApiError,
  bad,
  clampLimit,
  decodeCursor,
  encodeCursor,
  EVENT_PROP,
  handle,
  jsonBody,
  notFound,
  p,
  requireWrite,
  resolveEvent,
  str,
  type Tool,
} from '../lib/api-core';
import { all, batch, jsonParse, now, one, run } from '../lib/db';
import { newId } from '../lib/ids';
import { logActivity } from '../lib/activity';
import { renderTemplate, sendEmail } from '../lib/email';
import { requestMagicLink } from '../lib/auth';
import { addContactToEvent, upsertOrgContact } from '../lib/org-contacts';

/** Org CRM and team tools work across events — event-restricted tokens stay in their lane. */
function requireOrgWide(auth: ApiAuth): void {
  if (auth.eventId) {
    throw new ApiError(403, 'This token is restricted to one event — org-level CRM and team tools need an org-wide token');
  }
}

const SEND_MAX = 100;

/* ---------------------------------------------------------------- contacts */

type ContactRow = {
  id: string;
  org_id: string;
  email: string;
  name: string;
  company: string;
  job_title: string;
  bio: string;
  tagline: string | null;
  pronouns: string | null;
  links_json: string | null;
  headshot_file_id: string | null;
  tags_json: string;
  custom_json: string;
  source: string;
  created_at: string;
  updated_at: string;
};

function shapeContact(env: Bindings, r: ContactRow) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    company: r.company || null,
    jobTitle: r.job_title || null,
    tagline: r.tagline,
    pronouns: r.pronouns,
    bio: r.bio,
    links: jsonParse<Record<string, string>>(r.links_json, {}),
    headshotUrl: r.headshot_file_id ? `${env.APP_ORIGIN}/files/${r.headshot_file_id}` : null,
    tags: jsonParse<string[]>(r.tags_json, []),
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function contactByRef(env: Bindings, auth: ApiAuth, id: string): Promise<ContactRow> {
  const row = await one<ContactRow>(
    env.DB,
    `SELECT * FROM org_contacts WHERE id = ? AND org_id = ?`,
    (id ?? '').trim(),
    auth.orgId
  );
  if (!row) throw notFound('Contact not found');
  return row;
}

export type ContactListQuery = {
  q?: string;
  company?: string;
  jobTitle?: string;
  tag?: string;
  limit?: string | number;
  cursor?: string;
};

export async function listContacts(env: Bindings, auth: ApiAuth, query: ContactListQuery = {}) {
  requireOrgWide(auth);
  const limit = clampLimit(query.limit);
  const conds = ['org_id = ?'];
  const params: unknown[] = [auth.orgId];
  if (query.q) {
    const like = `%${query.q.trim()}%`;
    conds.push('(name LIKE ? OR email LIKE ? OR company LIKE ? OR job_title LIKE ?)');
    params.push(like, like, like, like);
  }
  if (query.company) {
    conds.push('company LIKE ?');
    params.push(`%${query.company.trim()}%`);
  }
  if (query.jobTitle) {
    conds.push('job_title LIKE ?');
    params.push(`%${query.jobTitle.trim()}%`);
  }
  if (query.tag) {
    conds.push(`EXISTS (SELECT 1 FROM json_each(tags_json) WHERE lower(value) = lower(?))`);
    params.push(query.tag.trim());
  }
  if (query.cursor) {
    const [key, id] = decodeCursor(query.cursor);
    conds.push('(name > ? OR (name = ? AND id > ?))');
    params.push(key, key, id);
  }
  const rows = await all<ContactRow>(
    env.DB,
    `SELECT * FROM org_contacts WHERE ${conds.join(' AND ')} ORDER BY name, id LIMIT ?`,
    ...params,
    limit + 1
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => shapeContact(env, r)),
    nextCursor: hasMore && last ? encodeCursor(last.name, last.id) : null,
  };
}

/** One contact in full: fields, custom fields, notes, event connections, pipeline card. */
export async function getContact(env: Bindings, auth: ApiAuth, id: string) {
  requireOrgWide(auth);
  const contact = await contactByRef(env, auth, id);
  const [fields, notes, connections, card] = await Promise.all([
    all<{ id: string; name: string; type: string; options_json: string | null }>(
      env.DB,
      `SELECT id, name, type, options_json FROM org_fields WHERE org_id = ? ORDER BY created_at`,
      auth.orgId
    ),
    all<{ id: string; body: string; created_at: string; author_name: string | null; author_email: string | null }>(
      env.DB,
      `SELECT n.id, n.body, n.created_at, u.name AS author_name, u.email AS author_email
         FROM contact_notes n LEFT JOIN users u ON u.id = n.author_user_id
        WHERE n.contact_id = ? ORDER BY n.created_at DESC, n.id DESC`,
      contact.id
    ),
    all<{ event_id: string; event_name: string; start_date: string; session_title: string | null }>(
      env.DB,
      `SELECT e.id AS event_id, e.name AS event_name, e.start_date, s.title AS session_title
         FROM speaker_profiles p
         JOIN events e ON e.id = p.event_id
         LEFT JOIN session_speakers ss ON ss.speaker_profile_id = p.id
         LEFT JOIN sessions s ON s.id = ss.session_id
        WHERE e.org_id = ? AND p.email = ?
        ORDER BY e.start_date DESC`,
      auth.orgId,
      contact.email
    ),
    one<{ id: string; stage: string; score: number | null; rationale: string }>(
      env.DB,
      `SELECT id, stage, score, rationale FROM pipeline_cards WHERE org_id = ? AND contact_id = ?`,
      auth.orgId,
      contact.id
    ),
  ]);
  const custom = jsonParse<Record<string, string>>(contact.custom_json, {});
  return {
    ...shapeContact(env, contact),
    customFields: fields.map((f) => ({
      fieldId: f.id,
      name: f.name,
      type: f.type,
      options: jsonParse<string[]>(f.options_json ?? '[]', []),
      value: custom[f.id] ?? null,
    })),
    notes: notes.map((n) => ({
      id: n.id,
      body: n.body,
      author: n.author_name ?? n.author_email,
      createdAt: n.created_at,
    })),
    events: connections,
    pipelineCard: card ? { cardId: card.id, stage: card.stage, score: card.score, rationale: card.rationale } : null,
  };
}

export type SaveContactInput = {
  id?: string;
  name?: string;
  email?: string;
  company?: string;
  jobTitle?: string;
  tagline?: string;
  pronouns?: string;
  bio?: string;
  addTags?: string[];
  removeTags?: string[];
  /** {org_fields.id: value}; empty string deletes the key. */
  custom?: Record<string, string>;
};

/**
 * CREATE (no id — upsert by email, never overwrites existing data) or UPDATE
 * (id — overwrites the fields passed) a directory contact; manage tags and
 * custom-field values in the same call.
 */
export async function saveContact(env: Bindings, auth: ApiAuth, input: SaveContactInput) {
  requireOrgWide(auth);
  requireWrite(auth);
  let contactId: string;
  let created = false;

  if (input.id) {
    const contact = await contactByRef(env, auth, input.id);
    const email = (input.email ?? contact.email).trim();
    if (!email.includes('@')) throw bad('A contact needs a valid email');
    if (email.toLowerCase() !== contact.email.toLowerCase()) {
      const dupe = await one<{ id: string }>(
        env.DB,
        `SELECT id FROM org_contacts WHERE org_id = ? AND email = ? AND id != ?`,
        auth.orgId,
        email,
        contact.id
      );
      if (dupe) throw bad(`Another contact already uses ${email}`);
    }
    await run(
      env.DB,
      `UPDATE org_contacts SET name = ?, email = ?, company = ?, job_title = ?, tagline = ?, pronouns = ?, bio = ?, updated_at = ?
        WHERE id = ?`,
      (input.name ?? contact.name).trim() || contact.name,
      email,
      input.company !== undefined ? String(input.company).trim() : contact.company,
      input.jobTitle !== undefined ? String(input.jobTitle).trim() : contact.job_title,
      input.tagline !== undefined ? String(input.tagline).trim() || null : contact.tagline,
      input.pronouns !== undefined ? String(input.pronouns).trim() || null : contact.pronouns,
      input.bio !== undefined ? String(input.bio).trim() : contact.bio,
      now(),
      contact.id
    );
    contactId = contact.id;
  } else {
    const email = (input.email ?? '').trim();
    if (!email.includes('@')) throw bad('A contact needs a valid email');
    const existing = await one<{ id: string }>(
      env.DB,
      `SELECT id FROM org_contacts WHERE org_id = ? AND email = ?`,
      auth.orgId,
      email
    );
    const id = await upsertOrgContact(
      env.DB,
      auth.orgId,
      {
        email,
        name: (input.name ?? '').trim(),
        company: (input.company ?? '').trim() || undefined,
        job_title: (input.jobTitle ?? '').trim() || undefined,
        tagline: (input.tagline ?? '').trim() || undefined,
        pronouns: (input.pronouns ?? '').trim() || undefined,
        bio: (input.bio ?? '').trim() || undefined,
      },
      'manual'
    );
    if (!id) throw bad('A contact needs a valid email');
    contactId = id;
    created = !existing;
  }

  if (input.addTags?.length || input.removeTags?.length) {
    const row = await contactByRef(env, auth, contactId);
    let tags = jsonParse<string[]>(row.tags_json, []);
    for (const t of input.addTags ?? []) {
      const tag = String(t).trim();
      if (tag && !tags.some((x) => x.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    }
    const drop = new Set((input.removeTags ?? []).map((t) => String(t).trim().toLowerCase()));
    tags = tags.filter((t) => !drop.has(t.toLowerCase()));
    await run(env.DB, `UPDATE org_contacts SET tags_json = ?, updated_at = ? WHERE id = ?`, JSON.stringify(tags), now(), contactId);
  }

  if (input.custom && typeof input.custom === 'object') {
    const row = await contactByRef(env, auth, contactId);
    const valid = new Set(
      (await all<{ id: string }>(env.DB, `SELECT id FROM org_fields WHERE org_id = ?`, auth.orgId)).map((f) => f.id)
    );
    const custom = jsonParse<Record<string, string>>(row.custom_json, {});
    for (const [key, value] of Object.entries(input.custom)) {
      if (!valid.has(key)) throw bad(`Unknown custom field “${key}” — use the fieldId values from get_contact`);
      const v = String(value ?? '').trim();
      if (v) custom[key] = v;
      else delete custom[key];
    }
    await run(env.DB, `UPDATE org_contacts SET custom_json = ?, updated_at = ? WHERE id = ?`, JSON.stringify(custom), now(), contactId);
  }

  const fresh = await contactByRef(env, auth, contactId);
  return { ...shapeContact(env, fresh), created };
}

/** NOTE on a contact's record. */
export async function addContactNote(env: Bindings, auth: ApiAuth, id: string, body: string) {
  requireOrgWide(auth);
  requireWrite(auth);
  const contact = await contactByRef(env, auth, id);
  const text = `${(body ?? '').trim()}`.slice(0, 4000);
  if (!text) throw bad('Write the note first');
  // contact_notes has no author-name column — API notes carry the token name in the body.
  const stamped = `[${apiActor(auth)}] ${text}`;
  const noteId = newId('cno');
  await run(
    env.DB,
    `INSERT INTO contact_notes (id, contact_id, author_user_id, body, created_at) VALUES (?,?,NULL,?,?)`,
    noteId,
    contact.id,
    stamped,
    now()
  );
  return { id: noteId, contactId: contact.id, body: stamped };
}

/** ADD a contact to an event as a speaker profile — idempotent by email. */
export async function addContactToEventApi(env: Bindings, auth: ApiAuth, id: string, eventRef: string) {
  requireOrgWide(auth);
  requireWrite(auth);
  const contact = await contactByRef(env, auth, id);
  const event = await resolveEvent(env, auth, eventRef);
  const res = await addContactToEvent(env.DB, contact.id, event.id);
  if (!res) throw bad('Could not add the contact to this event');
  if (res.created) {
    await logActivity(env.DB, {
      eventId: event.id,
      subjectType: 'speaker',
      subjectId: res.profileId,
      actor: apiActor(auth),
      action: 'Speaker added',
      detail: `${contact.name || contact.email} · from the directory via API`,
    });
  }
  return { contactId: contact.id, event: event.slug, speakerProfileId: res.profileId, created: res.created };
}

export type EmailContactsInput = { ids?: string[]; subject?: string; body?: string };

/** BULK-EMAIL directory contacts — immediate org-level sends, max 100 per call. */
export async function emailContacts(env: Bindings, auth: ApiAuth, input: EmailContactsInput) {
  requireOrgWide(auth);
  requireWrite(auth);
  const ids = (Array.isArray(input.ids) ? input.ids : []).map(String).filter(Boolean);
  const subject = (input.subject ?? '').trim();
  const body = (input.body ?? '').trim();
  if (!ids.length) throw bad('Pass ids — the contacts to email');
  if (!subject || !body) throw bad('A message needs a subject and a body');

  const recipients = await all<{ id: string; email: string; name: string; company: string }>(
    env.DB,
    `SELECT id, email, name, company FROM org_contacts
      WHERE org_id = ? AND id IN (SELECT value FROM json_each(?))`,
    auth.orgId,
    JSON.stringify(ids)
  );
  if (!recipients.length) throw bad('Those contacts are no longer here');

  const page = recipients.slice(0, SEND_MAX);
  let sent = 0;
  let simulated = 0;
  let failed = 0;
  for (const r of page) {
    const name = r.name || r.email;
    const vars = { name, first_name: name.split(/[\s@]/)[0] || name, company: r.company || '', email: r.email };
    const res = await sendEmail(env, {
      orgId: auth.orgId,
      eventId: null,
      to: r.email,
      toName: r.name,
      subject: renderTemplate(subject, vars),
      text: renderTemplate(body, vars),
      subjectType: 'org_contact',
      subjectId: r.id,
    });
    if (res.status === 'sent') sent++;
    else if (res.status === 'simulated') simulated++;
    else failed++;
  }
  return { sent, simulated, failed, leftOver: recipients.length - page.length };
}

/* ---------------------------------------------------------------- pipeline */

const STAGES = ['researching', 'identified', 'contacted', 'interested', 'confirmed', 'declined'] as const;
type Stage = (typeof STAGES)[number];
const OPEN_STAGES: Stage[] = ['researching', 'identified', 'contacted', 'interested'];
const isStage = (v: string): v is Stage => (STAGES as readonly string[]).includes(v);

type CardRow = {
  id: string;
  org_id: string;
  contact_id: string;
  stage: Stage;
  score: number | null;
  rationale: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

async function cardByRef(env: Bindings, auth: ApiAuth, id: string): Promise<CardRow> {
  const card = await one<CardRow>(
    env.DB,
    `SELECT * FROM pipeline_cards WHERE id = ? AND org_id = ?`,
    (id ?? '').trim(),
    auth.orgId
  );
  if (!card) throw notFound('Pipeline card not found');
  return card;
}

/** The speaker-pipeline board: every card by stage, in column order. */
export async function getPipeline(env: Bindings, auth: ApiAuth) {
  requireOrgWide(auth);
  const cards = await all<CardRow & { name: string; email: string; company: string; job_title: string }>(
    env.DB,
    `SELECT pc.*, oc.name, oc.email, oc.company, oc.job_title
       FROM pipeline_cards pc JOIN org_contacts oc ON oc.id = pc.contact_id
      WHERE pc.org_id = ? ORDER BY pc.stage, pc.sort_order, pc.updated_at DESC`,
    auth.orgId
  );
  return {
    stages: [...STAGES],
    cards: cards.map((card) => ({
      cardId: card.id,
      contactId: card.contact_id,
      name: card.name,
      email: card.email,
      company: card.company || null,
      jobTitle: card.job_title || null,
      stage: card.stage,
      score: card.score,
      rationale: card.rationale,
      updatedAt: card.updated_at,
    })),
  };
}

/** One card in full: contact, notes, stage history. */
export async function getPipelineCard(env: Bindings, auth: ApiAuth, id: string) {
  requireOrgWide(auth);
  const card = await cardByRef(env, auth, id);
  const [contact, notes, history] = await Promise.all([
    contactByRef(env, auth, card.contact_id),
    all<{ id: string; body: string; created_at: string; author_name: string | null; author_email: string | null }>(
      env.DB,
      `SELECT n.id, n.body, n.created_at, u.name AS author_name, u.email AS author_email
         FROM pipeline_notes n LEFT JOIN users u ON u.id = n.author_user_id
        WHERE n.card_id = ? ORDER BY n.created_at DESC, n.id DESC`,
      card.id
    ),
    all<{ from_stage: string | null; to_stage: string; actor: string; created_at: string }>(
      env.DB,
      `SELECT from_stage, to_stage, actor, created_at FROM pipeline_history
        WHERE card_id = ? ORDER BY created_at DESC, id DESC`,
      card.id
    ),
  ]);
  return {
    cardId: card.id,
    stage: card.stage,
    score: card.score,
    rationale: card.rationale,
    contact: shapeContact(env, contact),
    notes: notes.map((n) => ({ id: n.id, body: n.body, author: n.author_name ?? n.author_email, createdAt: n.created_at })),
    history: history.map((h) => ({ from: h.from_stage, to: h.to_stage, actor: h.actor, at: h.created_at })),
  };
}

export type EnrollPipelineInput = { contactId?: string; stage?: string; score?: number | null; rationale?: string };

/** ENROLL a contact on the pipeline board (one card per contact). */
export async function enrollPipelineCard(env: Bindings, auth: ApiAuth, input: EnrollPipelineInput) {
  requireOrgWide(auth);
  requireWrite(auth);
  const contact = await contactByRef(env, auth, str(input.contactId));
  const stage = (input.stage ?? 'identified') as Stage;
  if (!OPEN_STAGES.includes(stage)) throw bad(`stage must be one of ${OPEN_STAGES.join(', ')} — the terminal two are reached by moving`);
  const existing = await one<{ id: string }>(
    env.DB,
    `SELECT id FROM pipeline_cards WHERE org_id = ? AND contact_id = ?`,
    auth.orgId,
    contact.id
  );
  if (existing) return { cardId: existing.id, contactId: contact.id, alreadyEnrolled: true };

  const score = input.score === null || input.score === undefined ? null : Math.max(0, Math.min(100, Math.round(Number(input.score))));
  const id = newId('pcd');
  const stamp = now();
  await batch(env.DB, [
    [
      `INSERT INTO pipeline_cards (id, org_id, contact_id, stage, score, rationale, sort_order, created_at, updated_at)
       VALUES (?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order) + 1, 0) FROM pipeline_cards WHERE org_id = ? AND stage = ?),?,?)`,
      [id, auth.orgId, contact.id, stage, score, (input.rationale ?? '').trim(), auth.orgId, stage, stamp, stamp],
    ],
    [
      `INSERT INTO pipeline_history (id, card_id, from_stage, to_stage, actor, created_at) VALUES (?,?,NULL,?,?,?)`,
      [newId('pph'), id, stage, apiActor(auth), stamp],
    ],
  ]);
  return { cardId: id, contactId: contact.id, stage, score, created: true };
}

export type UpdatePipelineCardInput = { stage?: string; score?: number | null; rationale?: string; note?: string };

/** MOVE a card between stages (history-logged), update score/rationale, and/or add a note. */
export async function updatePipelineCard(env: Bindings, auth: ApiAuth, id: string, input: UpdatePipelineCardInput) {
  requireOrgWide(auth);
  requireWrite(auth);
  const card = await cardByRef(env, auth, id);
  const stamp = now();

  if (input.stage !== undefined) {
    const stage = String(input.stage);
    if (!isStage(stage)) throw bad(`stage must be one of ${STAGES.join(', ')}`);
    if (stage !== card.stage) {
      await batch(env.DB, [
        [
          `UPDATE pipeline_cards
              SET stage = ?, updated_at = ?,
                  sort_order = (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM pipeline_cards WHERE org_id = ? AND stage = ?)
            WHERE id = ?`,
          [stage, stamp, auth.orgId, stage, card.id],
        ],
        [
          `INSERT INTO pipeline_history (id, card_id, from_stage, to_stage, actor, created_at) VALUES (?,?,?,?,?,?)`,
          [newId('pph'), card.id, card.stage, stage, apiActor(auth), stamp],
        ],
      ]);
    }
  }
  if (input.score !== undefined || input.rationale !== undefined) {
    const score =
      input.score === undefined
        ? card.score
        : input.score === null
          ? null
          : Math.max(0, Math.min(100, Math.round(Number(input.score))));
    await run(
      env.DB,
      `UPDATE pipeline_cards SET score = ?, rationale = ?, updated_at = ? WHERE id = ?`,
      score,
      input.rationale === undefined ? card.rationale : String(input.rationale).trim(),
      stamp,
      card.id
    );
  }
  if (input.note !== undefined) {
    const text = String(input.note).trim().slice(0, 4000);
    if (text) {
      await run(
        env.DB,
        `INSERT INTO pipeline_notes (id, card_id, author_user_id, body, created_at) VALUES (?,?,NULL,?,?)`,
        newId('pno'),
        card.id,
        `[${apiActor(auth)}] ${text}`,
        stamp
      );
    }
  }
  return getPipelineCard(env, auth, card.id);
}

/** REMOVE a card from the board — its notes and history go with it; the contact stays. */
export async function removePipelineCard(env: Bindings, auth: ApiAuth, id: string) {
  requireOrgWide(auth);
  requireWrite(auth);
  const card = await cardByRef(env, auth, id);
  await batch(env.DB, [
    [`DELETE FROM pipeline_notes WHERE card_id = ?`, [card.id]],
    [`DELETE FROM pipeline_history WHERE card_id = ?`, [card.id]],
    [`DELETE FROM pipeline_cards WHERE id = ?`, [card.id]],
  ]);
  return { cardId: card.id, removed: true };
}

/* -------------------------------------------------------------------- team */

/** Members and pending invites of the org. */
export async function listTeam(env: Bindings, auth: ApiAuth) {
  requireOrgWide(auth);
  const [members, invites] = await Promise.all([
    all<{ user_id: string; role: string; name: string | null; email: string }>(
      env.DB,
      `SELECT m.user_id, m.role, u.name, u.email FROM org_members m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = ? ORDER BY u.name, u.email`,
      auth.orgId
    ),
    all<{ id: string; email: string; role: string; status: string; created_at: string }>(
      env.DB,
      `SELECT id, email, role, status, created_at FROM invites WHERE org_id = ? AND status = 'pending' ORDER BY created_at DESC`,
      auth.orgId
    ),
  ]);
  return {
    members: members.map((m) => ({ userId: m.user_id, name: m.name, email: m.email, role: m.role })),
    pendingInvites: invites.map((i) => ({ inviteId: i.id, email: i.email, role: i.role, invitedAt: i.created_at })),
  };
}

export type InviteTeammateInput = { email?: string; role?: string; event?: string };

/**
 * INVITE a teammate — sends the invite email with a one-shot accept link.
 * API invites cap at admin (owner is granted only by a human owner in the UI).
 */
export async function inviteTeammate(env: Bindings, auth: ApiAuth, input: InviteTeammateInput) {
  requireOrgWide(auth);
  requireWrite(auth);
  const email = (input.email ?? '').trim();
  if (!email.includes('@')) throw bad('Pass a valid email');
  const role = input.role === 'admin' ? 'admin' : 'collaborator';
  const event = await resolveEvent(env, auth, str(input.event));

  const existing = await one<{ user_id: string }>(
    env.DB,
    `SELECT m.user_id FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.email = ?`,
    auth.orgId,
    email
  );
  if (existing) throw bad(`${email} is already on the team`);

  const inviteId = newId('inv');
  // invited_by references users(id) — an API token has no user row, so NULL.
  await run(
    env.DB,
    `INSERT INTO invites (id, org_id, email, role, invited_by, status, created_at) VALUES (?,?,?,?,NULL,'pending',?)`,
    inviteId,
    auth.orgId,
    email,
    role,
    now()
  );
  const res = await requestMagicLink(
    env,
    email,
    'invite',
    { orgId: auth.orgId, role, inviteId, next: '/app' },
    {
      eventId: event.id,
      subject: `${apiActor(auth)} invited you to ${event.name} on Unsession`,
      text:
        `${apiActor(auth)} added you as ${role} on ${event.name}.\n\n` +
        `Accept the invite here — you'll be asked to create a password:`,
    }
  );
  return { inviteId, email, role, emailStatus: res.status, ...(res.simulatedLink ? { inviteLink: res.simulatedLink } : {}) };
}

/** REVOKE a pending invite. */
export async function revokeInvite(env: Bindings, auth: ApiAuth, inviteId: string) {
  requireOrgWide(auth);
  requireWrite(auth);
  const invite = await one<{ id: string; email: string; status: string }>(
    env.DB,
    `SELECT id, email, status FROM invites WHERE id = ? AND org_id = ?`,
    (inviteId ?? '').trim(),
    auth.orgId
  );
  if (!invite) throw notFound('Invite not found');
  await run(env.DB, `UPDATE invites SET status = 'revoked' WHERE id = ?`, invite.id);
  return { inviteId: invite.id, email: invite.email, revoked: true };
}

/* -------------------------------------------------------------- REST routes */

export function registerOrgRoutes(app: Hono<ApiCtx>): void {
  app.get(
    '/api/v1/org/contacts',
    handle((c) =>
      listContacts(c.env, c.var.apiAuth, {
        q: c.req.query('q'),
        company: c.req.query('company'),
        jobTitle: c.req.query('jobTitle'),
        tag: c.req.query('tag'),
        limit: c.req.query('limit'),
        cursor: c.req.query('cursor'),
      })
    )
  );
  app.get('/api/v1/org/contacts/:id', handle((c) => getContact(c.env, c.var.apiAuth, p(c, 'id'))));
  app.post('/api/v1/org/contacts', handle(async (c) => saveContact(c.env, c.var.apiAuth, await jsonBody(c))));
  app.post(
    '/api/v1/org/contacts/:id/notes',
    handle(async (c) => {
      const body = await jsonBody<{ body?: string }>(c);
      return addContactNote(c.env, c.var.apiAuth, p(c, 'id'), str(body.body));
    })
  );
  app.post(
    '/api/v1/org/contacts/:id/add-to-event',
    handle(async (c) => {
      const body = await jsonBody<{ event?: string }>(c);
      return addContactToEventApi(c.env, c.var.apiAuth, p(c, 'id'), str(body.event));
    })
  );
  app.post('/api/v1/org/contacts/email', handle(async (c) => emailContacts(c.env, c.var.apiAuth, await jsonBody(c))));
  app.get('/api/v1/org/pipeline', handle((c) => getPipeline(c.env, c.var.apiAuth)));
  app.get('/api/v1/org/pipeline/:id', handle((c) => getPipelineCard(c.env, c.var.apiAuth, p(c, 'id'))));
  app.post('/api/v1/org/pipeline', handle(async (c) => enrollPipelineCard(c.env, c.var.apiAuth, await jsonBody(c))));
  app.patch(
    '/api/v1/org/pipeline/:id',
    handle(async (c) => updatePipelineCard(c.env, c.var.apiAuth, p(c, 'id'), await jsonBody(c)))
  );
  app.delete('/api/v1/org/pipeline/:id', handle((c) => removePipelineCard(c.env, c.var.apiAuth, p(c, 'id'))));
  app.get('/api/v1/org/team', handle((c) => listTeam(c.env, c.var.apiAuth)));
  app.post('/api/v1/org/team/invite', handle(async (c) => inviteTeammate(c.env, c.var.apiAuth, await jsonBody(c))));
  app.post('/api/v1/org/team/invites/:id/revoke', handle((c) => revokeInvite(c.env, c.var.apiAuth, p(c, 'id'))));
}

/* --------------------------------------------------------------- MCP tools */

export const ORG_TOOLS: Tool[] = [
  {
    name: 'list_contacts',
    description:
      'The org-wide speaker CRM directory (contacts carry across events). Filters: q (name/email/company/title), company, jobTitle, tag. Cursor-paginated, alphabetical. Org-wide tokens only. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        company: { type: 'string' },
        jobTitle: { type: 'string' },
        tag: { type: 'string' },
        limit: { type: 'integer', description: 'Page size, default 100, max 500.' },
        cursor: { type: 'string' },
      },
      additionalProperties: false,
    },
    run: (env, auth, a) =>
      listContacts(env, auth, {
        q: a.q === undefined ? undefined : str(a.q),
        company: a.company === undefined ? undefined : str(a.company),
        jobTitle: a.jobTitle === undefined ? undefined : str(a.jobTitle),
        tag: a.tag === undefined ? undefined : str(a.tag),
        limit: a.limit as number | undefined,
        cursor: a.cursor === undefined ? undefined : str(a.cursor),
      }),
  },
  {
    name: 'get_contact',
    description:
      'One CRM contact in full: fields, tags, custom fields (with the org’s field catalog), notes, cross-event speaker history, and the pipeline card if enrolled. Org-wide tokens only. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Contact id (ctc_…).' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => getContact(env, auth, str(a.id)),
  },
  {
    name: 'save_contact',
    description:
      'CREATE (no id — upsert by email; existing directory data is never overwritten, reports created=false) or UPDATE (id — overwrites the fields passed) a CRM contact. Manage tags via addTags/removeTags and custom-field values via custom {fieldId: value, "" deletes}. Contact deletion and merging stay in the admin UI. Org-wide tokens only.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Contact id (ctc_…) to update; omit to create/upsert by email.' },
        name: { type: 'string' },
        email: { type: 'string' },
        company: { type: 'string' },
        jobTitle: { type: 'string' },
        tagline: { type: 'string' },
        pronouns: { type: 'string' },
        bio: { type: 'string' },
        addTags: { type: 'array', items: { type: 'string' } },
        removeTags: { type: 'array', items: { type: 'string' } },
        custom: { type: 'object', description: '{org_fields.id: value}; empty string deletes.' },
      },
      additionalProperties: false,
    },
    run: (env, auth, a) => saveContact(env, auth, a as SaveContactInput),
  },
  {
    name: 'add_contact_note',
    description: 'NOTE on a CRM contact’s record (prefixed with the API token name, since notes have no machine author). Org-wide tokens only.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Contact id (ctc_…).' },
        body: { type: 'string', description: 'Note text, max 4000 chars.' },
      },
      required: ['id', 'body'],
      additionalProperties: false,
    },
    run: (env, auth, a) => addContactNote(env, auth, str(a.id), str(a.body)),
  },
  {
    name: 'add_contact_to_event',
    description:
      'ADD a CRM contact to an event as a speaker profile — idempotent by email (reports created=false when already there). The profile then appears on the event’s Speakers grid. Org-wide tokens only.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Contact id (ctc_…).' },
        event: EVENT_PROP,
      },
      required: ['id', 'event'],
      additionalProperties: false,
    },
    run: (env, auth, a) => addContactToEventApi(env, auth, str(a.id), str(a.event)),
  },
  {
    name: 'email_contacts',
    description:
      'BULK-EMAIL directory contacts, immediately (org-level sends, not tied to an event). Merge tags: {{name}} {{first_name}} {{company}} {{email}}. Max 100 recipients per call; leftOver reports the rest. Org-wide tokens only.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Contact ids (ctc_…).' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['ids', 'subject', 'body'],
      additionalProperties: false,
    },
    run: (env, auth, a) => emailContacts(env, auth, a as EmailContactsInput),
  },
  {
    name: 'get_pipeline',
    description:
      'The org speaker-pipeline board: stages (researching → identified → contacted → interested → confirmed/declined) and every card in column order. Org-wide tokens only. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (env, auth) => getPipeline(env, auth),
  },
  {
    name: 'get_pipeline_card',
    description: 'One pipeline card in full: contact, score/rationale, notes and the stage history. Org-wide tokens only. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Card id (pcd_…).' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => getPipelineCard(env, auth, str(a.id)),
  },
  {
    name: 'enroll_pipeline_card',
    description:
      'ENROLL a CRM contact on the pipeline board (one card per contact; reports alreadyEnrolled). Starting stage must be an open one — confirmed/declined are reached by moving. Org-wide tokens only.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'Contact id (ctc_…).' },
        stage: { type: 'string', enum: ['researching', 'identified', 'contacted', 'interested'], description: 'Default identified.' },
        score: { type: ['integer', 'null'], description: '0–100 fit score.' },
        rationale: { type: 'string' },
      },
      required: ['contactId'],
      additionalProperties: false,
    },
    run: (env, auth, a) => enrollPipelineCard(env, auth, a as EnrollPipelineInput),
  },
  {
    name: 'update_pipeline_card',
    description:
      'MOVE a pipeline card between stages (stage-history logged), update its score (0–100, null clears) / rationale, and/or append a note — any combination in one call. Org-wide tokens only.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Card id (pcd_…).' },
        stage: { type: 'string', enum: ['researching', 'identified', 'contacted', 'interested', 'confirmed', 'declined'] },
        score: { type: ['integer', 'null'] },
        rationale: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => updatePipelineCard(env, auth, str(a.id), a as UpdatePipelineCardInput),
  },
  {
    name: 'remove_pipeline_card',
    description: 'REMOVE a card from the pipeline board (notes and history go with it; the contact stays in the directory). Org-wide tokens only.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Card id (pcd_…).' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => removePipelineCard(env, auth, str(a.id)),
  },
  {
    name: 'list_team',
    description: 'The org team: members with roles (owner/admin/collaborator) and pending invites. Org-wide tokens only. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (env, auth) => listTeam(env, auth),
  },
  {
    name: 'invite_teammate',
    description:
      'INVITE a teammate to the org — EMAILS a one-shot accept link (returned as inviteLink when sending is simulated). API invites cap at the admin role; role changes and member removal stay in the admin UI. The event names the invite email’s context.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        role: { type: 'string', enum: ['admin', 'collaborator'], description: 'Default collaborator.' },
        event: EVENT_PROP,
      },
      required: ['email', 'event'],
      additionalProperties: false,
    },
    run: (env, auth, a) => inviteTeammate(env, auth, a as InviteTeammateInput),
  },
  {
    name: 'revoke_invite',
    description: 'REVOKE a pending team invite — the emailed link stops working.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Invite id (inv_…), see list_team.' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => revokeInvite(env, auth, str(a.id)),
  },
];
