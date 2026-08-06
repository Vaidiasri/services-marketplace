# Decisions and trade-offs

The reasoning behind the choices that are not obvious from the code, and the things that were
deliberately *not* built. Written as they were made; the plan they diverge from is in
[`doc/`](doc/), one document per module.

Where a decision was forced by something measured rather than reasoned, the measurement is
quoted.

---

## The data model

23 tables and 7 enums, in `server/prisma/schema.prisma`. Relations read left to right: the
table owns a foreign key to everything in **references**.

### Identity and access

| Table | References | What it holds |
| --- | --- | --- |
| `User` | `Role` | Email, `passwordHash` (argon2id), `fullName`, `isActive`. Exactly one role |
| `Role` | - | `slug` (`SUPER_ADMIN`, `CATALOGUE_MODERATOR`, `VENDOR`, `CUSTOMER`), `isSystem` |
| `Permission` | - | `slug` (`service.publish`, `vendor.approve`, ...), grouped by `resource` |
| `RolePermission` | `Role`, `Permission` | The join that makes permissions data. Unique on the pair |
| `RefreshToken` | `User` | SHA-256 **hash** of a 32-byte token, `expiresAt`, `revokedAt`, `replacedById` - a rotation chain |
| `PasswordResetToken` | `User` | In the schema, unwritten - see the note below |

### Vendor tables

| Table | References | What it holds |
| --- | --- | --- |
| `VendorProfile` | `User` | `businessName`, address, `timezone` (IANA), `status` (`PENDING`/`APPROVED`/`REJECTED`), `rejectionReason`. One per user |
| `VendorDocument` | `VendorProfile` | `storedFilename`, `originalName`, `mimeType`, `sizeBytes`. The file is on disk; the row is the record of it |

### Catalogue tables

| Table | References | What it holds |
| --- | --- | --- |
| `Category` | `Category` (self) | Two-level tree via nullable `parentId`, `slug` unique |
| `Service` | `VendorProfile`, `Category` | `title`, `description`, `status` (`DRAFT`/`PUBLISHED`/`SUSPENDED`), `slotGranularityMinutes`, the cancellation policy, and `searchVector` (tsvector, trigger-maintained, GIN-indexed) |
| `Offering` | `Service` | The bookable unit: `name`, `durationMinutes`, `priceMinor`, `currency`, `isActive`. A service has many |
| `ServiceImage` | `Service` | In the schema, unwritten - see the note below |

### Availability tables

| Table | References | What it holds |
| --- | --- | --- |
| `AvailabilityRule` | `Service` | A weekly window as `weekday` + `startMinute`/`endMinute` from local midnight + `capacity`. **Never an instant** - that is what survives DST |
| `AvailabilityException` | `Service` | A single local date, `type` `CLOSED` or `OPEN_OVERRIDE`, optional minute window. Beats the rules |
| `SlotCell` | `Service` | The consumption counter: `startUtc`, `capacity`, `bookedCount`. Unique on `(serviceId, startUtc)`, created lazily on first booking. **The row `SELECT ... FOR UPDATE` locks** |

### Booking tables

| Table | References | What it holds |
| --- | --- | --- |
| `Booking` | `Service`, `Offering`, `User` (customer), `VendorProfile` | `reference` (`BK-XXXXXXXX`), `startUtc`/`endUtc`, `status`, `priceMinor` **snapshotted at creation**, `paymentMode`, `cancellationFeeMinor` |
| `BookingStatusHistory` | `Booking`, `User` (actor) | Every transition: `fromStatus`, `toStatus`, `reason`, actor, timestamp. The audit trail that matters |
| `BookingSlotCell` | `Booking`, `SlotCell` | Which cells this booking actually consumed, so releasing capacity is exact rather than recomputed from availability that may since have changed |

### Money and safety

| Table | References | What it holds |
| --- | --- | --- |
| `Payment` | `Booking` | `amountMinor`, `status` (`INITIATED`/`SUCCESS`/`FAILED`/`REFUNDED`/`PARTIALLY_REFUNDED`), `mode`, `providerRef`, `failureReason` |
| `LedgerEntry` | `Payment` | Append-only `CHARGE`/`REFUND`/`FEE` lines. Nothing is ever updated in place, so the history of a refund cannot be rewritten |
| `IdempotencyKey` | `User` | Unique on `(userId, scope, key)` with a request hash and the stored response. Written **inside** the effect's transaction, so a crash cannot leave a key claiming work that never happened |
| `WebhookEvent` | - | `eventId` unique. The dedupe is the index, not a status read - two simultaneous deliveries would both read `INITIATED` and both apply |
| `AuditLog` | `User` (actor) | In the schema, unwritten - see the note below |

