# M6 - The Booking Lifecycle (Plan)

Brief module 06. Booking integrity rubric area (20 marks). Three of the walkthrough's
six questions are about this module's transaction boundary.

## Key decisions

- **The transition table is data, in one file.** A `Record<BookingStatus, BookingStatus[]>`
  plus a per-transition actor rule. No `if (status === ...)` chains scattered across
  service methods - one `assertTransition(from, to, actor)` call at the top of every
  mutation.
- **Capacity is enforced by `SELECT ... FOR UPDATE` on `SlotCell` rows inside one
  transaction.** Not by counting bookings. Not by a unique constraint on
  (slot, seatNumber) - which works but forces a seat-numbering scheme that adds nothing.
- **Cells are locked in ascending `startUtc` order, always.** Two bookings whose cell
  ranges overlap partially would deadlock under inconsistent ordering. This single detail
  is the difference between the race script passing and it intermittently erroring.
- **Isolation level `SERIALIZABLE` is not used.** `READ COMMITTED` plus explicit row locks
  is sufficient, cheaper, and does not force retry-on-serialization-failure handling.
  Documented in DECISIONS.md as a deliberate choice, since "identify your transaction
  boundary" is a walkthrough question.
- **Price is snapshotted.** `Booking.priceMinor` is copied from `Offering.priceMinor`
  inside the transaction. The create DTO has no price field.
- **Late cancellation charges a fee rather than refusing.** The brief permits either.
  `Service.freeCancellationHours` and `Service.cancellationFeePercent` declare the policy;
  it is enforced server-side against server time.
- **History rows are written in the same transaction as the status change.** A booking
  whose status moved without a history row is unrepresentable.
- **`BookingSlotCell` records which cells a booking consumed**, so release on cancel and
  reschedule decrements exactly the right rows rather than recomputing the range from the
  offering's current duration - which would be wrong if the duration changed since.
- **Staff assignment is cut.** Brief-tagged stretch, and it adds a second capacity
  dimension on top of the most heavily graded logic in the assignment. Item 1 on the cut
  list in [00_MASTER_PLAN.md](../../00_MASTER_PLAN.md).

## API contract

| Method | Endpoint | Requires | Notes |
| --- | --- | --- | --- |
| POST | `/bookings` | `booking.create` | `Idempotency-Key` required. `{ serviceId, offeringId, startUtc, paymentMode, paymentToken? }`. Returns 201 with the booking and, for `PAY_NOW`, an initiated payment |
| GET | `/bookings` | `booking.read` | Own bookings, scoped by role. `page`, `pageSize`, `status`, `from`, `to` |
| GET | `/bookings/:id` | `booking.read` + own | Includes `history[]` and `payments[]` |
| PATCH | `/bookings/:id/confirm` | `booking.confirm` + own vendor | `PENDING -> CONFIRMED`. Refused if a `PAY_NOW` payment is not `SUCCESS` |
| PATCH | `/bookings/:id/reject` | `booking.reject` + own vendor | `{ reason }` required. `PENDING -> REJECTED`, releases cells |
| PATCH | `/bookings/:id/complete` | `booking.complete` + own vendor | `CONFIRMED -> COMPLETED`. Refused before `endUtc` has passed |
| PATCH | `/bookings/:id/no-show` | `booking.no_show` + own vendor | `CONFIRMED -> NO_SHOW`. Refused before `startUtc` has passed |
| PATCH | `/bookings/:id/cancel` | `booking.cancel` + own | `{ reason? }`. Customer or vendor. Applies the cancellation policy |
| PATCH | `/bookings/:id/reschedule` | `booking.reschedule` + own | `{ startUtc }`. Atomic release-and-take |
| PATCH | `/admin/bookings/:id/force-cancel` | `booking.force_cancel` | `{ reason }` **required**. Bypasses the window. Full refund |
| GET | `/admin/bookings` | `booking.read_all` | Cross-vendor. Covered in [M8](../M8_ADMIN_CONSOLE/plan.md) |

## Impact map

- `server/prisma/schema.prisma` - `Booking`, `BookingStatusHistory`, `BookingSlotCell`,
  `BookingStatus` + `PaymentMode` enums - add
- `server/src/bookings/bookings.module.ts` - add
- `server/src/bookings/state-machine.ts` - `TRANSITIONS`, `ACTOR_RULES`,
  `assertTransition(from, to, actor)` - add - pure, no dependencies, fully unit-testable
- `server/src/bookings/capacity.repository.ts` - `ensureCells(tx, ...)`,
  `lockCells(tx, ...)`, `incrementCells(tx, ...)`, `releaseCells(tx, ...)` - add - the only
  file containing raw SQL, and the file the walkthrough will be shown
