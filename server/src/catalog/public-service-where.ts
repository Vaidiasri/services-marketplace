import type { Prisma } from '@prisma/client';
import type { Caller } from '../auth/jwt-auth.guard';
import type { PermissionResolver } from '../rbac/permission-resolver.service';
import { SUPER_ADMIN } from '../rbac/permission-resolver.service';

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

/**
 * Whether a caller may see a service that is NOT publicly visible - its owner, or an admin
 * holding `service.read_all`.
 *
 * Lives here beside the visibility rule because it is the other half of the same decision,
 * and because the catalogue, offerings and availability modules all need it. Written out
 * three times it would eventually be three slightly different answers to one question.
 *
 * Not a guard: it does not decide whether the route runs, only whether a hidden row is
 * visible through it, and the answer must be 404 rather than 403 - a 403 would confirm the
 * id exists.
 */
export async function canSeeHiddenService(
  ownerUserId: string,
  caller: Caller | undefined,
  permissions: PermissionResolver,
): Promise<boolean> {
  if (!caller) return false;
  if (caller.userId === ownerUserId) return true;
  if (caller.roleSlug === SUPER_ADMIN) return true;
  return (await permissions.getEffectiveSlugs(caller.userId)).includes('service.read_all');
}