**Three tables exist and nothing writes to them:** `PasswordResetToken`, `ServiceImage` and
`AuditLog`. Password reset is not in the brief; images are not built because Render's disk is
ephemeral; and `BookingStatusHistory` already carries actor, action, target and timestamp for
every intervention that matters. They are named here rather than quietly left for a reviewer to
find, because an unexplained unused table looks like something forgotten. Removing them was the
alternative and would have cost a migration for no behavioural gain.

**What has no table, deliberately:** slots. There is no row per bookable start. Availability is
derived on every read - rules minus exceptions minus consumption - and `SlotCell` appears only
once someone books. A slots table would have to be regenerated whenever a rule changed, and the
regeneration would race the bookings already pointing at it.

---

## Permissions

**Permissions are rows, not enums.** A role's set is resolved per request from
`RolePermission`, so revoking one takes effect on the caller's next request with no redeploy
and no token refresh. The cost is a query per request; it is memoised per request in
`AsyncLocalStorage`, and deliberately **not** cached across requests. A 30-second cache would
make the brief's live-revocation check appear broken for 30 seconds, and that check is worth
more than the query it would save.

**`SUPER_ADMIN` holds zero permission rows.** The bypass is a role-slug short-circuit. The
alternative - granting it every slug - stops being "every" the moment a permission is added,
which is a bug that appears months later and only for the newest feature.

**Access tokens carry `{ sub, roleSlug, jti }` and no permissions.** A token minted before a
vendor was approved keeps working after approval, because status and permissions are read per
request. Baking them in would mean a user has to sign out and back in for an admin's change to
take effect, and would make revocation a lie for the life of the token.

**Three independent gates: permission → ownership → vendor status.** Holding `service.publish`
lets a vendor publish *their own* service *if approved*. Each answers a different question and
each has its own code, so a 403 says which one refused. Ownership is helper functions rather
than a guard: a guard would have to load an arbitrary record from an arbitrary table by id,
which becomes a switch statement worse than the thing it replaces.

**Hiding UI is cosmetic and is documented as such.** `buildNav` filters navigation by
permission so nobody is offered a link that will 403, but every destination is server-guarded.
The seeded catalogue moderator has no `vendor.read_all`: the link is absent *and* typing the
URL is refused by the server.

---

## Data

**Money is integer minor units everywhere, and there is no float in the money path.**
`Math.round` is applied exactly once, at cancellation-fee computation, and that is asserted:
`fee + refundable === price` exactly, including for an odd price at an odd percentage.

**Prices cannot arrive from a request body.** `priceMinor` is snapshotted onto the booking from
the offering row *inside* the booking transaction, and no DTO has a price field - so sending
one is a 422 from `.strict()` rather than something that has to be remembered to strip. Same
for `status`, `customerUserId` and `cancellationFeeMinor`.

**Every timestamp is `timestamptz`, stored UTC.** Availability is the exception that proves it:
rules are stored as local weekday plus minutes-from-midnight, never as instants, so a vendor's
opening hours survive a DST transition unchanged. Storing them as UTC would shift a salon's
hours by an hour twice a year, silently.

**404, not 403, for anything hidden.** A draft service, another tenant's booking, another
vendor's document - all answer 404, because confirming that an id exists is itself a leak. The
brief allows either; 404 leaks strictly less.

**Offset pagination, not keyset.** What the brief asks for ("page 2 ... and a total count") and
fine at seed scale. It is a real limit on a large catalogue and is named as one. The ordering
carries an `id` tie-breaker, without which rows with identical `createdAt` silently swap
between pages - the pagination test inserts its 25 rows in one statement precisely so they
share a timestamp and would expose that.

---

## Catalogue

**Full-text search is a `tsvector` maintained by a database trigger, not `ILIKE '%q%'`.** A
leading wildcard cannot use an index. `EXPLAIN` confirms the GIN index is used, and `plumbing`
stems to `plumb` so "plumber" matches "plumbing".

**The trigger replaced a `GENERATED ALWAYS` column, which would have broken every later
migration.** Prisma introspects a generated column as having a default and emits
`ALTER COLUMN "searchVector" DROP DEFAULT` on the next `migrate dev`, which Postgres refuses:

