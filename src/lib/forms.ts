/**
 * Form schema + versioning (track B1).
 *
 * `form_versions.schema_json` holds the canonical shape from `SPECS/B-shared.md`:
 *
 *   { fields: [ { id, core, type, label, required, placeholder, help, opts,
 *                 taxonomyId, validation:{…}, flags:{…}, cond:{…}|null } ] }
 *
 * The sandbox seed (`lib/seed-data.ts`, itself a copy of the prototype's
 * `Forms.dc.html` state) stores the *prototype* shape instead — `req/agenda/
 * edit/eval` booleans and a human `val` string like "max 150 words · live
 * counter". `parseSchema` normalizes both into the canonical shape, so seeded
 * events and freshly built forms flow through exactly the same code.
 */
import { all, jsonParse, now, one, run } from './db';
import { newId } from './ids';
import type { CondOp } from './conditions';

/* ------------------------------------------------------------------ types */

export type FieldType =
  | 'TXT'
  | 'LONG'
  | 'EML'
  | 'URL'
  | 'TEL'
  | 'NUM'
  | 'DATE'
  | 'SEL'
  | 'MULTI'
  | 'CHK'
  | 'FILE'
  | 'HDR'
  | 'GRP';

export type CoreRole = 'title' | 'abstract' | 'format' | 'speakers';

export type FieldValidation = {
  minChars?: number;
  maxChars?: number;
  maxWords?: number;
  /** NUM value range; MULTI selection count range. */
  min?: number;
  max?: number;
  numKind?: 'integer' | 'decimal';
  dateFrom?: string;
  dateTo?: string;
  /** comma/space separated extension whitelist, e.g. "pdf, key" */
  fileExts?: string;
  fileMaxMb?: number;
  fileMaxCount?: number;
  mustCheck?: boolean;
  /** total speakers allowed on the submission (the prototype's "cap 3" = 3 people). */
  maxSpeakers?: number;
};

export type FieldFlags = {
  public: boolean;
  speakerEditable: boolean;
  evaluatorVisible: boolean;
};

export type FieldCond = { src: string; op: CondOp; val: string; alsoReq?: boolean };

export type FormField = {
  id: string;
  core?: boolean;
  role?: CoreRole;
  type: FieldType;
  label: string;
  required: boolean;
  placeholder?: string;
  help?: string;
  opts?: string[];
  taxonomyId?: string;
  /** Legacy/seed binding by name; resolved to `taxonomyId` + `opts` by `hydrateSchema`. */
  taxonomyName?: string;
  validation: FieldValidation;
  flags: FieldFlags;
  cond: FieldCond | null;
};

export type FormSchema = { fields: FormField[] };

export type FormSettings = {
  allowDrafts: boolean;
  lateLinkSecret: string | null;
  welcomeEnabled: boolean;
  welcomeMd: string;
  /** ADDITIONAL co-speakers offered when a form is created (the drawer's wording). */
  coSpeakerCap: number;
  postSubmitMsg: string;
  notifyEmails: string[];
  /**
   * Team members notified on every new submission, by `users.id`. Stored as ids
   * rather than addresses so the link stays live: a member who changes their
   * email keeps getting notified, and one removed from the org stops.
   */
  notifyMemberIds: string[];
  audience: string;
  /** Public-facing form title (B1). Empty = fall back to the internal `forms.name`. */
  externalName: string;
  /** Public page H1 (B1). Empty = the default `Speak at {event.name}`. */
  pageHeading: string;
  /**
   * B5 (DECISIONS R7): 'session' forms auto-accept every submission and create
   * a sponsor Session immediately — no evaluation, no decision email.
   */
  submitsAs: 'submission' | 'session';
};

export type FormRow = {
  id: string;
  event_id: string;
  name: string;
  slug: string;
  status: string;
  opens_at: string | null;
  closes_at: string | null;
  settings_json: string;
  created_at: string;
};

export type FormVersionRow = {
  id: string;
  form_id: string;
  version: number;
  schema_json: string;
  created_at: string;
};

/* ------------------------------------------------------------------ palette */

