import { Prisma } from '@prisma/client';
import { Errors } from '../common/errors';
import type { PlannedCell } from '../availability/slot-generator';

/**
 * The only file in the project containing raw SQL, and the one the walkthrough is about.
 *
 * Capacity is enforced by a row lock on a counter, not by counting bookings.
 * `SELECT count(*) FROM "Booking" ...` followed by `INSERT` is two statements with a gap:
 * under READ COMMITTED two transactions both read 1, both see room in a 2-seat slot, and
 * both insert. Three bookings. `FOR UPDATE` on the counter row serialises the whole
 * read-modify-write - the second transaction cannot read the row until the first commits,
 * and when it does it reads the incremented value.
 */

/** A Prisma transaction client. Every function here demands one - none may run standalone. */
export type Tx = Prisma.TransactionClient;

export type LockedCell = { id: string; startUtc: Date; capacity: number; bookedCount: number };

/**
 * Creates any missing counter rows for the planned cells.
 *
 * `ON CONFLICT DO NOTHING` rather than a read-then-insert: under concurrency several
 * transactions try to create the same cell, exactly one wins per row, and the rest no-op
 * instead of raising a unique-violation that would have to be caught and retried.
 *
 * Capacity is the per-cell entitlement computed by the generator, so a cell covered by two
 * overlapping rules keeps the roomier one rather than depending on row order.
 */
export async function ensureCells(tx: Tx, serviceId: string, cells: PlannedCell[]): Promise<void> {
  if (cells.length === 0) return;

  // Parameterised, one statement. Building this with string concatenation of the dates
  // would be both an injection surface and slower.
  const values = Prisma.join(
    cells.map((c) => Prisma.sql`(${serviceId}, ${c.startUtc}, ${c.capacity}, 0)`),
  );

  await tx.$executeRaw`
    INSERT INTO "SlotCell" ("id", "serviceId", "startUtc", "capacity", "bookedCount")
    SELECT gen_random_uuid()::text, v.service_id, v.start_utc, v.capacity, v.booked
    FROM (VALUES ${values}) AS v(service_id, start_utc, capacity, booked)
    ON CONFLICT ("serviceId", "startUtc") DO NOTHING`;
}

/**
 * Locks the given cells FOR UPDATE, **always in ascending startUtc order**.
 *
 * The ordering is not a detail. Two reschedules crossing each other - one moving 10:00 to
 * 11:00 while the other moves 11:00 to 10:00 - lock overlapping sets in opposite orders and
 * deadlock, which surfaces as an intermittent 500 in the race script. Every lock in this
 * codebase is taken here, and this is the only place that takes one, so the ordering holds
 * globally rather than by convention.
 */
export async function lockCells(
  tx: Tx,
  serviceId: string,
  startUtcs: Date[],
): Promise<LockedCell[]> {
  if (startUtcs.length === 0) return [];

  const sorted = [...startUtcs].sort((a, b) => a.getTime() - b.getTime());

  return tx.$queryRaw<LockedCell[]>`
    SELECT "id", "startUtc", "capacity", "bookedCount"
    FROM "SlotCell"
    WHERE "serviceId" = ${serviceId} AND "startUtc" IN (${Prisma.join(sorted)})
    ORDER BY "startUtc" ASC
    FOR UPDATE`;
}

/**
 * The re-read after the lock is the entire point: by the time this runs, a competing
 * transaction's increment is visible, so the seat it took is gone.
 */
export function assertRoom(cells: LockedCell[]): void {
  for (const cell of cells) {
    if (cell.bookedCount >= cell.capacity) throw Errors.slotFull();
  }
}

export async function incrementCells(tx: Tx, cellIds: string[]): Promise<void> {
  if (cellIds.length === 0) return;
  await tx.$executeRaw`
    UPDATE "SlotCell" SET "bookedCount" = "bookedCount" + 1
    WHERE "id" IN (${Prisma.join(cellIds)})`;
}

/**
 * `GREATEST(0, ...)` is a belt-and-braces floor. A negative counter would silently create
 * phantom capacity, which is worse than a stuck-high one - so if a double release ever
 * happens, it clamps rather than overselling.
 */
export async function releaseCells(tx: Tx, cellIds: string[]): Promise<void> {
  if (cellIds.length === 0) return;
  await tx.$executeRaw`
    UPDATE "SlotCell" SET "bookedCount" = GREATEST(0, "bookedCount" - 1)
    WHERE "id" IN (${Prisma.join(cellIds)})`;
}

/**
 * Caps how long a transaction will sit behind someone else's lock.
 *
 * Under 20-way contention the last waiter would otherwise exceed Prisma's transaction
 * timeout and surface as an internal error. A Postgres statement timeout turns that into a
 * failure this code can recognise and answer 409 to - the last waiter in a race deserves a
 * clean refusal, not a 500.
 */
export async function setLockTimeout(tx: Tx, ms: number): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Number(ms)}`);
}
