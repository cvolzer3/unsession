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
 * a track tends to settle into one room.
 *
 * BANDS. Auto-schedule uses a deliberately stricter obstacle set than manual
 * drag. `conflictMessages()` ignores venue-wide blocks entirely (see the
 * `allRooms` early-outs in `agenda.ts`) because an organizer dragging a card can
 * see the grid and decide for themselves; nobody is looking when this runs, so
 * registration, coffee and breaks are solid here. Lunch is the one soft band: a
 * second pass will schedule across it, but only for sessions that had nowhere
 * else to go, and the caller is told which so the organizer can see it happened.
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
  /** Soft band this had to be placed across, or null in the common case. */
  over: string | null;
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

/**
 * The one band programs routinely schedule across: lunch-and-learns and
 * birds-of-a-feather are normal, a talk opposite registration is not.
 */
const SOFT_BAND = /\blunch\b/i;

type Band = {
  title: string;
  day: number;
  start: number;
  end: number;
  roomId: string | null;
  allRooms: boolean;
  soft: boolean;
};

/** Placed service blocks and venue-wide bands — the obstacles talks must dodge. */
function bandsOf(bundle: AgendaBundle): Band[] {
  return bundle.sessions
    .filter((s) => !isUnscheduled(s) && isManualOnly(s))
    .map((s) => ({
      title: s.title,
      day: s.day as number,
      start: s.start_min as number,
      end: s.end_min ?? (s.start_min as number) + s.duration_min,
      roomId: s.room_id,
      allRooms: s.all_rooms === 1,
      soft: SOFT_BAND.test(s.title),
    }));
}

/** Bands a candidate slot would run across, in grid order. */
function bandsHit(bands: Band[], day: number, start: number, end: number, roomId: string): Band[] {
  return bands.filter(
    (b) => b.day === day && start < b.end && b.start < end && (b.allRooms || b.roomId === roomId)
  );
}

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

type SlotCtx = {
  base: ConflictItem;
  rooms: RoomRow[];
  placedItems: ConflictItem[];
  bands: Band[];
  opts: AutoScheduleOpts;
  roomName: (id: string | null) => string;
  speakerName: (id: string) => string;
};

/**
 * First conflict-free slot for `dur` minutes, or null.
 *
 * Day-major, then time, then room: this fills a time slot across every room
 * before moving later into the day, so the result is a parallel program rather
 * than one room packed from open to close.
 *
 * `allowSoft` opens lunch up — pass 2 only.
 */
function findSlot(s: SessionRow, dur: number, ctx: SlotCtx, allowSoft: boolean): AutoPlacement | null {
  const { opts } = ctx;
  for (let day = 0; day < opts.days; day++) {
    for (let start = opts.dayStart; start + dur <= opts.dayEnd; start += SNAP) {
      const end = start + dur;
      for (const room of ctx.rooms) {
        const hits = bandsHit(ctx.bands, day, start, end, room.id);
        if (hits.some((b) => !b.soft)) continue;
        if (hits.length && !allowSoft) continue;
        const cand: ConflictItem = { ...ctx.base, day, start, end, roomId: room.id, allRooms: false };
        // Reusing the message builder rather than a cheaper boolean keeps one
        // definition of "conflict" across the builder, the API and this packer.
        if (conflictMessages(cand, ctx.placedItems, { dayEnd: opts.dayEnd, roomName: ctx.roomName, speakerName: ctx.speakerName }).length) {
          continue;
        }
        return {
          id: s.id,
          title: s.title,
          day,
          start,
          end,
          roomId: room.id,
          roomName: room.name,
          over: hits.length ? hits[0].title : null,
        };
      }
    }
  }
  return null;
}

export function autoSchedule(bundle: AgendaBundle, opts: AutoScheduleOpts): AutoScheduleResult {
  const placements: AutoPlacement[] = [];
  const skipped: AutoSkip[] = [];
  const roomName = roomNamer(bundle);
  const speakerName = speakerNamer(bundle);
  const bands = bandsOf(bundle);

  // Running conflict state: what's already on the grid, plus each session we
  // place, so every candidate is checked against the placements before it.
  const onGrid = bundle.sessions.filter((s) => !isUnscheduled(s));
  const placedItems: ConflictItem[] = onGrid.map((s) => conflictItem(s, bundle));
  const placedRows: SessionRow[] = onGrid.slice();

  const accept = (s: SessionRow, hit: AutoPlacement) => {
    placements.push(hit);
    placedItems.push({ ...conflictItem(s, bundle), day: hit.day, start: hit.start, end: hit.end, roomId: hit.roomId, allRooms: false });
    placedRows.push({ ...s, day: hit.day, start_min: hit.start, end_min: hit.end, room_id: hit.roomId });
  };

  const ctxFor = (s: SessionRow): SlotCtx => ({
    base: conflictItem(s, bundle),
    rooms: roomsByAffinity(bundle, s, placedRows),
    placedItems,
    bands,
    opts,
    roomName,
    speakerName,
  });

  // Pass 1 — every band is solid, including lunch.
  const leftover: SessionRow[] = [];
  for (const s of candidates(bundle)) {
    if (isManualOnly(s)) {
      skipped.push({ id: s.id, title: s.title, reason: 'Venue-wide block — place it by hand.' });
      continue;
    }
    if (!bundle.rooms.length) {
      skipped.push({ id: s.id, title: s.title, reason: 'No rooms configured yet.' });
      continue;
    }
    const hit = findSlot(s, Math.max(SNAP, s.duration_min), ctxFor(s), false);
    if (hit) accept(s, hit);
    else leftover.push(s);
  }

  // Pass 2 — only for sessions with nowhere else to go, lunch opens up. Anything
  // placed here is reported so the organizer sees the trade rather than
  // discovering a talk opposite lunch on the published agenda.
  for (const s of leftover) {
    const hit = findSlot(s, Math.max(SNAP, s.duration_min), ctxFor(s), true);
    if (hit) accept(s, hit);
    else skipped.push({ id: s.id, title: s.title, reason: 'No free slot left outside registration and breaks.' });
  }

  return { placements, skipped };
}
