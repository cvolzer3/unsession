/**
 * Speaker social links — one shape shared by the CFP form's speaker cards
 * (submission_speakers.links_json) and the portal profile
 * (speaker_profiles.links_json). Only the keys the speaker filled in are
 * stored, as normalized http(s) URLs.
 */

export type SpeakerLinks = { linkedin?: string; x?: string; website?: string; other?: string };

export const LINK_FIELDS = [
  ['linkedin', 'LinkedIn'],
  ['x', 'X'],
  ['website', 'Website'],
  ['other', 'Other'],
] as const;

export type LinkKey = (typeof LINK_FIELDS)[number][0];

/** Normalize a profile link: prepend https:// on bare domains, allow only http(s). Null = invalid. */
export function normalizeLink(raw: string): string | null {
  let value = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Keep only known keys with non-empty string values, trimmed but NOT normalized (drafts store what was typed). */
export function sanitizeLinks(input: unknown): SpeakerLinks {
  const out: SpeakerLinks = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key] of LINK_FIELDS) {
    const raw = (input as Record<string, unknown>)[key];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

/** Normalize every link for storage, dropping any that don't parse (validation reports them first). */
export function normalizeLinks(links: SpeakerLinks | undefined): SpeakerLinks {
  const out: SpeakerLinks = {};
  for (const [key] of LINK_FIELDS) {
    const raw = links?.[key];
    if (!raw) continue;
    const url = normalizeLink(raw);
    if (url) out[key] = url;
  }
  return out;
}

/** JSON for the links_json columns — null when nothing was filled in. */
export function linksJson(links: SpeakerLinks | undefined): string | null {
  const clean = links ? { ...links } : {};
  for (const [key] of LINK_FIELDS) if (!clean[key]) delete clean[key];
  return Object.keys(clean).length ? JSON.stringify(clean) : null;
}
