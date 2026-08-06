/**
 * The booking state machine and the cancellation policy, both pure, both with no database.
 *
 * The state-machine test is exhaustive over every (from, to, actor) triple rather than
 * spot-checked, so a transition quietly added to the table later fails here rather than
 * being discovered by a customer completing their own booking.
 *
 * Run: npm run test:bookings --workspace=server
 */
import { BookingStatus } from '@prisma/client';
import {
  ACTOR_RULES,
  TRANSITIONS,
  assertTransition,
  isTerminal,
  type Actor,
} from '../src/bookings/state-machine';
import { evaluateCancellation } from '../src/bookings/cancellation-policy';
import { AppError } from '../src/common/errors';

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

const STATUSES = Object.values(BookingStatus);
const ACTORS: Actor[] = ['CUSTOMER', 'VENDOR', 'ADMIN'];

/** Returns the error code, or 'OK' when the transition was permitted. */
function attempt(from: BookingStatus, to: BookingStatus, actor: Actor): string {
  try {
    assertTransition(from, to, actor);
    return 'OK';
  } catch (e) {
    return e instanceof AppError ? e.code : 'UNKNOWN';
  }
}

// ---------------------------------------------------------------- exhaustive table

// 6 statuses x 6 statuses x 3 actors = 108 triples. Every one must produce exactly one of
// three outcomes, and which one is fully determined by the two tables.
let checked = 0;
let mismatches: string[] = [];

for (const from of STATUSES) {
  for (const to of STATUSES) {
    for (const actor of ACTORS) {
      checked++;
      const got = attempt(from, to, actor);
      const legal = TRANSITIONS[from].includes(to);
      const allowedActor = ACTOR_RULES[to].includes(actor);
      const want = !legal ? 'ILLEGAL_TRANSITION' : allowedActor ? 'OK' : 'FORBIDDEN';
      if (got !== want) mismatches.push(`${from}->${to} as ${actor}: got ${got}, want ${want}`);
    }
  }
}

ok(checked === 108, 'all 108 (from, to, actor) triples exercised', checked);
ok(mismatches.length === 0, 'every triple matches the declared tables', mismatches.slice(0, 3).join(' | '));

// ---------------------------------------------------------------- the named cases

// The brief's two DONE WHEN cases, and the reason they are different failures. Note that a
// customer never reaches this code for `complete` in production - the guard refuses them
// with 403 first, for lacking booking.complete. Here the state machine independently agrees.
ok(
  attempt(BookingStatus.PENDING, BookingStatus.COMPLETED, 'VENDOR') === 'ILLEGAL_TRANSITION',
  'a vendor completing a PENDING booking -> ILLEGAL_TRANSITION (422), not a permission failure',
);
ok(
  attempt(BookingStatus.CONFIRMED, BookingStatus.COMPLETED, 'CUSTOMER') === 'FORBIDDEN',
  'a customer completing a CONFIRMED booking -> FORBIDDEN (403), a legal move by the wrong actor',
);

// Legality is checked before the actor, so an impossible move reads as impossible rather
// than hinting at who could make it.
ok(
  attempt(BookingStatus.COMPLETED, BookingStatus.COMPLETED, 'CUSTOMER') === 'ILLEGAL_TRANSITION',
  'an illegal move by the wrong actor reports the illegal move, not the actor',
);

ok(
  attempt(BookingStatus.PENDING, BookingStatus.CANCELLED, 'CUSTOMER') === 'OK',
  'a customer may cancel their PENDING booking',
);
ok(
  attempt(BookingStatus.CONFIRMED, BookingStatus.CANCELLED, 'CUSTOMER') === 'OK',
  'and their CONFIRMED one',
);
ok(
  attempt(BookingStatus.CONFIRMED, BookingStatus.REJECTED, 'VENDOR') === 'ILLEGAL_TRANSITION',
  'reject is PENDING-only - a vendor withdrawing later must cancel, which the policy governs',
);

