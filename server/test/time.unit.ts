/**
 * The timezone layer, tested with no database and no HTTP.
 *
 * Every DST case uses America/New_York. Asia/Kolkata - the timezone this project's seed
 * data actually uses - has no DST at all, so a test suite written only against it would
 * pass with completely broken conversion code. That is the whole reason this file exists.
 *
 * Run: npm run test:time --workspace=server
 */
import {
  eachLocalDate,
  inclusiveDayCount,
  isValidZone,
  localMinutesToUtc,
  localWeekday,
  utcToLocalDate,
  utcToLocalMinutes,
} from '../src/common/time';

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

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

const NY = 'America/New_York';
const IST = 'Asia/Kolkata';

// ---------------------------------------------------------------- zones

ok(isValidZone(IST) && isValidZone(NY), 'known IANA zones validate');
ok(isValidZone('UTC'), 'UTC validates despite having no region');
ok(!isValidZone('Mars/Olympus_Mons'), 'a made-up zone does not');

// Both of these are ACCEPTED by a bare Intl.DateTimeFormat check, which is what this
// project used before M5. ICU resolves EST to America/Panama - fixed UTC-5, no daylight
// saving - so a vendor typing "EST" would have every slot an hour wrong for eight months
// of the year with nothing in the data looking wrong. IST is claimed by three countries.
ok(!isValidZone('IST'), 'the abbreviation IST is refused, though Intl accepts it');
ok(!isValidZone('EST'), 'and so is EST, which ICU maps to a zone with no DST at all');
ok(
  new Intl.DateTimeFormat('en', { timeZone: 'EST' }).resolvedOptions().timeZone ===
    'America/Panama',
  'proof of the above: EST really does resolve to America/Panama here',
  new Intl.DateTimeFormat('en', { timeZone: 'EST' }).resolvedOptions().timeZone,
);

// ---------------------------------------------------------------- basic conversion

// IST is UTC+5:30 all year. 09:00 local = 03:30Z.
ok(
  iso(localMinutesToUtc('2026-08-10', 9 * 60, IST)) === '2026-08-10T03:30:00.000Z',
  'IST 09:00 -> 03:30Z',
  iso(localMinutesToUtc('2026-08-10', 9 * 60, IST)),
);

// A half-hour offset zone is worth asserting explicitly: it is where "offset in whole
// hours" bugs surface.
ok(
  iso(localMinutesToUtc('2026-08-10', 0, IST)) === '2026-08-09T18:30:00.000Z',
  'IST local midnight is the PREVIOUS UTC day',
  iso(localMinutesToUtc('2026-08-10', 0, IST)),
);

// New York in August is EDT, UTC-4. In January it is EST, UTC-5. Same wall clock, two
// different instants - the thing offset arithmetic gets wrong.
ok(
  iso(localMinutesToUtc('2026-08-10', 9 * 60, NY)) === '2026-08-10T13:00:00.000Z',
  'NY 09:00 in summer -> 13:00Z (EDT, UTC-4)',
  iso(localMinutesToUtc('2026-08-10', 9 * 60, NY)),
);
ok(
  iso(localMinutesToUtc('2026-01-12', 9 * 60, NY)) === '2026-01-12T14:00:00.000Z',
  'NY 09:00 in winter -> 14:00Z (EST, UTC-5)',
  iso(localMinutesToUtc('2026-01-12', 9 * 60, NY)),
);

// ---------------------------------------------------------------- DST: spring forward
// 2026-03-08 in New York: 02:00 jumps to 03:00. Local 02:00-02:59 never happens.

ok(
  localMinutesToUtc('2026-03-08', 2 * 60, NY) === null,
  'a local time inside the spring-forward gap returns null, not a neighbouring instant',
  iso(localMinutesToUtc('2026-03-08', 2 * 60, NY)),
);
ok(
  localMinutesToUtc('2026-03-08', 2 * 60 + 30, NY) === null,
  '02:30 on that date is also null',
  iso(localMinutesToUtc('2026-03-08', 2 * 60 + 30, NY)),
);
ok(
  iso(localMinutesToUtc('2026-03-08', 60, NY)) === '2026-03-08T06:00:00.000Z',
  '01:00, the hour before the gap, still resolves (EST)',
  iso(localMinutesToUtc('2026-03-08', 60, NY)),
);
ok(
  iso(localMinutesToUtc('2026-03-08', 3 * 60, NY)) === '2026-03-08T07:00:00.000Z',
  '03:00, the hour after the gap, resolves as EDT',
  iso(localMinutesToUtc('2026-03-08', 3 * 60, NY)),
);
// The gap is one hour wide, so a 09:00 slot is 4 hours after 03:00 rather than 5.
ok(
  iso(localMinutesToUtc('2026-03-08', 9 * 60, NY)) === '2026-03-08T13:00:00.000Z',
  '09:00 on the spring-forward date is already EDT',
  iso(localMinutesToUtc('2026-03-08', 9 * 60, NY)),
);

