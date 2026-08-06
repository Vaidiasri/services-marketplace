import { DateTime } from 'luxon';

/**
 * The ONLY file that imports a timezone library.
 *
 * Everything downstream works in UTC instants. A local wall-clock time exists in exactly
 * two places: an AvailabilityRule's minutes-from-midnight, and this file. Hand-rolled
 * offset arithmetic is the classic way to get this wrong - it is correct for ten months
 * of the year and silently shifts a vendor's opening hours on the two DST dates.
 */

/** Minutes in a day. A rule's endMinute may equal this (midnight, exclusive). */
export const MINUTES_IN_DAY = 24 * 60;

/**
 * A real IANA zone identifier, not merely something Intl will accept.
 *
 * Intl is far more permissive than it looks, and the permissiveness is dangerous here.
 * Node's ICU resolves the abbreviation `EST` to `America/Panama` - a FIXED UTC-5 zone that
 * never observes daylight saving. A vendor who typed "EST" would have every generated slot
 * an hour wrong for the eight months of the year that New York is on EDT, silently, with
 * nothing in the data looking wrong. `IST` is worse: it is claimed by India, Ireland and
 * Israel, and ICU picks one.
 *
 * So an identifier must be `Region/City`. That is the actual shape of the IANA database,
 * and it is what excludes every ambiguous abbreviation in one condition. `UTC` is allowed
 * explicitly because it is a legitimate zone with no region.
 *
 * Aliases with a slash are accepted deliberately: `Asia/Kolkata` and `US/Eastern` both
 * resolve to correct, DST-observing zones. Rejecting them would mean rejecting the
 * canonical name half the world writes - note that this ICU build canonicalises
 * `Asia/Kolkata` to `Asia/Calcutta`, so a whitelist of Intl.supportedValuesOf would refuse
 * the very zone this project seeds.
 */
export function isIanaTimezone(value: string): boolean {
  if (value !== 'UTC' && !value.includes('/')) return false;
  return DateTime.local().setZone(value).isValid;
}

/** Alias kept for the slot generator's readability. */
export const isValidZone = isIanaTimezone;

/**
 * A local date (`YYYY-MM-DD`) plus minutes-from-local-midnight, resolved to a UTC instant
 * in `zone`.
 *
 * Returns null when that local time DOES NOT EXIST - the spring-forward gap, where 02:30
 * is simply not a time that happened. Luxon does not throw for this; it silently shifts
 * forward past the gap, which would put a 02:30 slot at 03:30 and quietly invent an
 * opening hour the vendor never declared. So the result is round-tripped back to local and
 * compared: if the wall clock changed, the input did not exist.
 *
 * The plan called for throwing here. Null instead, because a vendor legitimately open at
 * 02:00 on one Sunday a year is data, not an exception - and a throw would force the
 * generator to wrap every candidate in try/catch inside its hot loop.
 *
 * For an AMBIGUOUS local time - the fall-back hour, which happens twice - luxon returns
 * the earlier offset, which is deterministic and is what the plan specifies.
 */
export function localMinutesToUtc(
  localDate: string,
  minutes: number,
  zone: string,
): Date | null {
  // Minutes can exceed a day: a 23:00 start plus a 120-minute offering ends at 25:00,
  // which is 01:00 the next local day. Normalising here keeps that arithmetic in one place.
  const dayOffset = Math.floor(minutes / MINUTES_IN_DAY);
  const minuteOfDay = minutes - dayOffset * MINUTES_IN_DAY;

  const dt = DateTime.fromISO(localDate, { zone })
    .startOf('day')
    .plus({ days: dayOffset })
    .set({ hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 });

  if (!dt.isValid) return null;

  // The round-trip. If luxon moved the wall clock, the requested local time is inside a
  // DST gap and no instant corresponds to it.
  if (dt.hour !== Math.floor(minuteOfDay / 60) || dt.minute !== minuteOfDay % 60) {
    return null;
  }

  return dt.toJSDate();
}

/** The local calendar date, `YYYY-MM-DD`, that a UTC instant falls on in `zone`. */
export function utcToLocalDate(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone: 'utc' }).setZone(zone).toISODate() ?? '';
}

/** Local minutes-from-midnight for a UTC instant in `zone`. Used for the past-slot label. */
export function utcToLocalMinutes(instant: Date, zone: string): number {
  const dt = DateTime.fromJSDate(instant, { zone: 'utc' }).setZone(zone);
  return dt.hour * 60 + dt.minute;
}

/**
 * Every local calendar date from `from` to `to` inclusive, as `YYYY-MM-DD`.
 *
 * Iterating by calendar date rather than by adding 24 hours is the point: on a DST date a
 * local day is 23 or 25 hours long, so 24-hour steps drift and eventually skip or repeat a
 * date.
 */
export function eachLocalDate(from: string, to: string, zone: string): string[] {
  let cursor = DateTime.fromISO(from, { zone }).startOf('day');
  const end = DateTime.fromISO(to, { zone }).startOf('day');
  if (!cursor.isValid || !end.isValid || cursor > end) return [];

  const dates: string[] = [];
  while (cursor <= end) {
    const iso = cursor.toISODate();
    if (iso) dates.push(iso);
    cursor = cursor.plus({ days: 1 });
  }
  return dates;
}

/** Days between two local dates, inclusive of both, for the range cap. */
export function inclusiveDayCount(from: string, to: string, zone: string): number {
  const a = DateTime.fromISO(from, { zone }).startOf('day');
  const b = DateTime.fromISO(to, { zone }).startOf('day');
  if (!a.isValid || !b.isValid) return 0;
  return Math.floor(b.diff(a, 'days').days) + 1;
}

/** ISO weekday as the schema stores it: 0 = Sunday, matching `AvailabilityRule.weekday`. */
export function localWeekday(localDate: string, zone: string): number {
  const dt = DateTime.fromISO(localDate, { zone });
  // Luxon uses 1 = Monday .. 7 = Sunday. The schema documents 0 = Sunday, so Sunday maps
  // from 7 to 0 and every other day is unchanged.
  return dt.weekday === 7 ? 0 : dt.weekday;
}

/** Today's local date in `zone`, for the past-date checks. Server clock only. */
export function todayLocalDate(zone: string, now: Date = new Date()): string {
  return utcToLocalDate(now, zone);
}
