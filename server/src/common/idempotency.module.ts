import { Global, Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';

/**
 * Global because both BookingsModule and PaymentsModule need it, and BookingsModule already
 * imports PaymentsModule to refund on cancellation. Owning it in either one would close that
 * into a dependency cycle for a service that has no business belonging to either.
 */
@Global()
@Module({ providers: [IdempotencyService], exports: [IdempotencyService] })
export class IdempotencyModule {}
