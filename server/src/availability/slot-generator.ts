import { eachLocalDate, localMinutesToUtc, localWeekday } from '../common/time';

/**
 * Slot generation, as a pure function over its inputs.
 *
 * No Prisma import, no injectable, no clock of its own - `now` is a parameter. That is
 * what makes the DST and capacity cases testable without a database, and what lets M6 call
 * it with rows it already holds inside an open transaction.
 */

export type Rule = {
  weekday: number;
  startMinute: number;
  endMinute: number;
  capacity: number;
};

export type Exception = {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  type: 'CLOSURE' | 'OPEN_WINDOW';
  startMinute: number | null;
  endMinute: number | null;
  capacity: number | null;
};

/** One `SlotCell` row: a consumption counter for a single grid cell. */
export type CellConsumption = { capacity: number; bookedCount: number };

export type GenerateInput = {
  timezone: string;
  granularityMinutes: number;
  durationMinutes: number;
  rules: Rule[];
  exceptions: Exception[];
  /** Local dates, inclusive. */
  from: string;
  to: string;
  now: Date;
  /** Keyed by the cell's `startUtc` as an ISO string. Missing means untouched. */
  consumption: Map<string, CellConsumption>;
};

export type Slot = {
  startUtc: string;
  endUtc: string;
  capacity: number;
  remainingCapacity: number;
};

/**
 * One grid cell a booking would occupy, with the capacity that cell is entitled to.
 *
 * M6 needs this and cannot use `Slot.capacity`, which is the MINIMUM across the cells - the
 * right number to advertise, but writing it to every cell would understate the capacity of
 * the roomier ones and wrongly constrain other bookings. So the plan is exposed per cell.
 */
export type PlannedCell = { startUtc: Date; capacity: number };

/**
 * An OPEN_WINDOW exception opens a day that has no rule behind it, so there is no rule
 * capacity to inherit. One is the conservative default: a vendor who wants more says so.
 * The plan left this undefined.
 */
export const DEFAULT_OPEN_WINDOW_CAPACITY = 1;

export function generateSlots(input: GenerateInput): Slot[] {
  return enumerate(input).map((e) => e.slot);
}

/**
 * The cells a booking at `startUtc` would occupy, or null if that instant is not a real
 * derived slot start with room in it.
 *
 * This is how M6 validates a requested start AND gets its cell plan in one step, from the
 * same code path that produced the slot list the customer was shown. A separate
 * "is this a valid start" check would be a second implementation of the grid, and the two
 * would drift - at which point a client could book a time that was never offered.
 */
export function planBookingCells(
  input: GenerateInput,
  startUtc: Date,
): PlannedCell[] | null {
  const iso = startUtc.toISOString();
  return enumerate(input).find((e) => e.slot.startUtc === iso)?.cells ?? null;
}

function enumerate(input: GenerateInput): { slot: Slot; cells: PlannedCell[] }[] {
  const {
    timezone,
    granularityMinutes: g,
    durationMinutes,
    rules,
    exceptions,
    from,
    to,
    now,
    consumption,
  } = input;

  if (g <= 0 || durationMinutes <= 0 || durationMinutes % g !== 0) return [];

  const cellsNeeded = durationMinutes / g;
  const closures = new Set(
    exceptions.filter((e) => e.type === 'CLOSURE').map((e) => e.date),
  );
  const rulesByWeekday = new Map<number, Rule[]>();
  for (const rule of rules) {
    const list = rulesByWeekday.get(rule.weekday) ?? [];
    list.push(rule);
    rulesByWeekday.set(rule.weekday, list);
  }

  const found: { slot: Slot; cells: PlannedCell[] }[] = [];

  for (const date of eachLocalDate(from, to, timezone)) {
    // Closures win over everything, including an OPEN_WINDOW on the same date. A vendor
    // who closes a date and also has a one-off window on it meant to be closed.
    if (closures.has(date)) continue;

    const windows = [
      ...(rulesByWeekday.get(localWeekday(date, timezone)) ?? []),
      ...exceptions
        .filter((e) => e.type === 'OPEN_WINDOW' && e.date === date)
        .map((e) => ({
          startMinute: e.startMinute ?? 0,
          endMinute: e.endMinute ?? 0,
          capacity: e.capacity ?? DEFAULT_OPEN_WINDOW_CAPACITY,
        })),
    ];
    if (windows.length === 0) continue;

    const cellCapacity = layGrid(windows, g);

    for (const [startMinute] of [...cellCapacity].sort((a, b) => a[0] - b[0])) {
      const built = buildSlot({
        date,
        startMinute,
        cellsNeeded,
        g,
        durationMinutes,
        timezone,
        cellCapacity,
        consumption,
        now,
      });
      if (built) found.push(built);
    }
  }

  return found.sort((a, b) => a.slot.startUtc.localeCompare(b.slot.startUtc));
}

