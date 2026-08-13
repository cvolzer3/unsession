/**
 * Speaker CRM — org-level contacts (migration 0024).
 *
 * A contact belongs to the org, not the event. Every event speaker is mirrored
 * into `org_contacts` so the directory holds everyone the org has ever worked
 * with.
 *
 * Id prefixes reserved by this feature: `ctc` org_contacts, `cno`
 * contact_notes, `cfd` org_fields, `seg` org_segments, `pcd` pipeline_cards,
 * `pph` pipeline_history, `pno` pipeline_notes.
 */
import type { Context } from 'hono';
import type { Ctx } from '../types';
import { now, one, run } from './db';
import { newId } from './ids';
import { slugify } from './slugify';

/** How the contact first arrived. */
export type ContactSource = 'manual' | 'import' | 'event';

export type OrgContactFields = {
  email: string;
  name: string;
  bio?: string | null;
  tagline?: string | null;
  pronouns?: string | null;
  links_json?: string | null;
  headshot_file_id?: string | null;
  company?: string | null;
  job_title?: string | null;
};

type ContactRow = {
  id: string;
  name: string;
  company: string;
  job_title: string;
  bio: string;
  tagline: string | null;
  pronouns: string | null;
  links_json: string | null;
  headshot_file_id: string | null;
};

function clean(value: string | null | undefined): string {
  return (value ?? '').trim();
}

/**
 * Create the org's contact for this email, or fill in what it is still missing.
 *
 * An existing contact is never overwritten: an organizer's edits outrank
 * whatever an event profile carries. Returns the contact id, or null when the
 * email is empty.
 */
export async function upsertOrgContact(
  db: D1Database,
  orgId: string,
  fields: OrgContactFields,
  source: ContactSource = 'manual'
): Promise<string | null> {
  const email = clean(fields.email);
  if (!orgId || !email) return null;
  const stamp = now();

  const existing = await one<ContactRow>(
    db,
    `SELECT id, name, company, job_title, bio, tagline, pronouns, links_json, headshot_file_id
       FROM org_contacts WHERE org_id = ? AND email = ?`,
    orgId,
    email
  );

  if (!existing) {
    const id = newId('ctc');
    await run(
      db,
      `INSERT INTO org_contacts
         (id, org_id, email, name, company, job_title, bio, tagline, pronouns,
          links_json, headshot_file_id, source, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      orgId,
      email,
      clean(fields.name) || email,
      clean(fields.company),
      clean(fields.job_title),
      clean(fields.bio),
      clean(fields.tagline) || null,
      clean(fields.pronouns) || null,
      clean(fields.links_json) || null,
      fields.headshot_file_id ?? null,
      source,
      stamp,
      stamp
    );
    return id;
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const fill = (column: keyof ContactRow, current: string | null, incoming: string | null | undefined) => {
    const value = clean(incoming);
    if (clean(current) || !value) return;
    sets.push(`${column} = ?`);
    params.push(value);
  };
  fill('name', existing.name, fields.name);
  fill('company', existing.company, fields.company);
  fill('job_title', existing.job_title, fields.job_title);
  fill('bio', existing.bio, fields.bio);
  fill('tagline', existing.tagline, fields.tagline);
  fill('pronouns', existing.pronouns, fields.pronouns);
  fill('links_json', existing.links_json, fields.links_json);
  fill('headshot_file_id', existing.headshot_file_id, fields.headshot_file_id);

  // Nothing to add — leave the row alone rather than bumping updated_at.
  if (!sets.length) return existing.id;

  params.push(stamp, existing.id);
  await run(db, `UPDATE org_contacts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...params);
  return existing.id;
}

/**
 * The org behind the request, taken from the session's active event. Null means
 * the user has no event yet, and org routes redirect to /app/events/new.
 */
export function orgIdForRequest(c: Context<Ctx>): string | null {
  return c.var.event?.org_id ?? null;
}

type FullContactRow = ContactRow & { email: string };

/**
 * Add an org contact to an event as a speaker profile. Idempotent by email.
 * Returns the profile id and whether a new profile was created, or null when
 * the contact does not exist.
 */
export async function addContactToEvent(
  db: D1Database,
  contactId: string,
  eventId: string
): Promise<{ profileId: string; created: boolean } | null> {
  const contact = await one<FullContactRow>(
    db,
    `SELECT id, email, name, company, job_title, bio, tagline, pronouns, links_json, headshot_file_id
       FROM org_contacts WHERE id = ?`,
    contactId
  );
  if (!contact) return null;

  const existing = await one<{ id: string }>(
    db,
    `SELECT id FROM speaker_profiles WHERE event_id = ? AND email = ?`,
    eventId,
    contact.email
  );
  if (existing) return { profileId: existing.id, created: false };

  const base = slugify(contact.name || contact.email.split('@')[0], 'speaker');
  let slug = base;
  let n = 2;
  while (await one(db, `SELECT 1 FROM speaker_profiles WHERE event_id = ? AND slug = ?`, eventId, slug)) {
    slug = `${base}-${n++}`;
  }
  const id = newId('spk');
  await run(
    db,
    `INSERT INTO speaker_profiles (id, event_id, user_id, email, name, bio, job_title, company, tagline, links_json, headshot_file_id, slug, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    eventId,
    null,
    contact.email,
    contact.name,
    contact.bio,
    contact.job_title || null,
    contact.company || null,
    contact.tagline,
    contact.links_json,
    contact.headshot_file_id,
    slug,
    now()
  );
  return { profileId: id, created: true };
}
