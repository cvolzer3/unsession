/**
 * Conditional visibility + submission validation (track B1).
 *
 * The server is the authority: the public form recomputes visibility here at
 * submit time, strips answers that belong to hidden fields, and only then
 * validates. Conditions may only reference fields *earlier* in the schema, so a
 * single top-down pass is enough (a hidden source hides everything downstream
 * of it too).
 *
 * B3 (evaluation) and B5 (speaker portal / task mini-forms) import from here.
 */
import type { FieldCond, FormField } from './forms';
import { coreRoles, wordCount } from './forms';
import { LINK_FIELDS, normalizeLink, type SpeakerLinks } from './speaker-links';

export type CondOp =
  | 'is'
  | 'is not'
  | 'contains'
  | 'does not contain'
  | 'is answered'
  | 'is blank'
  | 'gt'
  | 'lt';

export type AnswerValue = string | string[] | number | boolean | null | undefined;
export type Answers = Record<string, AnswerValue>;

export type SpeakerInput = {
  name: string;
  email: string;
  bio?: string;
  jobTitle?: string;
  company?: string;
  /** Legacy free-text "CTO at Acme" line — superseded by jobTitle + company. */
  tagline?: string;
  /** SPEAKER_ROLES key; '' or missing falls back to the position default. */
  role?: string;
  links?: SpeakerLinks;
  headshotFileId?: string | null;
};

/* ------------------------------------------------------------------ helpers */

export function asList(v: AnswerValue): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((x) => x !== '');
  if (typeof v === 'boolean') return v ? ['true'] : [];
  const s = String(v);
  return s === '' ? [] : [s];
}

export function isAnswered(v: AnswerValue): boolean {
  return asList(v).length > 0;
}

