# M5 - Availability & Slots (Plan)

Brief module 05. Booking integrity rubric area (20 marks) jointly with
[M6](../M6_BOOKING_LIFECYCLE/plan.md) - "slot maths is correct" is graded here.

## Key decisions

- **Slots are derived on every read. There is no slot table.** Rules minus exceptions
  minus consumption, computed per request. The brief rejects stored slot rows outright.
- **Rules are stored as local weekday + minutes-from-midnight, not as timestamps.**
  `weekday: 2, startMinute: 540, endMinute: 780` is "Tuesday 09:00-13:00" in the
  vendor's zone, forever, across DST transitions. Storing rules as UTC instants would
  silently shift a vendor's opening hours twice a year.
- **The vendor's IANA timezone is the single authority.** It lives on `VendorProfile`
  and is inherited by every service. Conversion local -> UTC happens once, in slot
  generation. Nothing downstream ever sees a local time again.
- **A per-service slot grid, granularity `slotGranularityMinutes` (default 15).**
  Offering durations must be a multiple of it (enforced in [M4](../M4_CATALOGUE/plan.md)).
  A booking occupies N consecutive grid cells. **This is the decision that makes
  capacity correct with variable durations** - see the section below.
- **`SlotCell` is a consumption counter, not a slot.** It is created lazily on first
  booking, holds `bookedCount` against `capacity`, and exists so M6 can take a real row
  lock. Deleting every row in it changes no slot's existence.
- **Capacity comes from the rule, snapshotted onto the cell at creation.** Later edits to
  a rule's capacity do not retroactively change already-created cells - otherwise
  lowering capacity could put an existing cell over its own limit.
- **Slot queries are always per-offering.** `GET /services/:id/slots` requires
  `offeringId`, because duration is an input to the arithmetic.
- **Range capped at 62 days.** A vendor with 12-hour days at 15-minute granularity
  produces ~48 cells a day; an uncapped range is a trivial resource exhaustion.

## Why the grid, and not one row per bookable start

The naive model is one counter per (service, offering, startTime). It breaks the moment
two offerings on the same service have different durations:

> Capacity 1. A 60-minute colour is booked at 09:00. A customer asks for 30-minute
> haircuts. The naive model has no counter at 09:30, so 09:30 looks free - but the
> vendor is mid-colour until 10:00. Double-booked.

The grid fixes it. Both offerings consume cells on the *same* 15-minute grid: the
colour takes cells 09:00, 09:15, 09:30, 09:45; the haircut at 09:30 would need cells
09:30 and 09:45, which are already full. Overlap is caught because overlapping bookings
touch shared rows.

Alternatives considered and rejected:

- **Postgres exclusion constraint** with `btree_gist` over a `tstzrange`. Elegant for
  capacity 1, but capacity N needs a counter anyway, and it puts the core logic in a
  place that is harder to demonstrate in a walkthrough.
- **Application-level overlap query** (`WHERE start < :end AND end > :start`). This is
  read-then-write, which the brief names as "the failure we are testing for."

## API contract

| Method | Endpoint | Requires | Notes |
| --- | --- | --- | --- |
| GET | `/services/:id/availability/rules` | public if service public | Grouped by weekday |
| PUT | `/services/:id/availability/rules` | `availability.manage` + own + approved | Full replacement: `{ rules: [{ weekday, startMinute, endMinute, capacity }] }` |
| GET | `/services/:id/availability/exceptions` | public if service public | `?from=&to=` |
| POST | `/services/:id/availability/exceptions` | `availability.manage` + own + approved | `{ date, type, startMinute?, endMinute?, capacity?, reason? }` |
| DELETE | `/services/:id/availability/exceptions/:exId` | `availability.manage` + own + approved | Normal hours resume |
| GET | `/services/:id/slots` | public if service public | `?offeringId=&from=&to=`. Returns derived slots with `remainingCapacity` |
| GET | `/services/:id/slots/next-available` | public if service public | `?offeringId=`. Soonest bookable slot, or `null` |

Slot response shape:

```ts
type Slot = { startUtc: string; endUtc: string; remainingCapacity: number; capacity: number }
type SlotsResponse = { timezone: string; offeringId: string; durationMinutes: number; slots: Slot[] }
```

`timezone` is in the envelope so the client can label times with the vendor's zone
without a second request.

## Impact map