// ---------------------------------------------------------------- terminal states

for (const terminal of [BookingStatus.COMPLETED, BookingStatus.REJECTED, BookingStatus.CANCELLED, BookingStatus.NO_SHOW]) {
  ok(isTerminal(terminal), `${terminal} is terminal`);
  ok(
    STATUSES.every((to) => attempt(terminal, to, 'ADMIN') === 'ILLEGAL_TRANSITION'),
    `and nothing, not even an admin, moves a ${terminal} booking`,
  );
}
ok(!isTerminal(BookingStatus.PENDING) && !isTerminal(BookingStatus.CONFIRMED), 'PENDING and CONFIRMED are not terminal');

// Nothing may transition INTO pending: it is only ever the state a booking is created in.
ok(
  STATUSES.every((from) => attempt(from, BookingStatus.PENDING, 'ADMIN') === 'ILLEGAL_TRANSITION'),
  'no transition leads back into PENDING',
);

// ---------------------------------------------------------------- cancellation policy

const SERVICE = { freeCancellationHours: 24, cancellationFeePercent: 50 };
const NOW = new Date('2026-08-10T00:00:00Z');
const at = (hoursAhead: number, priceMinor = 200000) =>
  evaluateCancellation(SERVICE, { startUtc: new Date(NOW.getTime() + hoursAhead * 3_600_000), priceMinor }, NOW);

let out = at(48);
ok(!out.isLate && out.feeMinor === 0 && out.refundableMinor === 200000, '48 hours ahead is free and fully refundable', JSON.stringify(out));

// The boundary, from both sides. "Late" is strictly inside the window, so exactly 24 hours
// is still free - the customer who cancels precisely on the line is not charged.
out = at(24);
ok(!out.isLate && out.feeMinor === 0, 'exactly 24 hours ahead is NOT late', JSON.stringify(out));
out = at(24 - 1 / 60);
ok(out.isLate && out.feeMinor === 100000, 'one minute inside the window is late, fee 50%', JSON.stringify(out));
out = at(24 + 1 / 60);
ok(!out.isLate, 'one minute outside it is not', JSON.stringify(out));

out = at(1);
ok(out.isLate && out.feeMinor === 100000 && out.refundableMinor === 100000, 'an hour ahead forfeits half', JSON.stringify(out));

// Already started. Cancelling after the fact is a state-machine question, not a policy one -
// the policy simply reports it as maximally late.
out = at(-2);
ok(out.isLate && out.hoursUntilStart < 0, 'a start already past is late, with negative hours', JSON.stringify(out));

// Rounding happens once, on integers. An odd price with an odd percent is where a float
// pipeline would produce 3333.3333 and then disagree with the ledger.
out = evaluateCancellation(
  { freeCancellationHours: 24, cancellationFeePercent: 33 },
  { startUtc: new Date(NOW.getTime() + 3_600_000), priceMinor: 10001 },
  NOW,
);
ok(
  Number.isInteger(out.feeMinor) && out.feeMinor === 3300 && out.refundableMinor === 6701,
  'the fee is a rounded integer and fee + refundable equals the price exactly',
  JSON.stringify(out),
);

// Policy extremes configured on the service still produce sane money.
out = evaluateCancellation({ freeCancellationHours: 0, cancellationFeePercent: 100 }, { startUtc: new Date(NOW.getTime() - 1), priceMinor: 500 }, NOW);
ok(out.feeMinor === 500 && out.refundableMinor === 0, 'a 100% fee refunds nothing and never goes negative', JSON.stringify(out));
out = evaluateCancellation({ freeCancellationHours: 0, cancellationFeePercent: 50 }, { startUtc: new Date(NOW.getTime() + 60_000), priceMinor: 999 }, NOW);
ok(!out.isLate, 'freeCancellationHours 0 means nothing is ever late', JSON.stringify(out));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
