import { Errors } from '../common/errors';
import type { Caller } from '../auth/jwt-auth.guard';
import { SUPER_ADMIN } from './permission-resolver.service';

/**
 * Ownership is the SECOND gate, checked after permission and separately from it.
 * Holding `service.update` lets a vendor edit their own service, not anyone's.
 *
 * Deliberately helpers rather than a guard: a guard would have to load an arbitrary
 * record from an arbitrary table by id, which means a growing switch statement or a
 * generic loader worse than the thing it replaces.
 */

export type OwnedRecord = {
  customerUserId?: string | null;
  vendorProfileId?: string | null;
  userId?: string | null;
};

/**
 * For list endpoints. Merges the ownership predicate into the Prisma `where` BEFORE the
 * query runs.
 *
 * Filtering after the fetch is never done anywhere: the paginated total is computed from
 * the same where clause, so post-filtering would leak the real row count even while
 * hiding the rows.
 */
export function scopeToCaller<W extends Record<string, unknown>>(
  where: W,
  caller: Caller,
  scope: { readAll: boolean; customerField?: string; vendorProfileId?: string | null },
): W {
  if (caller.roleSlug === SUPER_ADMIN || scope.readAll) return where;

  if (scope.vendorProfileId) {
    return { ...where, vendorProfileId: scope.vendorProfileId };
  }
  if (scope.customerField) {
    return { ...where, [scope.customerField]: caller.userId };
  }
  // No ownership dimension resolved and no read_all: return nothing rather than
  // everything. Failing closed is the only safe default here.
  return { ...where, id: '__no_access__' };
}

/**
 * For detail and mutation endpoints. Load the record, then assert.
 *
 * `notFoundOnMismatch` answers 404 instead of 403 for confidential resources, which is
 * what the brief's "Vendor A requesting Vendor B's booking gets 403 or 404, never the
 * record" allows - 404 additionally avoids confirming the id exists.
 */
export function assertOwnership(
  record: OwnedRecord,
  caller: Caller,
  opts: {
    readAll?: boolean;
    vendorProfileId?: string | null;
    notFoundOnMismatch?: boolean;
    what?: string;
  } = {},
): void {
  if (caller.roleSlug === SUPER_ADMIN || opts.readAll) return;

  const ownedByCustomer =
    record.customerUserId != null && record.customerUserId === caller.userId;
  const ownedByUser = record.userId != null && record.userId === caller.userId;
  const ownedByVendor =
    record.vendorProfileId != null &&
    opts.vendorProfileId != null &&
    record.vendorProfileId === opts.vendorProfileId;

  if (ownedByCustomer || ownedByUser || ownedByVendor) return;

  throw opts.notFoundOnMismatch === false
    ? Errors.forbidden([])
    : Errors.notFound(opts.what ?? 'Resource');
}