/**
 * The grid: a map of cell-start-minute to the capacity available in that cell.
 *
 * This replaces the plan's "merge overlapping windows" step, which left capacity
 * undefined. Merging Tue 09:00-13:00 capacity 1 with Tue 12:00-14:00 capacity 3 gives one
 * 09:00-14:00 window and no answer for what 12:30 can hold. Per-cell capacity answers it -
 * `max`, because a vendor who declares a second, roomier window over the same hours is
 * widening what they can take, not narrowing it - and contiguity then falls out of
 * adjacent cells existing, so merging is no longer a step at all.
 *
 * Cells are anchored to LOCAL MIDNIGHT, not to the start of each window. Two windows
 * beginning at 09:00 and 09:07 must contribute to the same grid, because `SlotCell` is
 * unique on (serviceId, startUtc) and is shared by every offering on the service. Anchoring
 * per window would produce cells that overlap in time but not in key, and the capacity
 * guarantee M6 relies on would be silently void.
 */
function layGrid(
  windows: { startMinute: number; endMinute: number; capacity: number }[],
  g: number,
): Map<number, number> {
  const cells = new Map<number, number>();

  for (const w of windows) {
    if (w.endMinute <= w.startMinute) continue;
    // Round the first cell UP to the grid so it is anchored at local midnight.
    const first = Math.ceil(w.startMinute / g) * g;
    for (let m = first; m + g <= w.endMinute; m += g) {
      cells.set(m, Math.max(cells.get(m) ?? 0, w.capacity));
    }
  }

  return cells;
}

function buildSlot(args: {
  date: string;
  startMinute: number;
  cellsNeeded: number;
  g: number;
  durationMinutes: number;
  timezone: string;
  cellCapacity: Map<number, number>;
  consumption: Map<string, CellConsumption>;
  now: Date;
}): { slot: Slot; cells: PlannedCell[] } | null {
  const {
    date,
    startMinute,
    cellsNeeded,
    g,
    durationMinutes,
    timezone,
    cellCapacity,
    consumption,
    now,
  } = args;

  let capacity = Number.POSITIVE_INFINITY;
  let remaining = Number.POSITIVE_INFINITY;
  let startUtc: Date | null = null;
  const cells: PlannedCell[] = [];

  for (let i = 0; i < cellsNeeded; i++) {
    const minute = startMinute + i * g;
    // Every cell the booking would occupy has to be open. A 60-minute offering cannot
    // start at 12:30 in a window that closes at 13:00, because the 13:00 cell is not
    // in the grid - the plan's "fits entirely inside the window", expressed as cells.
    const declared = cellCapacity.get(minute);
    if (declared === undefined) return null;

    const cellUtc = localMinutesToUtc(date, minute, timezone);
    // Inside a spring-forward gap this local minute does not exist, so neither does the
    // slot. Skipped rather than shifted, which would invent an opening hour.
    if (!cellUtc) return null;
    if (i === 0) startUtc = cellUtc;

    // An existing row carries the capacity snapshotted when it was created; lowering a
    // rule's capacity afterwards must not retroactively put a booked cell over its limit.
    const row = consumption.get(cellUtc.toISOString());
    const cellCap = row?.capacity ?? declared;
    const cellFree = cellCap - (row?.bookedCount ?? 0);

    // The bottleneck cell decides the slot. A booking spanning four cells can only happen
    // as many times as its tightest cell allows.
    capacity = Math.min(capacity, cellCap);
    remaining = Math.min(remaining, cellFree);

    // The per-cell entitlement, NOT the slot minimum. M6 writes this when it creates the
    // row, so a roomier cell keeps its own capacity for other bookings.
    cells.push({ startUtc: cellUtc, capacity: declared });
  }

  if (!startUtc) return null;
  // The past check, against the server clock only. There is no client-supplied "now".
  if (startUtc.getTime() <= now.getTime()) return null;
  if (remaining <= 0) return null;

  // durationMinutes is a physical duration - a 60-minute appointment occupies 60 real
  // minutes - so the end is the start plus that span. Local wall-clock arithmetic here
  // would be wrong across a fall-back hour, where local 01:00-02:00 spans two real hours.
  return {
    slot: {
      startUtc: startUtc.toISOString(),
      endUtc: new Date(startUtc.getTime() + durationMinutes * 60_000).toISOString(),
      capacity,
      remainingCapacity: remaining,
    },
    cells,
  };
}