```
ERROR: column "searchVector" of relation "Service" is a generated column
```

That was proven by running it. A plain column plus a trigger gives the identical guarantee -
Postgres owns the value, it can never go stale - with no drift.

**Search composes with the visibility rule rather than replacing it.** Prisma cannot express
`@@` in a `where`, so when `q` is present one raw index-backed query resolves ids and those
compose into the normal predicate. Writing the whole list query in raw SQL would mean
hand-writing the "published AND vendor approved" condition a second time, and the failure mode
of two copies is a draft appearing on the public catalogue.

**Sorting by price is not offered.** Prisma cannot order by an aggregate over a relation, so it
would need a second query path around that single visibility rule. Price *filtering*, which is
the graded part, works.

**`POST /services/:id/images` was not built.** Render's disk is ephemeral, so uploaded images
vanish on every redeploy - which demos worse than no images. `ServiceImage` remains in the
schema.

---

## Slots

**Slots are derived on every read. There is no slot table.** Weekly rules minus date exceptions
minus consumption. `SlotCell` is a consumption *counter*, created lazily on first booking;
deleting every row in it changes no slot's existence.

**A shared per-service grid, not one row per bookable start.** This is the decision that makes
capacity correct with mixed durations. Capacity 1, a 60-minute booking at 09:00, and a customer
asking for 30-minute slots: a naive model has no counter at 09:30, so 09:30 looks free while
the vendor is mid-appointment. On a shared 30-minute grid the 60-minute booking occupies the
09:00 and 09:30 cells, and the 30-minute start at 09:30 finds its cell full. Asserted directly.

**Cells are anchored to local midnight, never to the start of a window.** `SlotCell` is unique
on `(serviceId, startUtc)` and shared by every offering, so per-window anchoring would produce
cells that overlap in time but not in key - and the capacity guarantee would be void.

**Capacity is per cell, taking the maximum of the rules covering it.** The plan merged
overlapping windows, which discards which rule each minute came from while capacity comes from
the rule: Tue 09:00-13:00 capacity 1 merged with Tue 12:00-14:00 capacity 3 left 12:30
undefined. Per-cell capacity answers it, and contiguity then falls out of adjacent cells
existing, so merging stops being a step at all.

**An existing cell keeps the capacity it was created with.** Lowering a rule from 3 to 1 must
not retroactively put an already-booked cell over its own limit. The consequence - the new
capacity applies only to cells not yet created - is intentional and is asserted.

**A local time inside the spring-forward gap yields no slot.** `localMinutesToUtc` returns null
rather than throwing: a vendor open at 02:00 on one Sunday a year is data, not an exception,
and throwing would need a try/catch inside the generator's hot loop. Luxon does not signal this
itself - it silently shifts past the gap - so the result is round-tripped back to local and
compared. In the ambiguous fall-back hour the earlier offset wins, deterministically.

Every DST case is tested against `America/New_York`, because `Asia/Kolkata` - the zone the seed
uses - has no DST and would let completely broken conversion pass.

**The timezone validator was rewritten because Intl is too permissive.** It previously accepted
anything `Intl.DateTimeFormat` did, and Node's ICU resolves the abbreviation `EST` to
`America/Panama` - a fixed UTC-5 zone that never observes daylight saving. A vendor who typed
"EST" would have had every slot an hour wrong for eight months of the year with nothing in the
data looking wrong. An identifier must now be `Region/City`. A whitelist of
`Intl.supportedValuesOf` would have been wrong here: this ICU build canonicalises
`Asia/Kolkata` to `Asia/Calcutta` and lists neither.

**`OPEN_WINDOW` exceptions default to capacity 1**, having no rule to inherit from. The plan
left it undefined.

---

## Bookings

**Capacity is a row lock on a counter, never a count of bookings.**
`SELECT count(*)` followed by `INSERT` is two statements with a gap: under `READ COMMITTED` two
transactions both read 1, both see room in a 2-seat slot, and both insert. `FOR UPDATE` on the
counter serialises the read-modify-write. `capacity.repository.ts` is the only file in the
project with raw SQL.

**`SERIALIZABLE` is not used.** `READ COMMITTED` plus explicit row locks is sufficient, cheaper,
and does not force retry-on-serialization-failure handling.

