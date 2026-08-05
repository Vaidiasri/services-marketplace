import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { Errors } from '../common/errors';
import { AccessPayload } from './token.service';

export const IS_PUBLIC = 'isPublic';

/**
 * Marks a route as reachable without a token. Public is opt-IN: a route with neither
 * `@Public()` nor a permission requirement is caught by the route-coverage test rather
 * than silently shipping open.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

export type Caller = { userId: string; roleSlug: string };

declare module 'express' {
  interface Request {
    caller?: Caller;
  }
}

/**
 * Runs before PermissionsGuard and only ever attaches a verified identity. Guard order
 * matters: reversed, PermissionsGuard would see no caller and 401 everything.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);

    const token = bearer(req);

    // A public route still gets its caller attached when a token is present, so the
    // public catalogue can widen results for a signed-in vendor without a second route.
    if (!token) {
      if (isPublic) return true;
      throw Errors.unauthenticated();
    }

    try {
      const payload = await this.jwt.verifyAsync<AccessPayload>(token, {
        // A mildly wrong server clock should not reject a token minted seconds ago.
        clockTolerance: 30,
      });
      req.caller = { userId: payload.sub, roleSlug: payload.roleSlug };
      return true;
    } catch (e) {
      if (isPublic) return true;
      // Distinct codes on purpose: the client refreshes on TOKEN_EXPIRED and logs out
      // on TOKEN_INVALID. One shared code forces it to guess.
      throw (e as Error)?.name === 'TokenExpiredError'
        ? Errors.tokenExpired()
        : Errors.tokenInvalid();
    }
  }
}

function bearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  const token = header.slice(7).trim();
  return token.length ? token : undefined;
}
