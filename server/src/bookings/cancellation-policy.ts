/**
 * The cancellation policy, as a pure function.
 *
 * The brief allows either refusing a late cancellation or charging for it. Charging is the
 * kinder behaviour and the one real marketplaces use: a customer with an emergency can
 * always cancel, they just forfeit part of the price.
 */

export type CancellationOutcome = {
  isLate: boolean;
  hoursUntilStart: number;
  feeMinor: number;
  refundableMinor: number;
};

export function evaluateCancellation(
  service: { freeCancellationHours: number; cancellationFeePercent: number },
  booking: { startUtc: Date; priceMinor: number },
  now: Date,
): CancellationOutcome {
  const hoursUntilStart = (booking.startUtc.getTime() - now.getTime()) / 3_600_000;
  const isLate = hoursUntilStart < service.freeCancellationHours;

  // Math.round once, on integers, in one place. Money is in minor units everywhere in this
  // codebase precisely so this is the only rounding decision in the money path - and it is
  // documented rather than left as a mystery for whoever reconciles the ledger.
  const feeMinor = isLate
    ? Math.round((booking.priceMinor * service.cancellationFeePercent) / 100)
    : 0;

  return {
    isLate,
    hoursUntilStart,
    feeMinor,
    // Never negative, even if a service were configured with a percent over 100 - which the
    // DTO caps, but the arithmetic should not depend on validation elsewhere.
    refundableMinor: Math.max(0, booking.priceMinor - feeMinor),
  };
}