- `server/src/bookings/bookings.service.ts` - `create`, `confirm`, `reject`, `complete`,
  `noShow`, `cancel`, `reschedule`, `forceCancel` - add
- `server/src/bookings/history.service.ts` - `record(tx, booking, from, to, actor, reason)`
  - add - takes `tx`, so it cannot be called outside a transaction by accident
- `server/src/bookings/cancellation-policy.ts` - `evaluate(service, booking, now)` -> `{ isLate, feeMinor, refundableMinor }` - add - pure
- `server/src/bookings/bookings.controller.ts` / `admin-bookings.controller.ts` - add
- `server/src/common/idempotency.interceptor.ts` - add - shared with [M7](../M7_PAYMENTS_MOCK/plan.md)
- `server/scripts/race.ts` - the 20-concurrent script - add - **committed, with its output**
- `server/scripts/race-output.txt` - add
- `client/src/routes/customer/BookingFlow.tsx`, `MyBookings.tsx`, `BookingDetail.tsx` - add
- `client/src/routes/vendor/BookingQueue.tsx` - add
- `client/src/components/BookingTimeline.tsx` - add

## The state machine

```ts
const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  PENDING:   ['CONFIRMED', 'REJECTED', 'CANCELLED'],
  CONFIRMED: ['COMPLETED', 'CANCELLED', 'NO_SHOW'],
  COMPLETED: [], REJECTED: [], CANCELLED: [], NO_SHOW: [],
}
```

Permission alone does not authorise a transition; the actor rule does too:

| Transition | Customer | Vendor | Admin |
| --- | --- | --- | --- |
| -> `CONFIRMED` | no | yes | yes |
| -> `REJECTED` | no | yes | yes |
| -> `COMPLETED` | no | yes | yes |
| -> `NO_SHOW` | no | yes | yes |
| -> `CANCELLED` | yes | yes | yes (force) |

`assertTransition` throws `IllegalTransitionError` -> 422 `ILLEGAL_TRANSITION` with
`details: { from, to, allowed }`. A **permission** failure is 403 and happens earlier, in
the guard. The two brief checks map onto exactly this split: a customer calling complete
is 403 (no `booking.complete`); a vendor calling complete on `PENDING` is 422 (has the
permission, illegal move).

## Algorithm - booking creation (the graded one)

Everything from step 3 to step 9 is inside a single `prisma.$transaction`.

1. Validate the DTO. Resolve the service through `publicServiceWhere()` - a suspended or
   draft service is a 404 here, which is what makes M4's suspension actually stop new
   bookings.
2. Check the idempotency key. A hit replays the stored response and returns immediately.
3. **Open the transaction.** Load the offering and read `priceMinor` and `durationMinutes`
   from the row.
4. Recompute the slot from rules and exceptions using M5's pure generator, and assert the
   requested `startUtc` is a real derived slot start that is not in the past. A client
   cannot invent a start time - it must fall on the grid, inside an open window, on a
   non-closed date.
5. Compute the cell range: `startUtc` stepping by `slotGranularityMinutes` for
   `durationMinutes / granularity` cells.
6. **`ensureCells`** - `INSERT ... ON CONFLICT (serviceId, startUtc) DO NOTHING` for every
   cell in the range, with `capacity` taken from the governing rule. Concurrent inserts
   are harmless; exactly one wins per row and the rest no-op.
7. **`lockCells`** - `SELECT ... FROM "SlotCell" WHERE ... ORDER BY "startUtc" ASC FOR UPDATE`.
   **The ordering is mandatory.** The second concurrent request blocks here.
8. Assert `bookedCount < capacity` for **every** locked cell. Any cell full ->
   `SlotFullError` -> the transaction rolls back -> 409 `SLOT_FULL`. The re-read after
   acquiring the lock is the entire point: the first request's increment is visible now.
9. `UPDATE "SlotCell" SET "bookedCount" = "bookedCount" + 1 WHERE id IN (...)`, insert the
   `Booking` (`PENDING`, snapshotted price), insert the `BookingSlotCell` rows, insert the
   `PENDING -> ...` history row, insert the idempotency record, and for `PAY_NOW` insert an
   `INITIATED` payment. **Commit.**

If the process dies anywhere inside, Postgres rolls back the whole thing: no booking, no
increment, no history, no idempotency record. That is the answer to the walkthrough's
"explain the outcome if the process fails inside it."

### Why the lock and not a count