// ---------------------------------------------------------------- DST: fall back
// 2026-11-01 in New York: 02:00 returns to 01:00. Local 01:00-01:59 happens twice.

ok(
  iso(localMinutesToUtc('2026-11-01', 60 + 30, NY)) === '2026-11-01T05:30:00.000Z',
  'an ambiguous local time takes the EARLIER offset, deterministically',
  iso(localMinutesToUtc('2026-11-01', 60 + 30, NY)),
);
ok(
  iso(localMinutesToUtc('2026-11-01', 3 * 60, NY)) === '2026-11-01T08:00:00.000Z',
  '03:00 after the repeated hour is EST',
  iso(localMinutesToUtc('2026-11-01', 3 * 60, NY)),
);

// ---------------------------------------------------------------- minutes past midnight

// A 23:00 start with a 120-minute offering ends at minute 1500, which is 01:00 the NEXT
// local day. The generator relies on this rather than special-casing midnight.
ok(
  iso(localMinutesToUtc('2026-08-10', 25 * 60, IST)) === '2026-08-10T19:30:00.000Z',
  'minute 1500 rolls into the next local day',
  iso(localMinutesToUtc('2026-08-10', 25 * 60, IST)),
);
ok(
  iso(localMinutesToUtc('2026-08-10', 24 * 60, IST)) ===
    iso(localMinutesToUtc('2026-08-11', 0, IST)),
  'minute 1440 is exactly the next local midnight',
);

// ---------------------------------------------------------------- reverse conversion

ok(
  utcToLocalDate(new Date('2026-08-09T20:00:00.000Z'), IST) === '2026-08-10',
  '20:00Z is already the 10th in IST - a UTC date is not a local date',
  utcToLocalDate(new Date('2026-08-09T20:00:00.000Z'), IST),
);
ok(
  utcToLocalDate(new Date('2026-08-10T02:00:00.000Z'), NY) === '2026-08-09',
  'and 02:00Z is still the 9th in New York',
  utcToLocalDate(new Date('2026-08-10T02:00:00.000Z'), NY),
);
ok(
  utcToLocalMinutes(new Date('2026-08-10T03:30:00.000Z'), IST) === 9 * 60,
  'utcToLocalMinutes is the inverse of localMinutesToUtc',
  utcToLocalMinutes(new Date('2026-08-10T03:30:00.000Z'), IST),
);

// ---------------------------------------------------------------- date enumeration

ok(
  eachLocalDate('2026-08-10', '2026-08-12', IST).join(',') ===
    '2026-08-10,2026-08-11,2026-08-12',
  'eachLocalDate is inclusive of both ends',
);
ok(eachLocalDate('2026-08-10', '2026-08-10', IST).length === 1, 'a single-day range yields one date');
ok(eachLocalDate('2026-08-12', '2026-08-10', IST).length === 0, 'a reversed range yields nothing');

// Across the spring-forward date a local day is 23 hours long. Stepping by 24 hours here
// would drift and eventually skip a date; stepping by calendar date does not.
const acrossGap = eachLocalDate('2026-03-07', '2026-03-09', NY);
ok(
  acrossGap.join(',') === '2026-03-07,2026-03-08,2026-03-09',
  'a 23-hour local day is still exactly one date',
  acrossGap.join(','),
);
const acrossFallBack = eachLocalDate('2026-10-31', '2026-11-02', NY);
ok(
  acrossFallBack.join(',') === '2026-10-31,2026-11-01,2026-11-02',
  'and so is a 25-hour one',
  acrossFallBack.join(','),
);

// A full year across both transitions: 2026 is not a leap year, so 365 distinct dates.
ok(
  eachLocalDate('2026-01-01', '2026-12-31', NY).length === 365,
  'a full year across both transitions enumerates 365 dates, not 364 or 366',
  eachLocalDate('2026-01-01', '2026-12-31', NY).length,
);

ok(inclusiveDayCount('2026-08-10', '2026-08-10', IST) === 1, 'inclusiveDayCount of one day is 1');
ok(inclusiveDayCount('2026-08-01', '2026-10-01', IST) === 62, 'a 62-day range counts as 62');
ok(
  inclusiveDayCount('2026-03-07', '2026-03-09', NY) === 3,
  'and the DST date does not cost a day',
  inclusiveDayCount('2026-03-07', '2026-03-09', NY),
);

// ---------------------------------------------------------------- weekday mapping

// The schema documents weekday 0 = Sunday; luxon uses 7 = Sunday. Getting this wrong
// shifts every rule by a day, which is the kind of bug that looks like bad seed data.
ok(localWeekday('2026-08-09', IST) === 0, '2026-08-09 is a Sunday -> 0', localWeekday('2026-08-09', IST));
ok(localWeekday('2026-08-10', IST) === 1, 'Monday -> 1', localWeekday('2026-08-10', IST));
ok(localWeekday('2026-08-15', IST) === 6, 'Saturday -> 6', localWeekday('2026-08-15', IST));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
