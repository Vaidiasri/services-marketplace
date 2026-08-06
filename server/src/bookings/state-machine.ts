import { BookingStatus } from '@prisma/client';
import { Errors } from '../common/errors';

/**
 * The booking state machine, as data.
 *
 * One table plus one actor table, and a single `assertTransition` call at the top of every
 * mutation. The alternative - `if (status === 'PENDING')` chains inside each service method -
 * is how a state machine ends up with six slightly different opinions about what CONFIRMED
 * can become, none of them written down.
 */

export type Actor = 'CUSTOMER' | 'VENDOR' | 'ADMIN';

/** Terminal states have an empty list, which is the whole reason they are terminal. */
export const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  PENDING: [BookingStatus.CONFIRMED, BookingStatus.REJECTED, BookingStatus.CANCELLED],
  CONFIRMED: [BookingStatus.COMPLETED, BookingStatus.CANCELLED, BookingStatus.NO_SHOW],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

/**
 * Who may perform a legal transition. Deliberately separate from the permission check.
 *
 * A customer holds no `booking.complete` permission, so the guard refuses them with 403
 * before this table is consulted. This table catches the other half: a vendor who holds
 * `booking.complete` calling it on a PENDING booking is a legal actor making an illegal
 * move, which is 422. The brief tests both, and they are genuinely different failures.
 */
export const ACTOR_RULES: Record<BookingStatus, Actor[]> = {
  CONFIRMED: ['VENDOR', 'ADMIN'],
  REJECTED: ['VENDOR', 'ADMIN'],
  COMPLETED: ['VENDOR', 'ADMIN'],
  NO_SHOW: ['VENDOR', 'ADMIN'],
  // The only transition a customer may drive. Vendors may cancel too - a vendor who cannot
  // make an appointment needs a route that is not "reject", which is PENDING-only.
  CANCELLED: ['CUSTOMER', 'VENDOR', 'ADMIN'],
  PENDING: [],
};

export function isTerminal(status: BookingStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/**
 * Throws 422 for an illegal move and 403 for a legal move by the wrong actor.
 *
 * The order matters: legality is checked first, so a customer calling complete on a
 * COMPLETED booking is told the move is illegal rather than that they are the wrong actor.
 * Both are true; the illegal move is the more useful answer and does not reveal who could.
 */
export function assertTransition(
  from: BookingStatus,
  to: BookingStatus,
  actor: Actor,
): void {
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) throw Errors.illegalTransition(from, to, allowed);

  if (!ACTOR_RULES[to].includes(actor)) {
    throw Errors.forbidden([`${to.toLowerCase()} requires ${ACTOR_RULES[to].join(' or ')}`]);
  }
}