- `server/prisma/schema.prisma` - `AvailabilityRule`, `AvailabilityException`,
  `ExceptionType` enum, `SlotCell` with `@@unique([serviceId, startUtc])` - add
- `server/src/availability/availability.module.ts` - add
- `server/src/availability/rules.controller.ts` / `exceptions.controller.ts` - add
- `server/src/availability/availability.service.ts` - `replaceRules`, `addException`,
  `removeException` - add
- `server/src/availability/slot-generator.service.ts` - `generate(service, offering, from, to)`,
  `nextAvailable(service, offering)` - add - **pure function over inputs**, no database
  access of its own, so it is unit-testable without a database and so M6 can call it
  with data it already has in its transaction
- `server/src/availability/slot-generator.types.ts` - `GridCell`, `LocalWindow` - add
- `server/src/availability/slots.controller.ts` - the two read routes - add
- `server/src/common/time.ts` - `localMinutesToUtc(date, minutes, tz)`,
  `utcToLocalDate(instant, tz)`, `eachLocalDate(from, to, tz)` - add - the only file that
  imports the timezone library
- `client/src/routes/vendor/Availability.tsx` - weekly grid editor + exception calendar - add
- `client/src/components/SlotPicker.tsx` - add - used by the booking flow in M6

## Dependencies (new)

| Package | Why | Risk |
| --- | --- | --- |
| `@js-joda/core` + `@js-joda/timezone`, or `luxon` | Correct IANA conversion including DST | Pick one and use it only inside `common/time.ts`. `luxon` is smaller to learn; `@js-joda` has stricter types. Either is fine - what is not fine is hand-rolled offset arithmetic, which is wrong across DST |

## Algorithm - slot generation

Inputs: rules, exceptions, existing `SlotCell` counts, offering duration, service
granularity, vendor timezone, `from`/`to`, server `now`.

1. **Enumerate local dates** from `from` to `to` in the vendor's timezone. Cap at 62.
2. **Per date, resolve open windows.** If a `CLOSURE` exception exists for that local
   date, the day yields nothing - closures win over everything. Otherwise take the
   `AvailabilityRule` rows for that weekday, then add any `OPEN_WINDOW` exceptions for
   that date. Merge overlapping windows so two rules covering 09:00-13:00 and 12:00-14:00
   produce one 09:00-14:00 window rather than duplicate slots.
3. **Lay the grid.** Within each window, candidate starts step by
   `slotGranularityMinutes`. A candidate survives only if `start + durationMinutes` fits
   entirely inside that window - a 60-minute offering cannot start at 12:30 in a window
   closing at 13:00.
4. **Convert to UTC** with `localMinutesToUtc`, then drop any slot whose `startUtc <= now`.
   This is the past-slot check, done on the server against the server clock.
5. **Subtract consumption.** For each surviving slot, look up the `SlotCell` rows covering
   its cells; `remainingCapacity` is the minimum of `(capacity - bookedCount)` across all
   cells the booking would occupy. A missing cell row means untouched, so full capacity.
   Slots with `remainingCapacity <= 0` are dropped.

`nextAvailable` runs the same generator over a rolling window - 7 days, then 30, then
62 - returning the first slot found, and `null` past 62 days rather than scanning forever.

### DST, concretely

On a spring-forward date, 02:00-03:00 local does not exist. `localMinutesToUtc` for a
non-existent local time throws rather than silently picking a neighbour, and the
generator skips that candidate. On a fall-back date, 01:30 local occurs twice; the
earlier offset is chosen deterministically. Both are covered by unit tests with a
`America/New_York` fixture, because `Asia/Kolkata` has no DST and would hide the bug.

## Error handling