`SELECT count(*) FROM Booking WHERE ...` then `INSERT` is two statements with a gap. Under
`READ COMMITTED`, two transactions both read 1, both see room in a 2-seat slot, both
insert - 3 bookings. `FOR UPDATE` on a counter row serialises the read-modify-write:
the second transaction cannot even read the row until the first commits, and when it
does, it reads the incremented value.

## Algorithm - reschedule

One transaction. Old and new cell ranges are combined into **one sorted list** and locked
together in ascending `startUtc` order - not old-then-new, which can deadlock against a
concurrent reschedule going the other direction.

1. Load the booking, assert status is `PENDING` or `CONFIRMED`, assert the caller is the
   customer (or an admin).
2. Validate the new `startUtc` against the freshly generated slots.
3. Lock the union of old and new cells, sorted ascending.
4. Assert every new cell has room. No -> rollback, 409 `SLOT_FULL`, original booking
   untouched.
5. Decrement old cells, delete their `BookingSlotCell` rows, increment new cells, insert
   new `BookingSlotCell` rows, update `startUtc`/`endUtc`, write a history row with
   `from == to` and the reason `"rescheduled from <old> to <new>"`. Commit.

Status does not change on reschedule - a confirmed booking stays confirmed. The history
row is what records the move, which is why history allows `from == to`.

## Algorithm - cancellation

1. Load booking + service. `assertTransition(status, 'CANCELLED', actor)`.
2. `cancellation-policy.evaluate(service, booking, now)`:
   `hoursUntilStart = (startUtc - now) / 3600000`. If
   `hoursUntilStart < service.freeCancellationHours`, it is late:
   `feeMinor = round(priceMinor * cancellationFeePercent / 100)`. Rounding is
   `Math.round`, on integers, once - documented so the arithmetic is not a mystery.
3. One transaction: set `CANCELLED`, store `cancellationFeeMinor` and `cancelReason`,
   release the booking's cells via `BookingSlotCell`, write history, and hand off to M7 for
   a refund of `priceMinor - feeMinor` if a `SUCCESS` payment exists.

Force-cancel skips step 2 entirely: `feeMinor = 0`, full refund, reason mandatory.

## Error handling

| Operation | Failure | Behaviour |
| --- | --- | --- |
| Create | Slot full | 409 `SLOT_FULL`. The clean refusal the brief requires |
| Create | `startUtc` not a derived slot start | 422 `INVALID_SLOT` |
| Create | `startUtc` in the past | 422 `SLOT_IN_PAST`, checked server-side against the vendor's timezone maths |
| Create | Service suspended, draft, or vendor unapproved | 404 |
| Create | Offering inactive or belongs to another service | 422 |
| Create | Body contains `priceMinor` or `status` | 422 - `.strict()` DTO |
| Create | Missing `Idempotency-Key` | 400 `IDEMPOTENCY_KEY_REQUIRED` |
| Create | Key replayed, same body | 200 with the original response. One booking, one payment |
| Create | Key replayed, different body | 409 `IDEMPOTENCY_KEY_REUSED` |
| Create | Customer books their own vendor's service | Allowed. Not worth blocking |
| Any transition | Not in `TRANSITIONS[from]` | 422 `ILLEGAL_TRANSITION` |
| Any transition | Correct move, wrong actor | 403 `FORBIDDEN` |
| Any transition | Booking belongs to another vendor or customer | 404 - never the record |
| Confirm | `PAY_NOW` payment not `SUCCESS` | 422 `PAYMENT_REQUIRED` |
| Complete | `endUtc` in the future | 422 `TOO_EARLY_TO_COMPLETE` |
| No-show | `startUtc` in the future | 422 `TOO_EARLY_FOR_NO_SHOW` |
| Reject / force-cancel | Missing reason | 422 |
| Reschedule | Status terminal | 422 `ILLEGAL_TRANSITION` |
| Reschedule | New slot full | 409, original booking unchanged |
| Reschedule | Same slot as current | 200, no-op, no history row |
| Cancel | Already terminal | 422 |
| Lock wait | Statement timeout (10 s) exceeded | 409 `SLOT_CONTENDED` rather than a 500. Under 20-way contention the last waiter should not see an internal error |

## Security

