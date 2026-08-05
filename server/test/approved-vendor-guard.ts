/**
 * Unit test for the third gate's five branches.
 *
 * A unit test rather than an integration test because no route carries
 * @RequireApprovedVendor() yet - its real targets are M4's publish and offering routes
 * and M6's booking actions. Inventing a placeholder route to test against would ship
 * dead code that the route-coverage test then has to account for, so the branches are
 * asserted directly and the integration test lands in M4 with the first real route.
 *
 * Run: npm run test:guard --workspace=server
 */
import 'reflect-metadata';
import { ApprovedVendorGuard } from '../src/vendors/approved-vendor.guard';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${extra !== undefined ? `  <- ${String(extra)}` : ''}`);
  }
};

type Profile = { id: string; status: string; rejectionReason: string | null } | null;

function makeGuard(required: boolean, profile: Profile) {
  const reflector = {
    getAllAndOverride: () => required,
  } as unknown as Reflector;

  const prisma = {
    vendorProfile: { findUnique: async () => profile },
  } as unknown as PrismaService;

  return new ApprovedVendorGuard(reflector, prisma);
}

function makeCtx(caller: { userId: string; roleSlug: string } | undefined) {
  const req: Record<string, unknown> = { caller };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
    __req: req,
  } as unknown as ExecutionContext & { __req: Record<string, unknown> };
}

async function outcome(
  required: boolean,
  profile: Profile,
  caller: { userId: string; roleSlug: string } | undefined,
): Promise<{ allowed: boolean; code?: string; details?: unknown; req: Record<string, unknown> }> {
  const ctx = makeCtx(caller) as ExecutionContext & { __req: Record<string, unknown> };
  try {
    const allowed = await makeGuard(required, profile).canActivate(ctx);
    return { allowed, req: ctx.__req };
  } catch (e) {
    const res = (e as { getResponse?: () => unknown }).getResponse?.() as
      | { code?: string; details?: unknown }
      | undefined;
    return { allowed: false, code: res?.code, details: res?.details, req: ctx.__req };
  }
}

const VENDOR = { userId: 'u1', roleSlug: 'VENDOR' };
const APPROVED: Profile = { id: 'p1', status: 'APPROVED', rejectionReason: null };
const PENDING: Profile = { id: 'p1', status: 'PENDING', rejectionReason: null };
const REJECTED: Profile = { id: 'p1', status: 'REJECTED', rejectionReason: 'Docs unreadable' };

void (async () => {
  // 1. Decorator absent - the guard must not run at all, even for a pending vendor.
  let r = await outcome(false, PENDING, VENDOR);
  ok(r.allowed, 'no @RequireApprovedVendor -> allowed regardless of status');

  // 2. Super admin bypass. An admin acting on a vendor's behalf is not blocked by that
  //    vendor's status, and is not required to have a profile of their own.
  r = await outcome(true, null, { userId: 'admin', roleSlug: 'SUPER_ADMIN' });
  ok(r.allowed, 'SUPER_ADMIN bypasses even with no vendor profile');

  // 3. No profile at all.
  r = await outcome(true, null, VENDOR);
  ok(!r.allowed && r.code === 'NOT_A_VENDOR', 'no vendor profile -> NOT_A_VENDOR', r.code);

  // 4. Pending.
  r = await outcome(true, PENDING, VENDOR);
  ok(
    !r.allowed && r.code === 'VENDOR_PENDING_APPROVAL',
    'PENDING -> VENDOR_PENDING_APPROVAL',
    r.code,
  );

  // 5. Rejected, and the reason must travel so the client can show it inline.
  r = await outcome(true, REJECTED, VENDOR);
  ok(!r.allowed && r.code === 'VENDOR_REJECTED', 'REJECTED -> VENDOR_REJECTED', r.code);
  ok(
    (r.details as { reason?: string })?.reason === 'Docs unreadable',
    'and carries the rejection reason in details',
    JSON.stringify(r.details),
  );

  // 6. Approved.
  r = await outcome(true, APPROVED, VENDOR);
  ok(r.allowed, 'APPROVED -> allowed');
  ok(
    r.req.vendorProfileId === 'p1',
    'and caches vendorProfileId on the request so services need no second lookup',
    r.req.vendorProfileId,
  );

  // 7. No caller at all. Should never happen behind JwtAuthGuard, but a guard that
  //    silently allows an unauthenticated request is the worst possible failure mode.
  r = await outcome(true, APPROVED, undefined);
  ok(!r.allowed && r.code === 'UNAUTHENTICATED', 'no caller -> UNAUTHENTICATED, never allowed', r.code);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
