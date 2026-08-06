import { Module } from '@nestjs/common';
import { AdminBookingsController } from './admin-bookings.controller';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { IdempotencyService } from './idempotency.service';

/** IdempotencyService is exported because M7's payment confirm replays on the same table. */
@Module({
  controllers: [BookingsController, AdminBookingsController],
  providers: [BookingsService, IdempotencyService],
  exports: [BookingsService, IdempotencyService],
})
export class BookingsModule {}
