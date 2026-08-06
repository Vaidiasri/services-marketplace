import { Module } from '@nestjs/common';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';

/**
 * Exports the service because M6 needs to generate slots inside its own booking
 * transaction - the generator itself is a pure function, so M6 can also call it directly
 * with rows it already holds.
 */
@Module({
  controllers: [AvailabilityController],
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