/** The prototype's 12 draggable field types (GRP is core-only). */
export const PALETTE: { label: string; type: FieldType }[] = [
  { label: 'Short text', type: 'TXT' },
  { label: 'Long text', type: 'LONG' },
  { label: 'Email', type: 'EML' },
  { label: 'URL', type: 'URL' },
  { label: 'Phone', type: 'TEL' },
  { label: 'Number', type: 'NUM' },
  { label: 'Single select', type: 'SEL' },
  { label: 'Multi select', type: 'MULTI' },
  { label: 'Checkbox', type: 'CHK' },
  { label: 'Date', type: 'DATE' },
  { label: 'File upload', type: 'FILE' },
  { label: 'Section header', type: 'HDR' },
];

export const FILE_PRESETS: Record<string, string> = {
  doc: 'pdf, doc, docx',
  img: 'jpg, png, gif',
  slides: 'pdf, ppt, pptx, key',
  video: 'mp4, mov',
  audio: 'mp3, wav, m4a',
};

const TYPES = new Set<string>([
  'TXT',
  'LONG',
  'EML',
  'URL',
  'TEL',
  'NUM',
  'DATE',
  'SEL',
  'MULTI',
  'CHK',
  'FILE',
  'HDR',
  'GRP',
]);

/* ------------------------------------------------------------------ parsing */

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

/**
 * Prototype `val` strings → structured validation. Same regexes the builder in
 * `Forms.dc.html` used to read them back out of the display string.
 */
function validationFromVal(type: FieldType, raw: string): { validation: FieldValidation; taxonomyName?: string } {
  const v = raw || '';
  const pick = (re: RegExp) => (v.match(re) || [])[1];
  const validation: FieldValidation = {};
  let taxonomyName: string | undefined;

  const tax = pick(/bound to taxonomy:\s*([^·—\n]+)/i);
  if (tax) taxonomyName = tax.trim();

  if (type === 'TXT') {
    validation.minChars = num(pick(/min\s*(\d+)/i));
    validation.maxChars = num(pick(/max\s*(\d+)/i));
  } else if (type === 'MULTI') {
    validation.min = num(pick(/min\s*(\d+)/i));
    validation.max = num(pick(/max\s*(\d+)/i));
  } else if (type === 'LONG') {
    validation.maxWords = num(pick(/max\s*(\d+)\s*words/i));
  } else if (type === 'NUM') {
    validation.numKind = /decimal/i.test(v) ? 'decimal' : 'integer';
    validation.min = num(pick(/min\s*(-?[\d.]+)/i));
    validation.max = num(pick(/max\s*(-?[\d.]+)/i));
  } else if (type === 'DATE') {
    validation.dateFrom = pick(/from\s*([\d-]+)/i);
    validation.dateTo = pick(/to\s*([\d-]+)/i);
  } else if (type === 'FILE') {
    const exts = pick(/types:\s*([^·]+)/i);
    validation.fileExts = exts ? exts.trim() : undefined;
    validation.fileMaxMb = num(pick(/(\d+)\s*MB/i));
    validation.fileMaxCount = num(pick(/up to\s*(\d+)/i));
  } else if (type === 'CHK') {
    validation.mustCheck = /must be checked/i.test(v);
  } else if (type === 'GRP') {
    validation.maxSpeakers = num(pick(/cap\s*(\d+)/i));
  }

  for (const k of Object.keys(validation) as (keyof FieldValidation)[]) {
    if (validation[k] === undefined) delete validation[k];
  }
  return { validation, taxonomyName };
}

export function emptyValidation(): FieldValidation {
  return {};
}

export function defaultFlags(): FieldFlags {
  return { public: false, speakerEditable: false, evaluatorVisible: true };
}

const OPS = new Set<string>([
  'is',
  'is not',
  'contains',
  'does not contain',
  'is answered',
  'is blank',
  'gt',
  'lt',
]);

function normalizeCond(raw: unknown): FieldCond | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const src = str(c.src);
  if (!src) return null;
  const op = typeof c.op === 'string' && OPS.has(c.op) ? (c.op as CondOp) : 'is';
  return {
    src,
    op,
    val: c.val === undefined || c.val === null ? '' : String(c.val),
    alsoReq: !!c.alsoReq,
  };
}