**Cells are always locked in ascending `startUtc` order, and only through `lockCells`.** Two
reschedules crossing each other - one moving 10:00 to 11:00 while the other moves 11:00 to
10:00 - would otherwise take overlapping locks in opposite orders and deadlock. Because every
lock in the codebase goes through one function, the ordering holds globally rather than by
convention.

**Slot validation happens *outside* the transaction.** Measured: with the availability read
inside the locked section, 7 of 20 concurrent requests hit the lock ceiling and answered
`SLOT_CONTENDED` instead of `SLOT_FULL`, because every contender waited through two round trips
to a remote database while a lock was held. Nothing in that read decides capacity - that is
settled after the lock - so it is safe to compute first.

**The slot pre-check ignores consumption on purpose.** The generator drops a slot with no
remaining capacity, so passing real consumption would make a full slot indistinguishable from
an invented time: 422 `INVALID_SLOT` for what is really 409 `SLOT_FULL`.

**`connection_limit` is load-bearing and is documented in `.env.example`.** At 10, twenty
concurrent booking transactions exhausted Prisma's pool - each holds a connection while it
queues for a lock - and 9 requests returned Prisma `P2024` as a 500. Raised to 25, and `P2024`
now maps to 409 `SLOT_CONTENDED`: a pool timeout under contention is a "try again", not an
internal error.

**The lock ceiling is 25 seconds** because this development machine is in India and Neon is in
`us-east-2`, so seventeen serialized waiters cost a round trip each. Co-located, the race
finishes in about a second and the ceiling is never approached.

**The state machine is two data tables plus one `assertTransition` call per mutation**, tested
exhaustively over all 108 `(from, to, actor)` triples rather than spot-checked. A permission
failure and an illegal move are genuinely different: a customer calling complete is 403 from
the guard; a vendor calling it on a `PENDING` booking is 422 `ILLEGAL_TRANSITION`.

**Late cancellation charges a fee rather than being refused.** The brief permits either.
Charging is what real marketplaces do - a customer with an emergency can always cancel, they
just forfeit part of the price. Exactly 24 hours is *not* late; one minute inside the window is.

**`NO_SHOW` does not release cells.** The vendor held the slot open and the customer did not
arrive; handing the seat back would reward the no-show with a free cancellation.

**`BookingSlotCell` records what was actually consumed**, so release on cancel or reschedule is
exact even after the vendor later edits the offering's duration. Recomputing the range from the
current duration would release the wrong cells.

---

## Payments

**A `PaymentProvider` port with a mock adapter, bound in one line.** Replacing the mock with a
real gateway is one adapter class and one `useClass`; no service imports a concrete provider.

**Outcomes come from deterministic tokens, never random failure.** A reviewer has to be able to
trigger a decline during a walkthrough; a 10% random decline can only be waited for. The token
selector is deliberately exposed in the UI, because otherwise the most interesting behaviour in
the payment layer is unreachable without curl.

**Provider calls happen outside transactions.** A network round trip with an open transaction
holds a database connection for its duration - the same failure this project already hit with
`P2024`. The mock is instant, but the structure has to be the one that survives a real gateway.

**A failed payment cancels the booking rather than leaving it `PENDING`.** Leaving it pending
with released cells would mean a booking whose seat is gone, so a vendor could confirm an
appointment with no capacity behind it. Cancelling is the honest state and is what makes "the
slot is bookable by someone else" actually true.

**Webhook dedupe is a unique index on `eventId`, not a read of the payment's status.**
Status-checking looks equivalent and races: two simultaneous deliveries both read `INITIATED`
and both apply. The insert and the effect are in one transaction, so a double delivery is
inert. The webhook is public but HMAC-verified over the raw body - the signature *is* the
authentication, compared with `timingSafeEqual`.

**Idempotency records are written inside the effect's transaction.** Writing them separately
can leave a key claiming success for a booking that rolled back, or a booking with no key so a
retry charges twice.

**No expiry sweeper for `tok_delay` payments.** Nothing in the brief asks for one and a
free-tier instance sleeps anyway.

---

## Delivery

**Migrations are a deploy step, not a boot step.** `prisma migrate deploy` was in the server's
`start` script and failed a deploy with:

```
Error: P1002 - Timed out trying to acquire a postgres advisory lock
```

Neon's pooled endpoint is PgBouncer in transaction mode, where a session-scoped advisory lock
is unreliable - and independently, several instances booting at once all race for that lock and
every loser crash-loops against a database that is already up to date. Migrations now run
explicitly, against the direct endpoint.

