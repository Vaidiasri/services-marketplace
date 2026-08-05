import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { PermissionResolver } from '../rbac/permission-resolver.service';

/**
 * Opens the AsyncLocalStorage scope the permission resolver memoises into, so a request
 * touching several guards resolves permissions once.
 *
 * Middleware rather than an interceptor because interceptors run after guards, and the
 * guards are exactly what needs the scope.
 */
@Injectable()
export class RequestScopeMiddleware implements NestMiddleware {
  constructor(private readonly resolver: PermissionResolver) {}

  use(_req: Request, _res: Response, next: NextFunction): void {
    this.resolver.runInRequestScope(() => next());
  }
}