/** Accepts the canonical shape *and* the prototype/seed shape. */
export function normalizeField(raw: unknown, index: number): FormField | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  const type = (typeof f.type === 'string' && TYPES.has(f.type) ? f.type : 'TXT') as FieldType;
  const id = str(f.id) || `f_${index}_${Math.random().toString(36).slice(2, 10)}`;

  const legacy = validationFromVal(type, typeof f.val === 'string' ? f.val : '');
  const validation: FieldValidation =
    f.validation && typeof f.validation === 'object'
      ? { ...legacy.validation, ...(f.validation as FieldValidation) }
      : legacy.validation;

  const flagsRaw = f.flags && typeof f.flags === 'object' ? (f.flags as Record<string, unknown>) : null;
  const flags: FieldFlags = flagsRaw
    ? {
        public: !!flagsRaw.public,
        speakerEditable: !!flagsRaw.speakerEditable,
        evaluatorVisible: flagsRaw.evaluatorVisible === undefined ? true : !!flagsRaw.evaluatorVisible,
      }
    : {
        public: !!f.agenda,
        speakerEditable: !!f.edit,
        evaluatorVisible: f.eval === undefined ? true : !!f.eval,
      };

  const opts = Array.isArray(f.opts) ? f.opts.map((o) => String(o)) : undefined;

  const field: FormField = {
    id,
    type,
    label: typeof f.label === 'string' ? f.label : 'Untitled field',
    required: f.required === undefined ? !!f.req : !!f.required,
    validation,
    flags,
    cond: normalizeCond(f.cond),
  };
  if (f.core) field.core = true;
  if (typeof f.role === 'string' && ['title', 'abstract', 'format', 'speakers'].includes(f.role)) {
    field.role = f.role as CoreRole;
  }
  const placeholder = str(f.placeholder) ?? str(f.ph);
  if (placeholder) field.placeholder = placeholder;
  const help = str(f.help);
  if (help) field.help = help;
  if (opts) field.opts = opts;
  const taxonomyId = str(f.taxonomyId);
  if (taxonomyId) field.taxonomyId = taxonomyId;
  const taxonomyName = str(f.taxonomyName) ?? legacy.taxonomyName;
  if (taxonomyName) field.taxonomyName = taxonomyName;
  return field;
}

export function parseSchema(raw: string | null | undefined): FormSchema {
  const obj = jsonParse<{ fields?: unknown[] }>(raw, { fields: [] });
  const list = Array.isArray(obj.fields) ? obj.fields : [];
  const fields: FormField[] = [];
  const seen = new Set<string>();
  list.forEach((f, i) => {
    const field = normalizeField(f, i);
    if (!field || seen.has(field.id)) return;
    seen.add(field.id);
    fields.push(field);
  });
  return { fields };
}

export function parseSettings(raw: string | null | undefined): FormSettings {
  const s = jsonParse<Record<string, unknown>>(raw, {});
  const welcomeMd = typeof s.welcomeMd === 'string' ? s.welcomeMd : '';
  return {
    allowDrafts: s.allowDrafts === undefined ? true : !!s.allowDrafts,
    lateLinkSecret: typeof s.lateLinkSecret === 'string' && s.lateLinkSecret ? s.lateLinkSecret : null,
    welcomeEnabled: s.welcomeEnabled === undefined ? !!welcomeMd : !!s.welcomeEnabled,
    welcomeMd,
    coSpeakerCap: Number.isFinite(Number(s.coSpeakerCap)) ? Number(s.coSpeakerCap) : 2,
    postSubmitMsg: typeof s.postSubmitMsg === 'string' ? s.postSubmitMsg : '',
    notifyEmails: Array.isArray(s.notifyEmails) ? s.notifyEmails.map((e) => String(e)).filter(Boolean) : [],
    notifyMemberIds: Array.isArray(s.notifyMemberIds)
      ? s.notifyMemberIds.map((id) => String(id)).filter(Boolean)
      : [],
    audience: typeof s.audience === 'string' ? s.audience : 'Public link',
    externalName: typeof s.externalName === 'string' ? s.externalName : '',
    pageHeading: typeof s.pageHeading === 'string' ? s.pageHeading : '',
    submitsAs: s.submitsAs === 'session' ? 'session' : 'submission',
  };
}

/* ------------------------------------------------------------------ core roles */

