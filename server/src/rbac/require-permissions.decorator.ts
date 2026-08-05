import { SetMetadata } from '@nestjs/common';

export const REQUIRED_PERMISSIONS = 'requiredPermissions';

/**
 * Declares what a route needs. The check is AND: every listed slug must be held.
 * A route that should accept either of two permissions declares the narrower one and
 * branches in the service, so the guard stays a single unambiguous rule.
 */
export const RequirePermissions = (
  ...slugs: string[]
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_PERMISSIONS, slugs);