| Operation | Failure | Behaviour |
| --- | --- | --- |
| `PUT rules` | `endMinute <= startMinute` | 422 `INVALID_WINDOW` |
| `PUT rules` | Minute outside 0-1440 | 422 |
| `PUT rules` | `capacity < 1` | 422 |
| `PUT rules` | Two windows on the same weekday overlap | 200 - merged in step 2, not an error. Documented so it is a decision, not an oversight |
| `PUT rules` | Empty array while the service is `PUBLISHED` | 409 `WOULD_ORPHAN_PUBLISHED_SERVICE`. Unpublish first |
| `POST exception` | `OPEN_WINDOW` without start/end minutes | 422 |
| `POST exception` | Duplicate `CLOSURE` for the same date | 200, idempotent |
| `POST exception` | Date in the past | 422 `DATE_IN_PAST` - a closure for last week is meaningless |
| `GET slots` | `offeringId` missing | 422 `OFFERING_REQUIRED` |
| `GET slots` | Offering belongs to a different service | 422 |
| `GET slots` | Offering `isActive: false` | 200 with an empty slot array, not an error |
| `GET slots` | Range over 62 days | 422 `RANGE_TOO_LARGE` |
| `GET slots` | `from` in the past | Allowed; past slots are filtered in step 4. Avoids the client needing to know the server's clock |
| `GET slots` | Service not public and caller is not the owner | 404 |
| `next-available` | Nothing in 62 days | 200 `{ slot: null }` - not a 404 |
| Time conversion | Invalid IANA zone on the profile | 500 with a clear message. Prevented at the boundary in M3, so reaching here is a bug |

## Security

| Threat | Mitigation |
| --- | --- |
| Availability written for another vendor's service | Ownership gate on every `:id` route. |
| Slot enumeration as a resource exhaustion vector | 62-day cap, `pageSize`-free endpoint, and the generator is O(days x cells) with no database call per slot - consumption is one batched query over the whole range. |
| Client-supplied "now" | There is no such parameter. The past check reads the server clock only. |
| Capacity raised by the client | `capacity` is only writable on the rule, by the owning vendor, and is snapshotted onto cells. The slots response is read-only. |

## Implementation order

- `common/time.ts` with unit tests first, including the two DST fixtures. Everything
  downstream is wrong if this is wrong, and it is the cheapest thing to get right early.
- `slot-generator.service` as a pure function, tested against fixtures with no database.
- Rules and exceptions CRUD.
- The two read endpoints, wiring the generator to real data.
- `SlotCell` consumption subtraction - can be stubbed as "always full capacity" until M6
  creates the first cell, which keeps M5 shippable before M6 exists.
- Client availability editor and slot picker.

## Risks and edge cases

- **Granularity versus duration mismatch** is the sharpest edge. Enforced in M4 at
  offering write time. If a service's granularity is changed later, misaligned offerings
  block the change with 422.
- **A window that does not divide evenly by duration** leaves a tail: 09:00-13:00 with a
  90-minute offering gives starts at 09:00, 10:30, 12:00 - and 12:00+90 = 13:30 overruns,
  so it is dropped by step 3. The vendor sees two slots, not three. Correct, but
  surprising; the availability editor previews the generated grid so the vendor sees it
  before publishing.
- **Consumption lookup must be one query, not one per slot.** Fetch every `SlotCell` for
  the service in the UTC range once, index it in a map, then subtract. Per-slot queries
  turn a 62-day request into thousands of round trips on a free-tier database.
- **Capacity snapshot drift.** Lowering a rule's capacity from 3 to 1 leaves existing
  cells at 3. Intentional - existing bookings must not become invalid - but it means the
  vendor's "capacity 1" does not apply until new cells are created. Called out in the UI
  and in DECISIONS.md.
- **Closure on a date with existing bookings.** The closure hides future slots but does
  **not** cancel the bookings that already exist. The vendor must cancel those
  explicitly, which writes proper history rows in M6. Silently voiding bookings would be
  worse. The UI warns with the count when closing such a date.
- **Two vendors, two zones, one customer.** Nothing shared between services, since
  timezone is per vendor profile. The only shared surface is the client's rendering,
  which always labels the zone.
- **`from`/`to` are local dates, not instants.** `from=2026-08-10` means the vendor's
  local day. Ambiguous if treated as UTC - a customer in UTC+13 asking for "today" would
  get the wrong day. Documented in the API reference and validated as `YYYY-MM-DD`.

## Test strategy

- Unit (no database): the generator against fixtures - two windows in a day, a closure,
  an open-window exception, 30 vs 60 minute duration over the same window, a window that
  does not divide evenly, and the two DST cases.
- Unit: past-slot filtering with an injected clock.
- Integration: `POST` a closure -> `GET slots` for that date is empty -> `DELETE` the
  exception -> slots are byte-identical to before. Both DONE WHEN items.
- Integration: capacity 2, one booking made via M6 -> the slot reports
  `remainingCapacity: 1`; second booking -> the slot is absent. The brief's DONE WHEN.
- Integration: change an offering 30 -> 60 and assert the slot count over a fixed window
  halves. The brief's DONE WHEN.