/**
 * Which field carries the title / abstract / format / speakers. Freshly built
 * forms carry an explicit `role`; seeded forms are inferred from type + label
 * (the sponsor form's core TXT list starts with "Company", so a plain
 * "first core TXT" rule would pick the wrong one).
 */
export function coreRoles(fields: FormField[]): {
  title: FormField | null;
  abstract: FormField | null;
  format: FormField | null;
  speakers: FormField | null;
} {
  const byRole = (r: CoreRole) => fields.find((f) => f.role === r) ?? null;
  const speakers = byRole('speakers') ?? fields.find((f) => f.type === 'GRP') ?? null;
  const abstract =
    byRole('abstract') ?? fields.find((f) => f.core && f.type === 'LONG') ?? fields.find((f) => f.type === 'LONG') ?? null;
  const titleCandidates = fields.filter((f) => f.type === 'TXT');
  const title =
    byRole('title') ??
    titleCandidates.find((f) => f.core && /title/i.test(f.label)) ??
    titleCandidates.find((f) => /title/i.test(f.label)) ??
    titleCandidates.find((f) => f.core) ??
    titleCandidates[0] ??
    null;
  const selects = fields.filter((f) => f.type === 'SEL');
  const format =
    byRole('format') ??
    selects.find((f) => (f.taxonomyName || '').toLowerCase() === 'format') ??
    selects.find((f) => /format/i.test(f.label)) ??
    null;
  return { title, abstract, format, speakers };
}

/** Total speakers a submission may carry (GRP cap wins, settings cap seeds it). */
export function speakerCap(fields: FormField[], settings: FormSettings): number {
  const grp = coreRoles(fields).speakers;
  const fromField = grp?.validation.maxSpeakers;
  if (fromField && fromField > 0) return fromField;
  return Math.max(1, (settings.coSpeakerCap || 0) + 1);
}

/* ------------------------------------------------------------------ submission notifications */

export type NotifyMember = { id: string; name: string | null; email: string; role: string };

/** Org members offered as notification targets in a form's settings, owners first. */
export async function listNotifyMembers(db: D1Database, orgId: string): Promise<NotifyMember[]> {
  return all<NotifyMember>(
    db,
    `SELECT u.id, u.name, u.email, m.role
       FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.email`,
    orgId
  );
}

/**
 * Who gets the "new submission" email: the linked team members (resolved fresh
 * on every send, so team changes take effect without editing the form) plus the
 * standalone addresses. Deduped case-insensitively — a member listed by address
 * as well is notified once.
 */
export async function notifyRecipients(
  db: D1Database,
  orgId: string,
  settings: FormSettings
): Promise<{ email: string; name: string | null }[]> {
  const out = new Map<string, { email: string; name: string | null }>();
  if (settings.notifyMemberIds.length) {
    const members = await listNotifyMembers(db, orgId);
    const wanted = new Set(settings.notifyMemberIds);
    for (const m of members) {
      if (wanted.has(m.id) && m.email) out.set(m.email.toLowerCase(), { email: m.email, name: m.name });
    }
  }
  for (const raw of settings.notifyEmails) {
    const email = raw.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (!out.has(key)) out.set(key, { email, name: null });
  }
  return [...out.values()];
}

/* ------------------------------------------------------------------ taxonomies */

export type TaxonomyView = { id: string; name: string; options: string[] };

/** Format options read "Talk (30 min)" — exactly the labels the seed hard-codes. */
export function optionLabel(name: string, durationMin: number | null): string {
  return durationMin ? `${name} (${durationMin} min)` : name;
}

