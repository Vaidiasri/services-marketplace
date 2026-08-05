import type { Prisma } from '@prisma/client';

/**
 * THE definition of "a customer may see this service". Every public read path composes
 * it: list, detail, offerings, and from M5 onward slots and booking creation.
 *
 * One builder rather than the condition written inline four times, because the failure
 * mode of duplication here is not a bug report - it is a draft service, or an unapproved
 * vendor's service, appearing on the public catalogue. Whichever of the four copies is
 * wrong is the one nobody tests.
 *
 * Note it spans two tables: a service is public only if it is PUBLISHED *and* its vendor
 * is APPROVED. Checking only `status` is the subtle version of the same leak - it is
 * exactly what happens when a vendor is approved, publishes, and is later rejected.
 * (VendorsService.reject also suspends live services, so that path is closed twice.)
 */
export function publicServiceWhere(): Prisma.ServiceWhereInput {
  return {
    status: 'PUBLISHED',
    vendorProfile: { status: 'APPROVED' },
  };
}

/**
 * True when a row already loaded satisfies the same rule, for the detail route which has
 * to load the record before it can decide between 200 and 404.
 *
 * Deliberately derived from the same two fields as the builder above so the two cannot
 * drift apart; a second hand-written condition is what the builder exists to prevent.
 */
export function isPubliclyVisible(service: {
  status: string;
  vendorProfile: { status: string };
}): boolean {
  const w = publicServiceWhere();
  return (
    service.status === w.status &&
    service.vendorProfile.status ===
      (w.vendorProfile as { status: string }).status
  );
}
