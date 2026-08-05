import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ApiErrorBody } from './errors';

/**
 * Single exit point for every error, so no route can answer in a shape the client
 * has not been written against.
 *
 * Two things it exists to prevent, both on the brief's deduction list:
 * - a validation failure surfacing as 500
 * - a Prisma constraint error leaking table and column names to the caller
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = randomUUID();

    const { status, code, message, details } = this.classify(exception);

    // 5xx is our bug, so log the stack. 4xx is the caller's, so log one line -
    // otherwise a scripted 403 probe fills the log with stack traces.
    if (status >= 500) {
      this.logger.error(`${req.method} ${req.url} -> ${status} ${code} [${requestId}]`, exception);
    } else {
      this.logger.warn(`${req.method} ${req.url} -> ${status} ${code} [${requestId}]`);
    }

    const body: ApiErrorBody = { error: { code, message, details, requestId } };
    if (details === undefined) delete body.error.details;

    res.status(status).json(body);
  }

  private classify(e: unknown): {
    status: number;
    code: string;
    message: string;
    details?: unknown;
  } {
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const r = e.getResponse();

      // Thrown by AppError: already carries our code and details.
      if (typeof r === 'object' && r !== null && 'code' in r) {
        const o = r as { code: string; message: string; details?: unknown };
        return { status, code: o.code, message: o.message, details: o.details };
      }

      // Nest's own exceptions (404 from an unmatched route, 413, etc).
      const message =
        typeof r === 'string'
          ? r
          : ((r as { message?: string | string[] })?.message?.toString() ?? e.message);
      return { status, code: this.codeForStatus(status), message };
    }

    // Reaching here with a Prisma error means a service failed to translate it.
    // Answer honestly with a 500 but never echo the driver's message, which
    // contains table and column names.
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      this.logger.error(`untranslated prisma error ${e.code}`, e.message);
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong.',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong.',
    };
  }

  private codeForStatus(status: number): string {
    const map: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHENTICATED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      // Nest's multer interceptor maps LIMIT_FILE_SIZE to PayloadTooLargeException, so
      // an oversized upload arrives here as a bare 413 with no code of its own.
      413: 'FILE_TOO_LARGE',
      422: 'VALIDATION_FAILED',
      429: 'RATE_LIMITED',
    };
    return map[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'ERROR');
  }
}