export async function loadTaxonomies(db: D1Database, eventId: string): Promise<TaxonomyView[]> {
  const taxes = await all<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM taxonomies WHERE event_id = ? ORDER BY position, name`,
    eventId
  );
  const opts = await all<{ taxonomy_id: string; name: string; duration_min: number | null }>(
    db,
    `SELECT o.taxonomy_id, o.name, o.duration_min FROM taxonomy_options o
       JOIN taxonomies t ON t.id = o.taxonomy_id
      WHERE t.event_id = ? ORDER BY o.position, o.name`,
    eventId
  );
  return taxes.map((t) => ({
    id: t.id,
    name: t.name,
    options: opts.filter((o) => o.taxonomy_id === t.id).map((o) => optionLabel(o.name, o.duration_min)),
  }));
}

/** Fills `opts` for taxonomy-bound selects and resolves name bindings to ids. */
export function hydrateSchema(schema: FormSchema, taxonomies: TaxonomyView[]): FormSchema {
  const byId = new Map(taxonomies.map((t) => [t.id, t]));
  const byName = new Map(taxonomies.map((t) => [t.name.toLowerCase(), t]));
  return {
    fields: schema.fields.map((f) => {
      if (f.type !== 'SEL' && f.type !== 'MULTI') return f;
      const tax = (f.taxonomyId && byId.get(f.taxonomyId)) || (f.taxonomyName && byName.get(f.taxonomyName.toLowerCase()));
      if (!tax) return f;
      return { ...f, taxonomyId: tax.id, taxonomyName: tax.name, opts: tax.options };
    }),
  };
}

/* ------------------------------------------------------------------ validation of the schema itself */

export function validateSchema(fields: FormField[]): string | null {
  const seen = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (seen.has(f.id)) return `Duplicate field id “${f.id}”.`;
    seen.add(f.id);
    if ((f.type === 'SEL' || f.type === 'MULTI') && !f.taxonomyId && !f.taxonomyName && !(f.opts && f.opts.length)) {
      return `“${f.label}” needs at least one option, or a taxonomy binding.`;
    }
    if (f.cond) {
      const srcIdx = fields.findIndex((x) => x.id === f.cond!.src);
      if (srcIdx >= 0 && srcIdx >= i) {
        return `“${f.label}” has a condition on a field that comes later in the form.`;
      }
    }
  }
  return null;
}

/** Drops conditions whose source now sits at or after the field (drag-reorder invariant). */
export function sanitizeConditions(fields: FormField[]): { fields: FormField[]; dropped: boolean } {
  let dropped = false;
  const out = fields.map((f, i) => {
    if (f.cond) {
      const idx = fields.findIndex((x) => x.id === f.cond!.src);
      if (idx >= i) {
        dropped = true;
        return { ...f, cond: null };
      }
    }
    return f;
  });
  return { fields: out, dropped };
}

/* ------------------------------------------------------------------ loading */

export type LoadedForm = {
  form: FormRow;
  settings: FormSettings;
  version: FormVersionRow;
  versionCount: number;
  schema: FormSchema;
};

export async function listForms(db: D1Database, eventId: string): Promise<FormRow[]> {
  return await all<FormRow>(
    db,
    `SELECT * FROM forms WHERE event_id = ? ORDER BY (status = 'open') DESC, created_at`,
    eventId
  );
}

export async function submissionCounts(db: D1Database, eventId: string): Promise<Map<string, number>> {
  const rows = await all<{ form_id: string; n: number }>(
    db,
    `SELECT form_id, COUNT(*) AS n FROM submissions WHERE event_id = ? AND status <> 'draft' GROUP BY form_id`,
    eventId
  );
  return new Map(rows.map((r) => [r.form_id, r.n]));
}

export async function currentVersion(db: D1Database, formId: string): Promise<FormVersionRow | null> {
  return await one<FormVersionRow>(
    db,
    `SELECT * FROM form_versions WHERE form_id = ? ORDER BY version DESC LIMIT 1`,
    formId
  );
}

export async function loadForm(
  db: D1Database,
  eventId: string,
  idOrSlug: string
): Promise<LoadedForm | null> {
  const form = await one<FormRow>(
    db,
    `SELECT * FROM forms WHERE event_id = ? AND (id = ? OR slug = ?) LIMIT 1`,
    eventId,
    idOrSlug,
    idOrSlug
  );
  if (!form) return null;
  return await loadFormRow(db, form);
}

export async function loadFormRow(db: D1Database, form: FormRow): Promise<LoadedForm> {
  let version = await currentVersion(db, form.id);
  if (!version) {
    version = {
      id: newId('fvr'),
      form_id: form.id,
      version: 1,
      schema_json: JSON.stringify({ fields: [] }),
      created_at: now(),
    };
    await run(
      db,
      `INSERT INTO form_versions (id, form_id, version, schema_json, created_at) VALUES (?,?,?,?,?)`,
      version.id,
      version.form_id,
      version.version,
      version.schema_json,
      version.created_at
    );
  }
  const count = await one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM form_versions WHERE form_id = ?`,
    form.id
  );
  return {
    form,
    settings: parseSettings(form.settings_json),
    version,
    versionCount: count?.n ?? 1,
    schema: parseSchema(version.schema_json),
  };
}