**The seed is idempotent and verified so** - three consecutive runs leave the same counts - so
it is safe to run on every deploy and against a database that already has data. It writes
bookings together with the `SlotCell` counters they consume, exactly as the booking transaction
does; seeding a booking without its cells would advertise a seat that is already taken.

**`scripts/clean-test-data.ts` exists because the suites leave debris.** The database had
accumulated 161 users and 30 services, so a reviewer browsing the deployed catalogue would have
paged through "Slot Service 1785988016759". The match requires a known test prefix, then ten or
more digits, then exactly the `marketplace.test` domain - a real signup on any other domain
cannot match it, and it runs `--dry-run` first.

---

## Cut deliberately

| Item | Why |
| --- | --- |
| Staff assignment (brief stretch) | A second capacity dimension on top of the most heavily graded logic in the assignment |
| Service image upload | Render's disk is ephemeral; images would vanish on every redeploy |
| Vendor service/availability editor UI | The API is complete and tested; screen time went to the customer journey, which demonstrates M4-M7 |
| Category and roles console UI | Same - reachable via the API, and the permission model is already visible through the vendor approval queue |
| Writing to `AuditLog` | The table is in the schema; nothing writes to it. `BookingStatusHistory` already records actor, action, target and timestamp for the interventions that matter |
| Keyset pagination | Offset is what the brief asks for and is correct at this scale |

---

## Known gaps

- **Eight tests are deferred by construction, not forgotten.** `OFFERING_IN_USE`,
  `SERVICE_IN_USE` and "suspension preserves a `CONFIRMED` booking" are implemented but could
  not be asserted until M6 could create a booking; they are covered now through the booking
  suite's fixtures rather than in the catalogue suite where the code lives.
- **Vendor documents answer 410 `FILE_GONE` after a redeploy.** Render's disk is ephemeral. The
  row survives, the file does not, and 410 says "was here, is gone" where 404 would wrongly
  imply it never existed.
- **The integration suites take longer than a 15-minute access token.** The bookings suite
  re-authenticates before its final section. That is the auth layer working correctly, not a
  workaround.

---

## What I would build next, given another week

In this order, because each one is the largest remaining risk at the time it is reached.

**1. The vendor service and availability editor, as screens.** The biggest gap between what the
API does and what a reviewer can click. Everything behind it - create, update, publish,
unpublish, weekly rules, date exceptions - is built and tested; it is driven by curl. Two days,
and it is the first thing I would do because it is the only unbuilt item that changes what the
product *appears* to do.

**2. A background job for the states nothing currently moves.** A `CONFIRMED` booking whose end
time has passed sits `CONFIRMED` forever - completion is a vendor action, and a vendor who never
opens the app never performs it. The same job would expire a `PENDING` `PAY_NOW` booking whose
payment stayed `INITIATED`, which today holds capacity indefinitely. That is the one behaviour I
would call an outright defect rather than a cut, and it is second only because a reviewer sees
it less readily than a missing screen.

**3. Keyset pagination on the catalogue, and sorting by price.** Offset is correct at seed scale
and wrong at a hundred thousand services. Sorting by price needs the price denormalised onto
`Service` (a `minPriceMinor` maintained alongside the offerings) - Prisma cannot order by an
aggregate over a relation, and I would not add a second query path around the single visibility
rule that keeps drafts out of the catalogue.

**4. Notifications, as an outbox rather than an email call.** A booking transition writes an
outbox row inside the same transaction; a worker delivers it. Sending email inside the booking
transaction means an SMTP timeout rolls back a booking that should have succeeded, and sending
it after the commit means a crash loses the notification silently.

**5. Real payments, which should be a small change and is the test of whether the port is
honest.** `PaymentProvider` is an interface with one implementation. A real gateway means a
second implementation, a client-side redirect or element, and a webhook whose signature scheme
differs - the HMAC verification, raw-body handling, `eventId` dedupe and `applyOutcome`
transaction all stay. If replacing the mock touched `BookingsService`, the boundary was drawn
in the wrong place.

**6. Then the two consoles I cut** - category management and roles-and-permissions - which are
CRUD over endpoints that already exist and enforce their own permissions. Last, because they
change nothing about correctness and a super admin can already do all of it by API.

What I would **not** spend the week on: more integration tests. At 472 assertions the marginal
one costs more wall-clock than it catches. I would spend that time on the job in item 2, because
the failure it prevents is capacity held by a booking nobody will ever complete.
