/**
 * Deterministic bin-fill auto-scheduler for `/app/agenda`.
 *
 * Fills the unscheduled bin (`day IS NULL`) into slots that are conflict-free
 * under `conflictMessages()` — the same predicate that drives the builder's live
 * warnings — so anything this places is clean by construction. Sessions already
 * on the grid are never moved: this only ever adds.
 *
 * The search is a greedy first-fit. Longest sessions go first (a 90-minute
 * workshop is the hardest thing to fit, so it gets first pick), then the
 * earliest day, then the earliest start, then rooms ordered by track affinity so
 * a track tends to settle into one room instead of scattering.
 *
 * No model involved — the constraint space is a few hundred candidate slots per
 * session, small enough to brute-force, and a deterministic packer is
 * reproducible and testable in a way a prompt is not.
 *
 * OWNER: B4.
 */
import { conflictItem, conflictMessages, roomNamer, SNAP, speakerNamer } from './agenda';
import type { AgendaBundle, ConflictItem, RoomRow, SessionRow } from './agenda';

export type AutoPlacement = {
  id: string;
  title: string;
  day: number;
  start: number;
  end: number;
  roomId: string;
  roomName: string;
};

export type AutoSkip = { id: string; title: string; reason: string };

export type AutoScheduleResult = { placements: AutoPlacement[]; skipped: AutoSkip[] };

export type AutoScheduleOpts = { days: number; dayStart: number; dayEnd: number };

const isUnscheduled = (s: SessionRow) => s.day === null || s.start_min === null;

/**
 * Venue-wide bands (breaks, lunch, plenaries) carry meaning a packer can't see —
 * lunch belongs at noon, not in the first free gap — so they stay hand-placed.
 */
const isManualOnly = (s: SessionRow) => s.type === 'service' || s.all_rooms === 1;

/** Bin contents, hardest to place first. Title breaks ties so runs are stable. */
function candidates(bundle: AgendaBundle): SessionRow[] {
  return bundle.sessions
    .filter(isUnscheduled)
    .slice()
    .sort((a, b) => b.duration_min - a.duration_min || a.title.localeCompare(b.title));
}

/**
 * Rooms to try, best first: those already hosting this session's track, then the
 * event's configured room order. The sort is stable, so `priority, name` from
 * `loadAgenda` survives as the tie-break.
 */
function roomsByAffinity(bundle: AgendaBundle, session: SessionRow, placed: SessionRow[]): RoomRow[] {
  if (!session.track_option_id) return bundle.rooms;
  const affinity = new Map<string, number>();
  for (const p of placed) {
    if (!p.room_id || p.track_option_id !== session.track_option_id) continue;
    affinity.set(p.room_id, (affinity.get(p.room_id) ?? 0) + 1);
  }
  if (!affinity.size) return bundle.rooms;
  return bundle.rooms.slice().sort((a, b) => (affinity.get(b.id) ?? 0) - (affinity.get(a.id) ?? 0));
}

export function autoSchedule(bundle: AgendaBundle, opts: AutoScheduleOpts): AutoScheduleResult {
  const placements: AutoPlacement[] = [];
  const skipped: AutoSkip[] = [];
  const roomName = roomNamer(bundle);
  const speakerName = speakerNamer(bundle);

  // Running conflict state: what's already on the grid, plus each session we
  // place, so every candidate is checked against the placements before it.
  const onGrid = bundle.sessions.filter((s) => !isUnscheduled(s));
  const placedItems: ConflictItem[] = onGrid.map((s) => conflictItem(s, bundle));
  const placedRows: SessionRow[] = onGrid.slice();

  for (const s of candidates(bundle)) {
    if (isManualOnly(s)) {
      skipped.push({ id: s.id, title: s.title, reason: 'Venue-wide block — place it by hand.' });
      continue;
    }
    if (!bundle.rooms.length) {
      skipped.push({ id: s.id, title: s.title, reason: 'No rooms configured yet.' });
      continue;
    }

    const dur = Math.max(SNAP, s.duration_min);
    const base = conflictItem(s, bundle);
    const rooms = roomsByAffinity(bundle, s, placedRows);
    let hit: AutoPlacement | null = null;

    // Day-major, then time, then room: this fills a time slot across every room
    // before moving later into the day, so the result is a parallel program
    // rather than one room packed from open to close.
    for (let day = 0; day < opts.days && !hit; day++) {
      for (let start = opts.dayStart; start + dur <= opts.dayEnd && !hit; start += SNAP) {
        for (const room of rooms) {
          const cand: ConflictItem = { ...base, day, start, end: start + dur, roomId: room.id, allRooms: false };
          // Reusing the message builder rather than a cheaper boolean keeps one
          // definition of "conflict" across the builder, the API and this packer.
          if (conflictMessages(cand, placedItems, { dayEnd: opts.dayEnd, roomName, speakerName }).length) continue;
          hit = { id: s.id, title: s.title, day, start, end: start + dur, roomId: room.id, roomName: room.name };
          break;
        }
      }
    }

    if (!hit) {
      skipped.push({ id: s.id, title: s.title, reason: 'No conflict-free slot left in the program.' });
      continue;
    }
    placements.push(hit);
    placedItems.push({ ...base, day: hit.day, start: hit.start, end: hit.end, roomId: hit.roomId, allRooms: false });
    placedRows.push({ ...s, day: hit.day, start_min: hit.start, end_min: hit.end, room_id: hit.roomId });
  }

  return { placements, skipped };
}