/** A version is frozen once a real (non-draft) submission points at it. */
export async function versionIsFrozen(db: D1Database, versionId: string): Promise<boolean> {
  const row = await one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM submissions WHERE form_version_id = ? AND status <> 'draft'`,
    versionId
  );
  return (row?.n ?? 0) > 0;
}

export type SaveSchemaResult = { version: FormVersionRow; bumped: boolean };

/**
 * Copy-on-write: edits land on the current draft version until it carries a
 * non-draft submission, then the next edit forks version N+1.
 */
export async function saveSchema(
  db: D1Database,
  formId: string,
  schema: FormSchema
): Promise<SaveSchemaResult> {
  const current = await currentVersion(db, formId);
  const json = JSON.stringify(schema);
  if (!current) {
    const version: FormVersionRow = {
      id: newId('fvr'),
      form_id: formId,
      version: 1,
      schema_json: json,
      created_at: now(),
    };
    await run(
      db,
      `INSERT INTO form_versions (id, form_id, version, schema_json, created_at) VALUES (?,?,?,?,?)`,
      version.id,
      version.form_id,
      version.version,
      version.schema_json,
      version.created_at
    );
    return { version, bumped: false };
  }
  if (await versionIsFrozen(db, current.id)) {
    const version: FormVersionRow = {
      id: newId('fvr'),
      form_id: formId,
      version: current.version + 1,
      schema_json: json,
      created_at: now(),
    };
    await run(
      db,
      `INSERT INTO form_versions (id, form_id, version, schema_json, created_at) VALUES (?,?,?,?,?)`,
      version.id,
      version.form_id,
      version.version,
      version.schema_json,
      version.created_at
    );
    return { version, bumped: true };
  }
  await run(db, `UPDATE form_versions SET schema_json = ? WHERE id = ?`, json, current.id);
  return { version: { ...current, schema_json: json }, bumped: false };
}

/* ------------------------------------------------------------------ creation */

export function coreFields(coSpeakerCap: number, formatTaxonomyId?: string | null): FormField[] {
  return [
    {
      id: 'f_title',
      core: true,
      role: 'title',
      type: 'TXT',
      label: 'Session title',
      required: true,
      placeholder: 'Make it concrete — attendees choose by title',
      validation: { minChars: 8, maxChars: 90 },
      flags: { public: true, speakerEditable: false, evaluatorVisible: true },
      cond: null,
    },
    {
      id: 'f_abstract',
      core: true,
      role: 'abstract',
      type: 'LONG',
      label: 'Abstract',
      required: true,
      placeholder: 'What will the audience walk away with?',
      validation: { maxWords: 150 },
      flags: { public: true, speakerEditable: true, evaluatorVisible: true },
      cond: null,
    },
    {
      id: 'f_format',
      core: true,
      role: 'format',
      type: 'SEL',
      label: 'Format',
      required: true,
      taxonomyId: formatTaxonomyId ?? undefined,
      taxonomyName: formatTaxonomyId ? 'Format' : undefined,
      opts: [],
      validation: {},
      flags: { public: true, speakerEditable: false, evaluatorVisible: true },
      cond: null,
    },
    {
      id: 'f_speakers',
      core: true,
      role: 'speakers',
      type: 'GRP',
      label: 'Speaker — name, email, bio, headshot',
      required: true,
      validation: { maxSpeakers: Math.max(1, coSpeakerCap + 1) },
      flags: { public: true, speakerEditable: true, evaluatorVisible: false },
      cond: null,
    },
  ];
}

export function defaultSettings(): FormSettings {
  return {
    allowDrafts: true,
    lateLinkSecret: null,
    welcomeEnabled: false,
    welcomeMd: '',
    coSpeakerCap: 2,
    postSubmitMsg: 'Thanks! We review on a rolling basis — you’ll hear from us by email.',
    notifyEmails: [],
    notifyMemberIds: [],
    audience: 'Public link',
    externalName: '',
    pageHeading: '',
    submitsAs: 'submission',
  };
}

/* ------------------------------------------------------------------ presets (B4) */

export type FormPreset = 'cfp' | 'contact' | 'session';

export function parsePreset(v: unknown): FormPreset {
  return v === 'contact' || v === 'session' ? v : 'cfp';
}

export const PRESET_NAMES: Record<FormPreset, string> = {
  cfp: 'Call for proposals',
  contact: 'Contact form',
  session: 'Session intake',
};

function headerField(id: string, label: string, help: string): FormField {
  return {
    id,
    type: 'HDR',
    label,
    required: false,
    help,
    validation: {},
    flags: { public: false, speakerEditable: false, evaluatorVisible: true },
    cond: null,
  };
}

/**
 * The default CFP template: the core fields framed by section headers whose
 * title + description are the B2 copy blocks (editable per form in the builder).
 */
export function cfpFields(coSpeakerCap: number, formatTaxonomyId?: string | null): FormField[] {
  const core = coreFields(coSpeakerCap, formatTaxonomyId);
  return [
    headerField(
      'h_session',
      'Your session',
      'Title, abstract and format. The abstract is what evaluators read first — say what the audience walks away with.'
    ),
    ...core.filter((f) => f.role !== 'speakers'),
    headerField('h_speakers', 'Speakers', 'Who’s on stage. Add co-speakers if you’re presenting together.'),
    ...core.filter((f) => f.role === 'speakers'),
  ];
}

/** Contact form: collect people's info — no session, no abstract, no speakers. */
export function contactFields(): FormField[] {
  const flags: FieldFlags = { public: false, speakerEditable: false, evaluatorVisible: true };
  return [
    headerField('h_contact', 'Get in touch', 'We read everything and reply by email.'),
    {
      id: 'f_name',
      role: 'title',
      type: 'TXT',
      label: 'Name',
      required: true,
      placeholder: 'Full name',
      validation: {},
      flags,
      cond: null,
    },
    {
      id: 'f_email',
      type: 'EML',
      label: 'Email',
      required: true,
      validation: {},
      flags,
      cond: null,
    },
    {
      id: 'f_message',
      role: 'abstract',
      type: 'LONG',
      label: 'Message',
      required: true,
      placeholder: 'What would you like to tell us?',
      validation: {},
      flags,
      cond: null,
    },
  ];
}

/** Session intake (B5): CFP fields plus a company field, labeled for sponsors. */
export function sessionIntakeFields(coSpeakerCap: number, formatTaxonomyId?: string | null): FormField[] {
  const core = coreFields(coSpeakerCap, formatTaxonomyId).map((f) => {
    if (f.role === 'abstract') {
      return {
        ...f,
        label: 'Session description',
        placeholder: 'What will attendees learn? No pure product pitches.',
      };
    }
    return f;
  });
  const company: FormField = {
    id: 'f_company',
    core: true,
    type: 'TXT',
    label: 'Company',
    required: true,
    placeholder: 'The sponsoring organization',
    help: 'Shown as the session’s sponsor.',
    validation: {},
    flags: { public: true, speakerEditable: false, evaluatorVisible: true },
    cond: null,
  };
  return [
    headerField(
      'h_session',
      'Your session',
      'This lands on the agenda as your sponsor session — no evaluation round, the program team follows up on scheduling.'
    ),
    company,
    ...core.filter((f) => f.role !== 'speakers'),
    headerField('h_speakers', 'Speakers', 'Who’s on stage. Add co-speakers if you’re presenting together.'),
    ...core.filter((f) => f.role === 'speakers'),
  ];
}

export function presetFields(preset: FormPreset, coSpeakerCap: number, formatTaxonomyId?: string | null): FormField[] {
  if (preset === 'contact') return contactFields();
  if (preset === 'session') return sessionIntakeFields(coSpeakerCap, formatTaxonomyId);
  return cfpFields(coSpeakerCap, formatTaxonomyId);
}

export function presetSettings(preset: FormPreset): FormSettings {
  const s = defaultSettings();
  if (preset === 'contact') {
    s.allowDrafts = false;
    s.pageHeading = 'Get in touch';
    s.postSubmitMsg = 'Thanks — we’ve got your message and will reply by email.';
  } else if (preset === 'session') {
    s.submitsAs = 'session';
    s.pageHeading = 'Submit your sponsor session';
    s.postSubmitMsg = 'Thanks — your session is in the program. The team will follow up with scheduling details.';
  }
  return s;
}

export function randomSecret(): string {
  return newId('late').split('_')[1].slice(0, 6);
}

/* ------------------------------------------------------------------ open/close */

/** Today's calendar date in the event timezone (`closes_at` is a calendar day). */
export function todayIn(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date()).slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export type OpenState = {
  open: boolean;
  /** true when a `?key=` late link is bypassing a closed window */
  late: boolean;
  reason: 'open' | 'draft' | 'closed' | 'not_yet' | 'ended';
  message: string;
};

export function openState(
  form: FormRow,
  settings: FormSettings,
  timezone: string,
  key?: string | null
): OpenState {
  const today = todayIn(timezone);
  const lateOk = !!(key && settings.lateLinkSecret && key === settings.lateLinkSecret);

  let reason: OpenState['reason'] = 'open';
  if (form.status === 'draft') reason = 'draft';
  else if (form.status === 'closed') reason = 'closed';
  else if (form.opens_at && today < form.opens_at.slice(0, 10)) reason = 'not_yet';
  else if (form.closes_at && today > form.closes_at.slice(0, 10)) reason = 'ended';

  const messages: Record<OpenState['reason'], string> = {
    open: '',
    draft: 'This form isn’t published yet.',
    closed: 'This call is closed.',
    not_yet: 'This call hasn’t opened yet.',
    ended: 'This call has closed.',
  };

  if (reason === 'open') return { open: true, late: false, reason, message: '' };
  // A late link reopens a closed window, never an unpublished draft.
  if (lateOk && reason !== 'draft') return { open: true, late: true, reason, message: '' };
  return { open: false, late: false, reason, message: messages[reason] };
}

/* ------------------------------------------------------------------ misc */

export function wordCount(s: string): number {
  const t = (s || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const [, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!m || !d) return String(iso);
  return `${MONTHS[m - 1]} ${d}`;
}

/** Public URL of a form: `unsession.dev/{event}/{form}`. */
export function shareUrl(origin: string, eventSlug: string, formSlug: string): string {
  return `${origin.replace(/\/$/, '')}/${eventSlug}/${formSlug}`;
}

/**
 * Inline links for consent copy: `[code of conduct](https://…)` and bare URLs
 * become anchors, everything else is escaped. Used by CoC-style CHK fields.
 */
export function inlineLinks(text: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // `u` is pulled out of the already-escaped string — re-escaping it here would
  // turn a `?a=1&b=2` query into `&amp;amp;` and break the link.
  const safeUrl = (u: string) => (/^https?:\/\//i.test(u) || u.startsWith('/') ? u : '#');
  let out = esc(text || '');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    return `<a href="${safeUrl(url)}" target="_blank" rel="noreferrer" style="color:var(--primary);">${label}</a>`;
  });
  out = out.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, (_m, pre: string, url: string) => {
    return `${pre}<a href="${safeUrl(url)}" target="_blank" rel="noreferrer" style="color:var(--primary);">${url}</a>`;
  });
  return out;
}

/** Minimal Markdown → HTML (headings, bold, bullet lists) — the prototype's renderMd. */
export function renderMarkdown(src: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (s: string) =>
    esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const out: string[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (list) {
      out.push(`<ul style="margin:8px 0;padding-left:22px;">${list.join('')}</ul>`);
      list = null;
    }
  };
  (src || '').split('\n').forEach((ln) => {
    const t = ln.trim();
    if (t.startsWith('- ')) {
      if (!list) list = [];
      list.push(`<li style="margin-bottom:3px;">${inline(t.slice(2))}</li>`);
      return;
    }
    flush();
    if (!t) return;
    if (t.startsWith('## ')) out.push(`<div style="font-size:17px;font-weight:700;margin:14px 0 6px;">${inline(t.slice(3))}</div>`);
    else if (t.startsWith('# ')) out.push(`<div style="font-size:19px;font-weight:700;margin:14px 0 6px;">${inline(t.slice(2))}</div>`);
    else out.push(`<p style="margin:8px 0;">${inline(t)}</p>`);
  });
  flush();
  return out.join('');
}