| Threat | Mitigation |
| --- | --- |
| Price manipulation | `priceMinor` read from `Offering` inside the transaction; absent from the DTO. |
| Booking on someone else's behalf | `customerUserId` comes from the authenticated user, never the body. |
| Cross-tenant read | `scopeToCaller` on lists, `assertOwnership` with `notFoundOnMismatch` on detail. Vendor A gets 404 for Vendor B's booking id - the brief's DONE WHEN. |
| Customer completing their own booking | `booking.complete` is not in `CUSTOMER`; guard returns 403 before the state machine runs. |
| Bypassing the cancellation fee | Fee computed server-side from the service row and the server clock. No client input. |
| Force-cancel by a vendor | `booking.force_cancel` is admin-only and separate from `booking.cancel`. |
| Capacity bypass by crafting `startUtc` | Step 4 regenerates slots; an off-grid start is 422. |
| Idempotency key stolen across users | Key is scoped `(userId, scope, key)`, so another user's key collides with nothing. |

## Implementation order

- `state-machine.ts` + its unit tests. Pure, fast, and it fixes the vocabulary the rest
  of the module uses.
- `capacity.repository.ts` with the raw SQL, exercised by a two-transaction integration
  test before any HTTP route exists.
- `POST /bookings` end to end, then immediately `scripts/race.ts`. Do not build the other
  transitions before the race passes - everything after depends on the cell model being
  right.
- Confirm / reject / complete / no-show. Mechanical once the state machine exists.
- Cancel with the policy, then reschedule. Reschedule is the hardest after create and
  benefits from cancel's release path already working.
- History surfaces last, on the client.

## Risks and edge cases

- **Deadlock from inconsistent lock ordering.** The top risk in the whole project. Two
  reschedules crossing each other lock overlapping cell sets in opposite orders and both
  hang until one is killed - which shows up as an intermittent 500 in the race script, the
  worst possible thing to demo. Mitigation is absolute: every lock acquisition goes
  through `lockCells`, which sorts by `startUtc` ascending, and no other code path takes a
  `SlotCell` lock.
- **Connection pool starvation under the race script.** 20 concurrent transactions each
  holding a connection while waiting on a lock. Neon's free tier and Prisma's default pool
  are small. Set `connection_limit` explicitly in `DATABASE_URL` and use the pooled Neon
  endpoint; otherwise the script fails with pool timeouts and looks like a capacity bug.
  Verify the script against the **deployed** database, not just locally.
- **Prisma interactive transaction timeout** defaults to 5 seconds. Under 20-way
  contention the last waiter can exceed it. Set `timeout: 15000, maxWait: 15000` on the
  create transaction, and the Postgres `statement_timeout` to something lower so a stuck
  lock surfaces as 409 `SLOT_CONTENDED` rather than a Prisma error.
- **Cells for a duration that changed after booking.** `BookingSlotCell` is the record of
  what was consumed, so release is always exact. Never recompute the range from the
  offering's current duration on release.
- **Capacity from overlapping merged windows.** If two rules cover the same minute with
  different capacities, `ensureCells` must pick one deterministically - the maximum, and
  documented. Otherwise cell capacity depends on row order.
- **`COMPLETED` before the appointment.** Blocked by the `endUtc` check, so a vendor
  cannot farm completions for a dashboard number. Slightly awkward for the demo, since
  seeded completed bookings must be in the past - the seed handles that.
- **PAY_AFTER confirm has no payment gate**, so a vendor can confirm immediately. Correct
  per the brief, but it means `PAYMENT_REQUIRED` only ever fires for `PAY_NOW`. Asserted in
  a test so the branch is not dead code by accident.
- **A slot that becomes unavailable after a booking exists** (vendor closes the date). The
  booking survives; the cells stay consumed. Covered in M5's risks.

## Test strategy

Two of the brief's three named high-value tests live here.

- **The capacity race - `scripts/race.ts`, committed with output.** Seeds a capacity-3
  slot, fires 20 concurrent `POST /bookings` with distinct idempotency keys via
  `Promise.all`, then asserts `created === 3`, `conflicted === 17`, every conflict is a 409
  `SLOT_FULL`, and `SlotCell.bookedCount === 3`. Runs against local **and** deployed.
- **Booking state machine test.** Table-driven over all 36 (from, to) pairs x three actor
  types, asserting allow / 422 / 403. Catches a transition silently added later.
- Integration: customer -> `PATCH /complete` = 403; vendor -> same on `PENDING` = 422.
  The brief's DONE WHEN, verbatim.
- Integration: book, reschedule, cancel, then read `GET /bookings/:id` and assert the
  history rows in order with correct actors and reasons. The brief's timeline DONE WHEN.
- Integration: two transactions in one test - A locks, B blocks, A commits, B sees the
  incremented count. Proves the lock without needing 20 processes.
- Integration: reschedule into a full slot leaves the original booking byte-identical.
- Unit: `cancellation-policy.evaluate` at boundaries - exactly 24 hours, 23:59, 24:01.