function numeric(v: AnswerValue): number | null {
  const list = asList(v);
  if (!list.length) return null;
  const n = Number(list[0]);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ conditions */

export function evalCond(cond: FieldCond | null | undefined, answers: Answers): boolean {
  if (!cond) return true;
  const a = answers[cond.src];
  const list = asList(a);
  const val = String(cond.val ?? '');
  const lower = val.toLowerCase();

  switch (cond.op) {
    case 'is answered':
      return isAnswered(a);
    case 'is blank':
      return !isAnswered(a);
    case 'is':
      return list.includes(val);
    case 'is not':
      // Prototype semantics: an unanswered source keeps the field hidden.
      return isAnswered(a) && !list.includes(val);
    case 'contains':
      return list.some((s) => s === val || s.toLowerCase().includes(lower));
    case 'does not contain':
      return isAnswered(a) && !list.some((s) => s === val || s.toLowerCase().includes(lower));
    case 'gt': {
      const n = numeric(a);
      const t = Number(val);
      return n !== null && Number.isFinite(t) && n > t;
    }
    case 'lt': {
      const n = numeric(a);
      const t = Number(val);
      return n !== null && Number.isFinite(t) && n < t;
    }
    default:
      return true;
  }
}

/** Ids of every field that should render for these answers (top-down cascade). */
export function visibleIds(fields: FormField[], answers: Answers): Set<string> {
  const visible = new Set<string>();
  for (const f of fields) {
    if (!f.cond) {
      visible.add(f.id);
      continue;
    }
    const srcExists = fields.some((x) => x.id === f.cond!.src);
    // An archived source leaves the field visible (matches the prototype).
    const srcVisible = !srcExists || visible.has(f.cond.src);
    if (srcVisible && evalCond(f.cond, answers)) visible.add(f.id);
  }
  return visible;
}

export function visibleFields(fields: FormField[], answers: Answers): FormField[] {
  const ids = visibleIds(fields, answers);
  return fields.filter((f) => ids.has(f.id));
}

/** Values of hidden fields stay in the draft, and are dropped at submit. */
export function stripHidden(fields: FormField[], answers: Answers): Answers {
  const ids = visibleIds(fields, answers);
  const out: Answers = {};
  for (const f of fields) {
    if (!ids.has(f.id)) continue;
    if (f.type === 'HDR' || f.type === 'GRP') continue;
    if (answers[f.id] !== undefined) out[f.id] = answers[f.id];
  }
  return out;
}

export function requiredWhenVisible(f: FormField): boolean {
  return !!f.required || !!(f.cond && f.cond.alsoReq);
}

/* ------------------------------------------------------------------ validation */

export type ValidationResult = {
  /** field id (or `sp<i>.name` / `sp<i>.email` / `speakers`) → human sentence */
  errors: Record<string, string>;
  /** error summary lines, in field order */
  list: string[];
  /** ids of the fields that were actually rendered */
  visible: string[];
  /** answers with hidden fields removed */
  cleaned: Answers;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s.]+\.[^\s]{2,}$/i;
const TEL_RE = /^[+()\-\s.\d]{6,24}$/;

export function normalizeUrl(v: string): string {
  const s = (v || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

export function validateSubmission(
  fields: FormField[],
  answers: Answers,
  speakers: SpeakerInput[],
  opts: { hard: boolean; speakerCap?: number }
): ValidationResult {
  const hard = !!opts.hard;
  const ids = visibleIds(fields, answers);
  const errors: Record<string, string> = {};
  const list: string[] = [];
  const fail = (key: string, message: string, summary: string) => {
    if (errors[key]) return;
    errors[key] = message;
    list.push(summary);
  };

  for (const f of fields) {
    if (!ids.has(f.id) || f.type === 'HDR') continue;
    const v = answers[f.id];
    const answered = isAnswered(v);
    const req = requiredWhenVisible(f);
    const V = f.validation || {};

    if (f.type === 'GRP') continue; // speakers are validated below

    if (f.type === 'CHK') {
      const checked = asList(v).includes('true') || v === true || v === 'on' || v === '1';
      if (hard && (req || V.mustCheck) && !checked) {
        fail(f.id, 'Must be checked to submit.', `${f.label} — must be checked`);
      }
      continue;
    }

    if (!answered) {
      if (hard && req) fail(f.id, `${f.label} is required.`, `${f.label} — required`);
      continue;
    }

    const first = asList(v)[0] ?? '';

    switch (f.type) {
      case 'TXT': {
        if (V.minChars && first.trim().length < V.minChars) {
          fail(f.id, `Use at least ${V.minChars} characters.`, `${f.label} — at least ${V.minChars} characters`);
        }
        if (V.maxChars && first.trim().length > V.maxChars) {
          fail(
            f.id,
            `Over the ${V.maxChars}-character limit by ${first.trim().length - V.maxChars}.`,
            `${f.label} — over the ${V.maxChars}-character limit`
          );
        }
        break;
      }
      case 'LONG': {
        const words = wordCount(first);
        if (V.maxWords && words > V.maxWords) {
          fail(
            f.id,
            `Over the ${V.maxWords}-word limit by ${words - V.maxWords}.`,
            `${f.label} — over the ${V.maxWords}-word limit`
          );
        }
        break;
      }
      case 'EML': {
        if (!EMAIL_RE.test(first.trim())) fail(f.id, 'Enter a valid email address.', `${f.label} — not a valid email`);
        break;
      }
      case 'URL': {
        if (!URL_RE.test(normalizeUrl(first))) fail(f.id, 'Enter a valid URL.', `${f.label} — not a valid URL`);
        break;
      }
      case 'TEL': {
        if (!TEL_RE.test(first.trim())) fail(f.id, 'Enter a valid phone number.', `${f.label} — not a valid phone number`);
        break;
      }
      case 'NUM': {
        const n = Number(first);
        if (!Number.isFinite(n)) {
          fail(f.id, 'Enter a number.', `${f.label} — not a number`);
          break;
        }
        if (V.numKind === 'integer' && !Number.isInteger(n)) {
          fail(f.id, 'Enter a whole number.', `${f.label} — must be a whole number`);
          break;
        }
        if (V.min !== undefined && n < V.min) fail(f.id, `Must be ${V.min} or more.`, `${f.label} — must be ${V.min} or more`);
        if (V.max !== undefined && n > V.max) fail(f.id, `Must be ${V.max} or less.`, `${f.label} — must be ${V.max} or less`);
        break;
      }
      case 'DATE': {
        if (V.dateFrom && first < V.dateFrom) {
          fail(f.id, `Choose a date on or after ${V.dateFrom}.`, `${f.label} — too early`);
        }
        if (V.dateTo && first > V.dateTo) {
          fail(f.id, `Choose a date on or before ${V.dateTo}.`, `${f.label} — too late`);
        }
        break;
      }
      case 'SEL': {
        if (f.opts && f.opts.length && !f.opts.includes(first)) {
          fail(f.id, 'Pick one of the listed options.', `${f.label} — pick a listed option`);
        }
        break;
      }
      case 'MULTI': {
        const chosen = asList(v);
        if (V.min !== undefined && chosen.length < V.min) {
          fail(f.id, `Choose at least ${V.min}.`, `${f.label} — choose at least ${V.min}`);
        }
        if (V.max !== undefined && chosen.length > V.max) {
          fail(f.id, `Choose at most ${V.max}.`, `${f.label} — choose at most ${V.max}`);
        }
        break;
      }
      case 'FILE': {
        const files = asList(v);
        if (V.fileMaxCount && files.length > V.fileMaxCount) {
          fail(f.id, `Attach at most ${V.fileMaxCount} file(s).`, `${f.label} — too many files`);
        }
        break;
      }
      default:
        break;
    }
  }

  /* ------------------------------------------------------------ speakers */
  const grp = coreRoles(fields).speakers;
  if (grp && ids.has(grp.id)) {
    const cap = opts.speakerCap ?? grp.validation.maxSpeakers ?? 3;
    const rows = speakers ?? [];
    if (hard && !rows.length) {
      fail('speakers', 'Add at least one speaker.', 'Speakers — add at least one speaker');
    }
    if (rows.length > cap) {
      fail('speakers', `At most ${cap} speaker${cap === 1 ? '' : 's'} per submission.`, `Speakers — at most ${cap} allowed`);
    }
    rows.forEach((s, i) => {
      const nameOk = !!(s.name || '').trim();
      const emailOk = EMAIL_RE.test((s.email || '').trim());
      if (hard && (!nameOk || !emailOk)) {
        if (!nameOk) errors[`sp${i}.name`] = 'Name is required.';
        if (!emailOk) errors[`sp${i}.email`] = 'A valid email is required.';
        list.push(`Speaker ${i + 1} — name and a valid email required`);
      }
      for (const [key, label] of LINK_FIELDS) {
        const raw = (s.links?.[key] ?? '').trim();
        if (raw && !normalizeLink(raw)) {
          fail(
            `sp${i}.link_${key}`,
            `The ${label} link needs to be a web address (https://…).`,
            `Speaker ${i + 1} — ${label} link is not a web address`
          );
        }
      }
    });
  }

  return { errors, list, visible: [...ids], cleaned: stripHidden(fields, answers) };
}
