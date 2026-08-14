/**
 * API domain: forms (spec C parity round 2).
 *
 * Core functions + REST routes + MCP tools for form management — the same
 * engine the admin builder uses (`lib/forms`): copy-on-write schema versioning,
 * option-rename cascades into conditions and draft answers, rich-lite
 * sanitizing of the message fields. REST and MCP share these functions 1:1.
 */
import type { Hono } from 'hono';
import type { Bindings, Event } from '../types';
import { apiActor, type ApiAuth, type ApiCtx } from '../lib/api-tokens';
import {
  bad,
  eventOf,
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
import { all, one, run, now } from '../lib/db';
import { newId } from '../lib/ids';
import { logActivity } from '../lib/activity';
import { looksRich, sanitizeRich } from '../lib/rich';
import { slugify } from '../lib/slugify';
import {
  applyOptionRenames,
  cascadeRenamesIntoDrafts,
  currentVersion,
  detectOptionRenames,
  hydrateSchema,
  listForms,
  listNotifyMembers,
  loadForm,
  loadTaxonomies,
  normalizeField,
  openState,
  parsePreset,
  parseSchema,
  parseSettings,
  presetFields,
  presetSettings,
  PRESET_NAMES,
  randomSecret,
  sanitizeConditions,
  saveSchema,
  shareUrl,
  submissionCounts,
  validateSchema,
  type FormField,
  type FormRow,
  type FormSettings,
} from '../lib/forms';

/* ----------------------------------------------------------------- helpers */

async function formByRef(env: Bindings, auth: ApiAuth, ref: string): Promise<{ form: FormRow; event: Event }> {
  const id = (ref ?? '').trim();
  if (!id) throw bad('Missing form — pass a form id (frm_…)');
  const form = await one<FormRow>(env.DB, `SELECT * FROM forms WHERE id = ?`, id);
  if (!form) throw notFound('Form not found');
  const event = await eventOf(env, auth, form.event_id);
  return { form, event };
}

async function uniqueFormSlug(env: Bindings, eventId: string, base: string, exceptId?: string): Promise<string> {
  const root = slugify(base, 'form');
  let slug = root;
  let n = 2;
  for (;;) {
    const row = await one<{ id: string }>(env.DB, `SELECT id FROM forms WHERE event_id = ? AND slug = ?`, eventId, slug);
    if (!row || row.id === exceptId) return slug;
    slug = `${root}-${n++}`;
  }
}

/** Rich message fields (welcome, post-submit): sanitize rich bodies, pass legacy plain strings. */
function richField(v: unknown, prev: string): string {
  if (typeof v !== 'string') return prev;
  return looksRich(v) ? sanitizeRich(v) : v;
}

async function shapeForm(env: Bindings, event: Event, ref: string) {
  const loaded = await loadForm(env.DB, event.id, ref);
  if (!loaded) throw notFound('Form not found');
  const [taxonomies, counts] = await Promise.all([loadTaxonomies(env.DB, event.id), submissionCounts(env.DB, event.id)]);
  const state = openState(loaded.form, loaded.settings, event.timezone);
  return {
    id: loaded.form.id,
    name: loaded.form.name,
    slug: loaded.form.slug,
    status: loaded.form.status,
    opensAt: loaded.form.opens_at,
    closesAt: loaded.form.closes_at,
    open: state.open,
    openReason: state.reason,
    url: shareUrl(env.APP_ORIGIN, event.slug, loaded.form.slug),
    submissions: counts.get(loaded.form.id) ?? 0,
    version: loaded.version.version,
    versionCount: loaded.versionCount,
    settings: loaded.settings,
    schema: hydrateSchema(loaded.schema, taxonomies),
  };
}

/* -------------------------------------------------------------------- read */

/** One form in full: settings, hydrated schema (live taxonomy options), open state. */
export async function getForm(env: Bindings, auth: ApiAuth, eventRef: string, formRef: string) {
  const event = await resolveEvent(env, auth, eventRef);
  return shapeForm(env, event, formRef);
}

/* ------------------------------------------------------------------- write */

export type CreateFormInput = {
  /** cfp (default) | contact | session (intake, auto-accepts) | empty. */
  preset?: string;
  /** Overrides the preset's default name. */
  name?: string;
};

/** CREATE a form from a preset — same field sets the admin “New form” chooser stamps. */
export async function createForm(env: Bindings, auth: ApiAuth, eventRef: string, input: CreateFormInput) {
  requireWrite(auth);
  const event = await resolveEvent(env, auth, eventRef);
  const db = env.DB;

  const preset = parsePreset(input.preset === 'session_intake' ? 'session' : input.preset);
  const settings = presetSettings(preset);
  const name = (input.name ?? '').trim() || PRESET_NAMES[preset];

  // CFP only: core fields are copied from the event's first form, exactly like
  // the admin chooser. The other presets always start from their own field set.
  let fields: FormField[] = [];
  if (preset === 'cfp') {
    const existing = await listForms(db, event.id);
    if (existing.length) {
      const first = await loadForm(db, event.id, existing[0].id);
      fields = (first?.schema.fields ?? []).filter((f) => f.core);
    }
  }
  if (preset !== 'empty' && !fields.length) {
    const formatTax = await one<{ id: string }>(
      db,
      `SELECT id FROM taxonomies WHERE event_id = ? AND name = 'Format' LIMIT 1`,
      event.id
    );
    fields = presetFields(preset, settings.coSpeakerCap, formatTax?.id ?? null);
  }

  const id = newId('frm');
  const slug = await uniqueFormSlug(env, event.id, name);
  await run(
    db,
    `INSERT INTO forms (id, event_id, name, slug, status, opens_at, closes_at, settings_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    event.id,
    name,
    slug,
    'draft',
    null,
    null,
    JSON.stringify(settings),
    now()
  );
  await run(
    db,
    `INSERT INTO form_versions (id, form_id, version, schema_json, created_at) VALUES (?,?,1,?,?)`,
    newId('fvr'),
    id,
    JSON.stringify({ fields }),
    now()
  );
  await logActivity(db, {
    eventId: event.id,
    subjectType: 'form',
    subjectId: id,
    actor: apiActor(auth),
    action: 'Form created',
    detail: `${PRESET_NAMES[preset]} preset · via API`,
  });
  return shapeForm(env, event, id);
}

export type UpdateFormInput = {
  name?: string;
  status?: string;
  opensAt?: string | null;
  closesAt?: string | null;
  settings?: Partial<FormSettings> & { lateLink?: boolean };
};

const FORM_STATUSES = ['draft', 'open', 'closed'];

/** UPDATE form meta (name/status/window) and/or settings (merged). */
export async function updateForm(env: Bindings, auth: ApiAuth, ref: string, input: UpdateFormInput) {
  requireWrite(auth);
  const { form, event } = await formByRef(env, auth, ref);
  const db = env.DB;
  const prev = parseSettings(form.settings_json);

  const name = typeof input.name === 'string' ? input.name.trim() || form.name : form.name;
  let status = form.status;
  if (input.status !== undefined) {
    if (!FORM_STATUSES.includes(String(input.status))) {
      throw bad(`status must be one of ${FORM_STATUSES.join(', ')}`);
    }
    status = String(input.status);
  }
  const opensAt = input.opensAt === undefined ? form.opens_at : input.opensAt ? String(input.opensAt).slice(0, 10) : null;
  let closesAt =
    input.closesAt === undefined ? form.closes_at : input.closesAt ? String(input.closesAt).slice(0, 10) : null;
  if (opensAt && closesAt && closesAt < opensAt) closesAt = opensAt;

  let settings = prev;
  if (input.settings !== undefined) {
    const patch = input.settings;
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw bad('settings must be an object');
    const memberIds = new Set((await listNotifyMembers(db, event.org_id)).map((m) => m.id));
    const { lateLink, ...rest } = patch;
    settings = {
      ...prev,
      ...rest,
      notifyEmails: Array.isArray(patch.notifyEmails) ? patch.notifyEmails.map(String) : prev.notifyEmails,
      notifyMemberIds: Array.isArray(patch.notifyMemberIds)
        ? patch.notifyMemberIds.map(String).filter((id) => memberIds.has(id))
        : prev.notifyMemberIds,
      submitsAs: patch.submitsAs === 'session' ? 'session' : patch.submitsAs === 'submission' ? 'submission' : prev.submitsAs,
    };
    // `lateLink: true` mints (or keeps) the secret; false clears it.
    if (lateLink === true) settings.lateLinkSecret = prev.lateLinkSecret || randomSecret();
    else if (lateLink === false) settings.lateLinkSecret = null;
    settings.welcomeMd = richField(settings.welcomeMd, prev.welcomeMd);
    settings.postSubmitMsg = richField(settings.postSubmitMsg, prev.postSubmitMsg);
  }

  const slug = name === form.name ? form.slug : await uniqueFormSlug(env, event.id, name, form.id);
  await run(
    db,
    `UPDATE forms SET name = ?, slug = ?, status = ?, opens_at = ?, closes_at = ?, settings_json = ? WHERE id = ?`,
    name,
    slug,
    status,
    opensAt,
    closesAt,
    JSON.stringify(settings),
    form.id
  );

  await logActivity(db, {
    eventId: event.id,
    subjectType: 'form',
    subjectId: form.id,
    actor: apiActor(auth),
    action:
      status !== form.status
        ? status === 'open'
          ? 'Form opened'
          : status === 'closed'
            ? 'Form closed'
            : 'Form unpublished'
        : 'Form settings updated',
    detail: `${name} · via API`,
  });

  return shapeForm(env, event, form.id);
}

export type UpdateFormSchemaInput = { fields?: unknown[] };

/**
 * REPLACE the form's field list — the builder's save pipeline: normalize,
 * sanitize conditions, cascade option renames (into conditions and draft
 * answers), validate, then copy-on-write version via `saveSchema`.
 */
export async function updateFormSchema(env: Bindings, auth: ApiAuth, ref: string, input: UpdateFormSchemaInput) {
  requireWrite(auth);
  const { form, event } = await formByRef(env, auth, ref);
  const db = env.DB;
  if (!Array.isArray(input.fields)) throw bad('Pass fields — the full field array (see get_form → schema.fields)');

  const fields = input.fields.map((f, i) => normalizeField(f, i)).filter((f): f is FormField => !!f);
  const { fields: sanitized, dropped } = sanitizeConditions(fields);

  // Options are stored by label, so an in-place rename would orphan every
  // condition (and draft answer) still holding the old label — cascade it.
  const before = await currentVersion(db, form.id);
  const renames = before ? detectOptionRenames(parseSchema(before.schema_json).fields, sanitized) : [];
  const clean = applyOptionRenames(sanitized, renames);

  const problem = validateSchema(clean);
  if (problem) throw bad(problem);

  const result = await saveSchema(db, form.id, { fields: clean });
  await cascadeRenamesIntoDrafts(db, form.id, renames);
  if (result.bumped) {
    await logActivity(db, {
      eventId: event.id,
      subjectType: 'form',
      subjectId: form.id,
      actor: apiActor(auth),
      action: 'Form version created',
      detail: `v${result.version.version} — v${before?.version ?? 1} keeps its submissions’ answers · via API`,
    });
  }
  return {
    formId: form.id,
    version: result.version.version,
    bumped: result.bumped,
    // A condition whose source ended up later in the form is cleared, not
    // rejected — same rule the builder applies on drop.
    sanitizedConditions: dropped,
    fields: clean,
  };
}

/** DELETE a form — refused once it has submissions (close it instead). */
export async function deleteForm(env: Bindings, auth: ApiAuth, ref: string) {
  requireWrite(auth);
  const { form, event } = await formByRef(env, auth, ref);
  const used = await one<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM submissions WHERE form_id = ?`, form.id);
  if ((used?.n ?? 0) > 0) throw bad('This form has submissions — close it instead of deleting');
  await run(env.DB, `DELETE FROM form_versions WHERE form_id = ?`, form.id);
  await run(env.DB, `DELETE FROM forms WHERE id = ?`, form.id);
  await logActivity(env.DB, {
    eventId: event.id,
    subjectType: 'form',
    subjectId: form.id,
    actor: apiActor(auth),
    action: 'Form deleted',
    detail: `${form.name} · via API`,
  });
  return { id: form.id, name: form.name, deleted: true };
}

/* -------------------------------------------------------------- REST routes */

export function registerFormRoutes(app: Hono<ApiCtx>): void {
  app.get('/api/v1/events/:event/forms/:form', handle((c) => getForm(c.env, c.var.apiAuth, p(c, 'event'), p(c, 'form'))));
  app.post(
    '/api/v1/events/:event/forms',
    handle(async (c) => createForm(c.env, c.var.apiAuth, p(c, 'event'), await jsonBody(c)))
  );
  app.patch('/api/v1/forms/:id', handle(async (c) => updateForm(c.env, c.var.apiAuth, p(c, 'id'), await jsonBody(c))));
  app.put(
    '/api/v1/forms/:id/schema',
    handle(async (c) => updateFormSchema(c.env, c.var.apiAuth, p(c, 'id'), await jsonBody(c)))
  );
  app.delete('/api/v1/forms/:id', handle((c) => deleteForm(c.env, c.var.apiAuth, p(c, 'id'))));
}

/* --------------------------------------------------------------- MCP tools */

export const FORM_TOOLS: Tool[] = [
  {
    name: 'get_form',
    description:
      'Get one form in full: settings, open state, and the hydrated field schema (taxonomy-bound SEL/MULTI options resolved live). Field flags show what is public / speaker-editable / evaluator-visible. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        form: { type: 'string', description: 'Form id or slug on this event.' },
      },
      required: ['event', 'form'],
      additionalProperties: false,
    },
    run: (env, auth, a) => getForm(env, auth, str(a.event), str(a.form)),
  },
  {
    name: 'create_form',
    description:
      'CREATE a form from a preset (cfp default; contact; session = sponsor intake that auto-accepts; empty). Starts as a draft — use update_form to open it. The cfp preset copies core fields from the event’s first form when one exists. Activity-logged, sends no email.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        event: EVENT_PROP,
        preset: { type: 'string', enum: ['cfp', 'contact', 'session', 'empty'], description: 'Default cfp.' },
        name: { type: 'string', description: 'Overrides the preset’s default name.' },
      },
      required: ['event'],
      additionalProperties: false,
    },
    run: (env, auth, a) => createForm(env, auth, str(a.event), a as CreateFormInput),
  },
  {
    name: 'update_form',
    description:
      'UPDATE a form: name, status (draft|open|closed), opens/closes dates (YYYY-MM-DD, null clears), and/or settings (merged: allowDrafts, welcomeEnabled, welcomeMd, coSpeakerCap, postSubmitMsg, notifyEmails, notifyMemberIds, externalName, pageHeading, submitsAs, lateLink true/false to mint/clear the late-submission secret). Renaming re-derives the slug. Activity-logged.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Form id (frm_…).' },
        name: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'open', 'closed'] },
        opensAt: { type: ['string', 'null'], description: 'YYYY-MM-DD; null clears.' },
        closesAt: { type: ['string', 'null'], description: 'YYYY-MM-DD; null clears.' },
        settings: { type: 'object', description: 'Partial settings object, merged onto the current settings.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => updateForm(env, auth, str(a.id), a as UpdateFormInput),
  },
  {
    name: 'update_form_schema',
    description:
      'REPLACE a form’s field list (the full array — fetch with get_form, edit, send back). Runs the builder pipeline: normalize, drop invalid conditions, cascade option renames into conditions and draft answers, validate. Versioning is copy-on-write: if real submissions point at the current version, a new version is created (bumped=true) and old answers stay intact.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Form id (frm_…).' },
        fields: {
          type: 'array',
          description:
            'Full ordered field array. Each field: {id, type: TXT|LONG|EML|URL|TEL|NUM|DATE|SEL|MULTI|CHK|FILE|HDR|GRP, label, required, placeholder?, help?, opts?, taxonomyId?, validation{}, flags{public,speakerEditable,evaluatorVisible}, cond|null, core?, role?}. Keep existing field ids to preserve answers.',
          items: { type: 'object' },
        },
      },
      required: ['id', 'fields'],
      additionalProperties: false,
    },
    run: (env, auth, a) => updateFormSchema(env, auth, str(a.id), a as UpdateFormSchemaInput),
  },
  {
    name: 'delete_form',
    description: 'DELETE a form and its versions. Refused once the form has submissions — close it instead. Activity-logged.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Form id (frm_…).' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (env, auth, a) => deleteForm(env, auth, str(a.id)),
  },
];
