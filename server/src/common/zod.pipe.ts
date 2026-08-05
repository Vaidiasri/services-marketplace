import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { ZodError, ZodSchema } from 'zod';
import { Errors } from './errors';

/**
 * Boundary validation. Every schema is `.strict()`, so an unexpected key is a 422
 * rather than being quietly ignored - that is what stops `role`, `roleId`,
 * `priceMinor` or `status` arriving from a request body and being trusted.
 *
 * Answers 422, never 500. The brief: "500 for a validation failure is a fail."
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    try {
      return this.schema.parse(value);
    } catch (e) {
      if (e instanceof ZodError) {
        throw Errors.validationFailed({
          issues: e.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
            code: i.code,
          })),
        });
      }
      throw e;
    }
  }
}

/** `@Body(zodBody(LoginSchema)) dto: LoginDto` reads better than constructing inline. */
export function zodBody(schema: ZodSchema): ZodValidationPipe {
  return new ZodValidationPipe(schema);
}
