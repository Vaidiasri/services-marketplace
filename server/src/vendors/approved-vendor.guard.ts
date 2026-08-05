import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Errors } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { SUPER_ADMIN } from '../rbac/permission-resolver.service';
import { REQUIRE_APPROVED_VENDOR } from './require-approved-vendor.decorator';

/**
 * Runs after PermissionsGuard, so by the time it executes the caller has already been
 * authenticated and shown to hold the route's permission. This answers only the third
 * question: is this vendor allowed to act yet.
 */
@Injectable()
export class ApprovedVendorGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_APPROVED_VENDOR, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const caller = req.caller;
    if (!caller) throw Errors.unauthenticated();

    // An admin acting on a vendor's behalf must not be blocked by that vendor's status.
    if (caller.roleSlug === SUPER_ADMIN) return true;

    const profile = await this.prisma.vendorProfile.findUnique({
      where: { userId: caller.userId },
      select: { id: true, status: true, rejectionReason: true },
    });

    if (!profile) throw Errors.notAVendor();

    switch (profile.status) {
      case 'APPROVED':
        // Cached on the request so the service layer can scope ownership queries without
        // a second lookup for the same profile.
        req.vendorProfileId = profile.id;
        return true;
      case 'PENDING':
        throw Errors.vendorPending();
      case 'REJECTED':
        // The reason travels in details so the client can show it inline rather than
        // making the vendor go looking for it.
        throw Errors.vendorRejected(profile.rejectionReason);
    }
  }
}
