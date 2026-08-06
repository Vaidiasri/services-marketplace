/**
 * The slot generator, against fixtures, with no database and no HTTP.
 *
 * `now` is an input, so the past-slot filter is tested with an injected clock rather than
 * by waiting. Every DST case uses America/New_York, because Asia/Kolkata has no DST and
 * would hide the bug.
 *
 * Run: npm run test:slots --workspace=server
 */
import {
  DEFAULT_OPEN_WINDOW_CAPACITY,
  generateSlots,
  type Exception,
  type GenerateInput,
  type Rule,
} from '../src/availability/slot-generator';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, extra?: unknown): void => {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${extra === undefined ? '' : `  <- ${extra}`}`);
  }
};

const IST = 'Asia/Kolkata';
const NY = 'America/New_York';

/** 2026-08-10 is a Monday, so weekday 1. Far in the past for `now`, so nothing is filtered. */
const LONG_AGO = new Date('2020-01-01T00:00:00Z');

function run(over: Partial<GenerateInput>): ReturnType<typeof generateSlots> {
  return generateSlots({
    timezone: IST,
    granularityMinutes: 15,
    durationMinutes: 30,
    rules: [],
    exceptions: [],
    from: '2026-08-10',
    to: '2026-08-10',
    now: LONG_AGO,
    consumption: new Map(),
    ...over,
  });
}

const rule = (over: Partial<Rule> = {}): Rule => ({
  weekday: 1,
  startMinute: 9 * 60,
  endMinute: 13 * 60,
  capacity: 1,
  ...over,
});

/** Local wall-clock label for a slot, for readable assertions. */
const at = (s: { startUtc: string }, zone = IST): string =>
  new Date(s.startUtc).toLocaleTimeString('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
  });

// ---------------------------------------------------------------- the basic grid

// 09:00-13:00 is 240 minutes. A 30-minute offering on a 15-minute grid starts every 15
// minutes while start+30 still fits: 09:00 .. 12:30 = 15 starts.
let slots = run({ rules: [rule()] });
ok(slots.length === 15, 'a 4-hour window, 30-minute offering, 15-minute grid -> 15 slots', slots.length);
ok(at(slots[0]) === '09:00', 'the first starts at the window open', at(slots[0]));
ok(at(slots[14]) === '12:30', 'the last starts 30 minutes before close', at(slots[14]));
ok(
  slots[0].endUtc === new Date(new Date(slots[0].startUtc).getTime() + 30 * 60_000).toISOString(),
  'endUtc is startUtc plus the offering duration',
);

// The brief's DONE WHEN: changing an offering 30 -> 60 changes the generated slots.
const at60 = run({ rules: [rule()], durationMinutes: 60 });
ok(at60.length === 13, 'the same window with a 60-minute offering -> 13 slots', at60.length);
ok(at(at60[12]) === '12:00', 'and the last one starts at 12:00', at(at60[12]));
// The plan claimed this "halves". It does not, and asserting that it does would fail
// against correct code: starts step by GRANULARITY, not by duration, so the count drops by
// the number of extra cells the longer offering needs (240/15 - 2 + 1 = 15 vs 13).
ok(at60.length !== Math.floor(slots.length / 2), 'the count changes but does NOT halve - starts step by granularity', `${slots.length} -> ${at60.length}`);

// A 90-minute offering leaves a tail: 12:00+90 = 13:30 overruns a 13:00 close, so it is
// dropped and the vendor sees fewer slots than the naive division suggests.
const at90 = run({ rules: [rule()], durationMinutes: 90 });
ok(at90.length === 11, 'a 90-minute offering fits 11 starts, the last at 11:30', at90.length);
ok(at(at90[10]) === '11:30', 'and 11:45 would overrun the close, so it is absent', at(at90[10]));

// Unaligned duration is refused outright rather than producing a wrong grid. M4 prevents
// this at offering write time; this is the generator refusing to guess.
ok(run({ rules: [rule()], durationMinutes: 50 }).length === 0, 'a duration not divisible by the granularity yields nothing');

// ---------------------------------------------------------------- two windows in a day

slots = run({
  rules: [rule({ endMinute: 13 * 60 }), rule({ startMinute: 16 * 60, endMinute: 20 * 60 })],
});
ok(slots.length === 30, 'two 4-hour windows -> 15 + 15 slots', slots.length);
ok(
  !slots.some((s) => at(s) >= '13:00' && at(s) < '16:00'),
  'and nothing is generated in the gap between them',
  slots.map((s) => at(s)).join(' '),
);

// A rule for another weekday contributes nothing to this date.
ok(run({ rules: [rule({ weekday: 2 })] }).length === 0, 'a Tuesday rule produces no Monday slots');

// ---------------------------------------------------------------- overlapping windows

// The defect in the plan. Merging these two windows into 09:00-14:00 leaves no defined
// capacity at 12:30, because the merge discards which rule each minute came from.
const overlapping = run({
  rules: [
    rule({ startMinute: 9 * 60, endMinute: 13 * 60, capacity: 1 }),
    rule({ startMinute: 12 * 60, endMinute: 14 * 60, capacity: 3 }),
  ],
  durationMinutes: 30,
});
ok(at(overlapping[0]) === '09:00', 'overlapping windows start at the earlier open', at(overlapping[0]));
ok(at(overlapping[overlapping.length - 1]) === '13:30', 'and run to the later close', at(overlapping[overlapping.length - 1]));
ok(
  new Set(overlapping.map((s) => at(s))).size === overlapping.length,
  'no slot is generated twice where the windows overlap',
);
ok(
  overlapping.find((s) => at(s) === '09:00')?.capacity === 1,
  'a cell covered only by the capacity-1 rule holds 1',
  overlapping.find((s) => at(s) === '09:00')?.capacity,
);
ok(
  overlapping.find((s) => at(s) === '13:00')?.capacity === 3,
  'a cell covered only by the capacity-3 rule holds 3',
  overlapping.find((s) => at(s) === '13:00')?.capacity,
);
// The bottleneck rule: a 30-minute slot at 12:45 spans 12:45 and 13:00. The first is
// covered by both rules (max 3), the second only by the roomier one (3) - so 3. But a slot
// at 12:30 spans 12:30 and 12:45, both covered by both rules, also 3. The tightest case is
// a slot straddling the boundary INTO the overlap.
ok(
  overlapping.find((s) => at(s) === '11:45')?.capacity === 1,
  'a slot entirely before the overlap is still limited to 1',
  overlapping.find((s) => at(s) === '11:45')?.capacity,
);

// Windows that do not sit on the grid are snapped to it, anchored at local midnight -
// never to the window start, or two windows would produce cells that overlap in time but
// not in key, and SlotCell's uniqueness guarantee would be void.
const offGrid = run({ rules: [rule({ startMinute: 9 * 60 + 7, endMinute: 13 * 60 })] });
ok(at(offGrid[0]) === '09:15', 'a window opening at 09:07 yields its first slot at 09:15, not 09:07', at(offGrid[0]));

// ---------------------------------------------------------------- exceptions

const closure: Exception = { date: '2026-08-10', type: 'CLOSURE', startMinute: null, endMinute: null, capacity: null };
ok(run({ rules: [rule()], exceptions: [closure] }).length === 0, 'a CLOSURE empties the date');

// Closures win over an OPEN_WINDOW on the same date.
ok(
  run({
    rules: [rule()],
    exceptions: [closure, { date: '2026-08-10', type: 'OPEN_WINDOW', startMinute: 600, endMinute: 720, capacity: 2 }],
  }).length === 0,
  'and beats an OPEN_WINDOW on the same date',
);

// A closure on another date leaves this one alone - the DONE WHEN pair, at unit level.
ok(
  run({ rules: [rule()], exceptions: [{ ...closure, date: '2026-08-11' }] }).length === 15,
  'a closure on a different date changes nothing',
);

// Sunday has no rule, so only the exception opens it. 2026-08-09 is a Sunday.
const opened = run({
  from: '2026-08-09',
  to: '2026-08-09',
  rules: [rule()],
  exceptions: [{ date: '2026-08-09', type: 'OPEN_WINDOW', startMinute: 10 * 60, endMinute: 12 * 60, capacity: null }],
});
ok(opened.length === 7, 'an OPEN_WINDOW opens a day with no rule behind it', opened.length);
ok(
  opened[0].capacity === DEFAULT_OPEN_WINDOW_CAPACITY,
  'and its capacity defaults to 1, which the plan left undefined',
  opened[0].capacity,
);

// ---------------------------------------------------------------- consumption

// Capacity 2, one booking against the 09:00 cell. A 30-minute slot spans 09:00 and 09:15,
// so BOTH the 09:00 slot and the 08:45-ish neighbours that include that cell are affected.
const consumed = new Map([
  ['2026-08-10T03:30:00.000Z', { capacity: 2, bookedCount: 1 }], // 09:00 IST
]);
slots = run({ rules: [rule({ capacity: 2 })], consumption: consumed });
ok(
  slots.find((s) => at(s) === '09:00')?.remainingCapacity === 1,
  'capacity 2 with one booking reports remainingCapacity 1',
  slots.find((s) => at(s) === '09:00')?.remainingCapacity,
);
ok(
  slots.find((s) => at(s) === '09:15')?.remainingCapacity === 2,
  'a slot not touching that cell is unaffected',
  slots.find((s) => at(s) === '09:15')?.remainingCapacity,
);

// Full cell: the slot disappears rather than being offered at zero.
const full = new Map([['2026-08-10T03:30:00.000Z', { capacity: 2, bookedCount: 2 }]]);
slots = run({ rules: [rule({ capacity: 2 })], consumption: full });
ok(!slots.some((s) => at(s) === '09:00'), 'a full cell removes the slot entirely, not offered at zero');
ok(slots.length === 14, 'and only that one slot is removed', slots.length);

// THE overlap case the grid exists for. A 60-minute booking at 09:00 fills cells 09:00,
// 09:15, 09:30 and 09:45. A 30-minute offering must then find 09:30 unavailable, even
// though nothing was ever "booked at 09:30".
const sixtyBooked = new Map(
  ['03:30', '03:45', '04:00', '04:15'].map((t) => [
    `2026-08-10T${t}:00.000Z`,
    { capacity: 1, bookedCount: 1 },
  ]),
);
slots = run({ rules: [rule({ capacity: 1 })], durationMinutes: 30, consumption: sixtyBooked });
ok(
  !slots.some((s) => ['09:00', '09:15', '09:30', '09:45'].includes(at(s))),
  'a 60-minute booking blocks a 30-minute start mid-way through it - the double-booking the grid prevents',
  slots.map((s) => at(s)).slice(0, 4).join(' '),
);
ok(at(slots[0]) === '10:00', 'the next bookable 30-minute start is 10:00', at(slots[0]));

// A cell row keeps the capacity it was created with, so lowering a rule's capacity later
// cannot put an existing cell over its own limit.
const snapshot = new Map([['2026-08-10T03:30:00.000Z', { capacity: 3, bookedCount: 2 }]]);
slots = run({ rules: [rule({ capacity: 1 })], consumption: snapshot });
ok(
  slots.find((s) => at(s) === '09:00')?.remainingCapacity === 1,
  'an existing cell honours its snapshotted capacity, not the lowered rule',
  slots.find((s) => at(s) === '09:00')?.remainingCapacity,
);

// ---------------------------------------------------------------- the past

// now = 11:00 IST on the generated date. Slots at 11:00 and earlier are gone.
slots = run({ rules: [rule()], now: new Date('2026-08-10T05:30:00.000Z') });
ok(at(slots[0]) === '11:15', 'slots at or before now are dropped, against the server clock', at(slots[0]));
ok(slots.length === 6, 'leaving 11:15, 11:30, 11:45, 12:00, 12:15, 12:30', slots.length);
ok(run({ rules: [rule()], now: new Date('2030-01-01T00:00:00Z') }).length === 0, 'a date entirely in the past yields nothing');

// ---------------------------------------------------------------- DST

// 2026-03-08, New York: 02:00 jumps to 03:00. A vendor open 01:00-05:00 loses the 02:00
// hour - those local times never happen - but keeps everything either side.
const springForward = generateSlots({
  timezone: NY,
  granularityMinutes: 15,
  durationMinutes: 30,
  rules: [{ weekday: 0, startMinute: 60, endMinute: 5 * 60, capacity: 1 }], // Sunday 01:00-05:00
  exceptions: [],
  from: '2026-03-08',
  to: '2026-03-08',
  now: LONG_AGO,
  consumption: new Map(),
});
const nyLabels = springForward.map((s) => at(s, NY));
ok(springForward.length > 0, 'the spring-forward date still generates slots', springForward.length);
ok(
  !nyLabels.some((l) => l.startsWith('02:')),
  'and none of them is in the 02:00 hour, which does not exist that day',
  nyLabels.join(' '),
);
ok(nyLabels.includes('01:00'), '01:00 before the gap is present', nyLabels.join(' '));
ok(nyLabels.includes('03:00'), '03:00 after the gap is present', nyLabels.join(' '));
// A local day one hour shorter yields correspondingly fewer slots than the same rule on a
// normal Sunday. Proof the gap is genuinely skipped rather than silently shifted.
const normalSunday = generateSlots({
  timezone: NY,
  granularityMinutes: 15,
  durationMinutes: 30,
  rules: [{ weekday: 0, startMinute: 60, endMinute: 5 * 60, capacity: 1 }],
  exceptions: [],
  from: '2026-03-15',
  to: '2026-03-15',
  now: LONG_AGO,
  consumption: new Map(),
});
// FIVE fewer, not four. The four starts inside 02:00-02:45 are gone, and so is 01:45 -
// a 30-minute booking there would need the 02:00 cell, which does not exist. A slot dying
// because it reaches INTO the gap is the case an implementation that only checked the start
// minute would get wrong, and it is why every cell is converted individually rather than
// deriving the end from the start.
ok(
  springForward.length === normalSunday.length - 5,
  'the gap costs five starts: the four inside it, plus the 01:45 that would reach into it',
  `${springForward.length} vs ${normalSunday.length}`,
);
ok(
  !nyLabels.includes('01:45'),
  'and 01:45 is specifically absent, though 01:45 itself exists that day',
  nyLabels.join(' '),
);

// 2026-11-01, New York: 01:00-02:00 happens twice. The earlier offset is chosen
// deterministically, so each local time maps to exactly one instant and no slot is
// duplicated.
const fallBack = generateSlots({
  timezone: NY,
  granularityMinutes: 15,
  durationMinutes: 30,
  rules: [{ weekday: 0, startMinute: 0, endMinute: 4 * 60, capacity: 1 }],
  exceptions: [],
  from: '2026-11-01',
  to: '2026-11-01',
  now: LONG_AGO,
  consumption: new Map(),
});
ok(
  new Set(fallBack.map((s) => s.startUtc)).size === fallBack.length,
  'the repeated hour produces no duplicate instants',
);
ok(
  new Set(fallBack.map((s) => at(s, NY))).size === fallBack.length,
  'and no duplicate local labels either - the earlier offset wins',
  fallBack.map((s) => at(s, NY)).join(' '),
);

// ---------------------------------------------------------------- ranges

slots = run({ rules: [rule()], from: '2026-08-10', to: '2026-08-17' });
// Mondays in that inclusive range: the 10th and the 17th.
ok(slots.length === 30, 'a week-long range picks up both Mondays', slots.length);
ok(
  slots.every((s, i) => i === 0 || s.startUtc >= slots[i - 1].startUtc),
  'and the result is sorted by startUtc',
);
ok(run({ rules: [rule()], from: '2026-08-17', to: '2026-08-10' }).length === 0, 'a reversed range yields nothing');
ok(run({ rules: [] }).length === 0, 'no rules yields nothing');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
