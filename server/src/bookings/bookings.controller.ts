import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Errors } from '../common/errors';
import { zodBody } from '../common/zod.pipe';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { RequireApprovedVendor } from '../vendors/require-approved-vendor.decorator';
import { BookingsService } from './bookings.service';
import {
  BookingQuerySchema,
  CancelSchema,
  CreateBookingSchema,
  ReasonRequiredSchema,
  RescheduleSchema,
  type BookingQuery,
  type CancelDto,
  type CreateBookingDto,
  type ReasonRequiredDto,
  type RescheduleDto,
} from './bookings.dto';

@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  /**
   * The Idempotency-Key header is REQUIRED, not optional.
   *
   * A booking is a payment-bearing write over an unreliable network: a client that times out
   * and retries must not create a second booking and consume a second seat. Making the header
   * optional means the safe path is the one clients forget.
   */
  @Post()
  @RequirePermissions('booking.create')
  @HttpCode(201)
  create(
    @Req() req: Request,
    @Body(zodBody(CreateBookingSchema)) dto: CreateBookingDto,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    if (!key?.trim()) throw Errors.idempotencyKeyRequired();
    return this.bookings.create(caller(req), dto, key.trim());
  }

  @Get()
  @RequirePermissions('booking.read')
  list(@Req() req: Request, @Query(zodBody(BookingQuerySchema)) query: BookingQuery) {
    return this.bookings.list(caller(req), query);
  }

  @Get(':id')
  @RequirePermissions('booking.read')
  get(@Req() req: Request, @Param('id') id: string) {
    return this.bookings.getOne(caller(req), id);
  }

  // ---------------------------------------------------------------- vendor transitions
  // Each carries its own permission, so a customer calling complete is refused by the guard
  // with 403 before the state machine runs. A vendor calling it on a PENDING booking reaches
  // the state machine and gets 422. The brief tests both, and they are different failures.

  @Patch(':id/confirm')
  @RequirePermissions('booking.confirm')
  @RequireApprovedVendor()
  confirm(@Req() req: Request, @Param('id') id: string) {
    return this.bookings.confirm(caller(req), vendorId(req), id);
  }

  @Patch(':id/reject')
  @RequirePermissions('booking.reject')
  @RequireApprovedVendor()
  reject(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(zodBody(ReasonRequiredSchema)) dto: ReasonRequiredDto,
  ) {
    return this.bookings.reject(caller(req), vendorId(req), id, dto.reason);
  }

  @Patch(':id/complete')
  @RequirePermissions('booking.complete')
  @RequireApprovedVendor()
  complete(@Req() req: Request, @Param('id') id: string) {
    return this.bookings.complete(caller(req), vendorId(req), id);
  }

  @Patch(':id/no-show')
  @RequirePermissions('booking.no_show')
  @RequireApprovedVendor()
  noShow(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(zodBody(ReasonRequiredSchema)) dto: ReasonRequiredDto,
  ) {
    return this.bookings.noShow(caller(req), vendorId(req), id, dto.reason);
  }

  // ---------------------------------------------------------------- customer or vendor

  /**
   * No @RequireApprovedVendor: a customer holds `booking.cancel` too, and the actor is
   * resolved from the caller's relationship to the booking rather than from their role.
   */
  @Patch(':id/cancel')
  @RequirePermissions('booking.cancel')
  cancel(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(zodBody(CancelSchema)) dto: CancelDto,
  ) {
    return this.bookings.cancel(caller(req), id, dto.reason);
  }

  @Patch(':id/reschedule')
  @RequirePermissions('booking.reschedule')
  reschedule(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(zodBody(RescheduleSchema)) dto: RescheduleDto,
  ) {
    return this.bookings.reschedule(caller(req), id, dto);
  }
}

function caller(req: Request) {
  if (!req.caller) throw Errors.unauthenticated();
  return req.caller;
}

function vendorId(req: Request): string {
  if (!req.vendorProfileId) throw Errors.notAVendor();
  return req.vendorProfileId;
}
