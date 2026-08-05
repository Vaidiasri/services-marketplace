import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Errors } from '../common/errors';
import { PermissionResolver } from './permission-resolver.service';
import { REQUIRED_PERMISSIONS } from './require-permissions.decorator';

/**
 * The single enforcement point. Registered globally, so a route is covered unless it
 * declares nothing - and the route-coverage test fails the build if a non-allowlisted
 * route declares nothing.
 *
 * The client hides what a caller cannot do, but that is cosmetic. This is the enforcement.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: PermissionResolver,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);

    if (!required?.length) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const caller = req.caller;
    if (!caller) throw Errors.unauthenticated();

    if (this.resolver.isSuperAdmin(caller.roleSlug)) return true;

    const held = await this.resolver.getEffectiveSlugs(caller.userId);
    const missing = required.filter((slug) => !held.includes(slug));

    // The missing slugs are returned deliberately. They reveal nothing the API
    // reference does not, and they turn "403, good luck" into an actionable response.
    if (missing.length) throw Errors.forbidden(missing);

    return true;
  }
}
