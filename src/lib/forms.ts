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
  audience: string;
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
    audience: typeof s.audience === 'string' ? s.audience : 'Public link',
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
    audience: 'Public link',
  };
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
  const safeUrl = (u: string) => (/^https?:\/\//i.test(u) || u.startsWith('/') ? esc(u) : '#');
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
