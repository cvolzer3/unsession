/**
 * Speaker roles on a submission (submission_speakers.role) — what each person
 * on a proposal actually is, not just their position in the list.
 *
 * Stored as the key, never the label. An empty value means the speaker never
 * picked one, in which case the label comes from the card's position: the first
 * card is the Speaker, every later card is a Co-speaker. That fallback is what
 * lets rows written before this column existed still render a role.
 */

export const SPEAKER_ROLES = [
  ['speaker', 'Speaker'],
  ['co_speaker', 'Co-speaker'],
  ['co_author', 'Co-author'],
  ['moderator', 'Moderator'],
  ['panelist', 'Panelist'],
] as const;

export type SpeakerRole = (typeof SPEAKER_ROLES)[number][0];

const LABELS = new Map<string, string>(SPEAKER_ROLES.map(([key, label]) => [key, label]));

/** The role a card carries when nobody picked one: card 1 speaks, the rest co-speak. */
export function defaultRole(position: number): SpeakerRole {
  return position === 0 ? 'speaker' : 'co_speaker';
}

/** Keep only known role keys; anything else (including '') stores as unset. */
export function normalizeRole(raw: unknown): string {
  const key = typeof raw === 'string' ? raw.trim() : '';
  return LABELS.has(key) ? key : '';
}

/** Display label for a stored role, falling back to the position default. */
export function roleLabel(role: string | null | undefined, position: number): string {
  return LABELS.get(normalizeRole(role) || defaultRole(position))!;
}
