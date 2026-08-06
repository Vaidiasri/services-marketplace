import { Body, Controller, Get, Param, Patch, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Errors } from '../common/errors';
import { zodBody } from '../common/zod.pipe';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { BookingsService } from './bookings.service';
import {
  AdminBookingQuerySchema,
  ReasonRequiredSchema,
  type AdminBookingQuery,
  type ReasonRequiredDto,
} from './bookings.dto';

@Controller('admin/bookings')
export class AdminBookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get()
  @RequirePermissions('booking.read_all')
  list(@Query(zodBody(AdminBookingQuerySchema)) query: AdminBookingQuery) {
    return this.bookings.listForAdmin(query);
  }

  /**
   * A separate permission from `booking.cancel`, held only by admins, because this bypasses
   * the cancellation window and refunds in full. A vendor with `booking.cancel` reaching this
   * route would be able to waive every fee they dislike.
   */
  @Patch(':id/force-cancel')
  @RequirePermissions('booking.force_cancel')
  forceCancel(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(zodBody(ReasonRequiredSchema)) dto: ReasonRequiredDto,
  ) {
    if (!req.caller) throw Errors.unauthenticated();
    return this.bookings.forceCancel(req.caller, id, dto.reason);
  }
}
