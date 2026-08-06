import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { Errors } from '../common/errors';
import { Public } from '../auth/jwt-auth.guard';
import { zodBody } from '../common/zod.pipe';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { RequireApprovedVendor } from '../vendors/require-approved-vendor.decorator';
import { PaymentsService } from './payments.service';
import { MOCK_TOKENS } from './mock-payment.provider';

const ConfirmSchema = z
  .object({
    // Defaults to success so the happy path needs no token. The other values are the mock's
    // deterministic outcomes - see the token table in the README.
    token: z.string().trim().min(1).max(64).default(MOCK_TOKENS.SUCCESS),
  })
  .strict();

const RefundSchema = z.object({ amountMinor: z.number().int().min(1).optional() }).strict();

@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /**
   * Idempotency-Key is required for the same reason as booking creation: this is the request
   * that moves money, and a client that times out and retries must not charge twice. The
   * replay is answered before the provider is called at all.
   */
  @Post('payments/:id/confirm')
  @RequirePermissions('payment.initiate')
  @HttpCode(200)
  confirm(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(zodBody(ConfirmSchema)) dto: { token: string },
    @Headers('idempotency-key') key: string | undefined,
  ) {
    if (!req.caller) throw Errors.unauthenticated();
    if (!key?.trim()) throw Errors.idempotencyKeyRequired();
    return this.payments.confirm(req.caller, id, dto.token, key.trim());
  }

  @Get('payments/:id')
  @RequirePermissions('payment.read')
  get(@Req() req: Request, @Param('id') id: string) {
    if (!req.caller) throw Errors.unauthenticated();
    return this.payments.getOne(req.caller, id);
  }

  @Get('bookings/:id/payments')
  @RequirePermissions('payment.read')
  forBooking(@Req() req: Request, @Param('id') id: string) {
    if (!req.caller) throw Errors.unauthenticated();
    return this.payments.forBooking(req.caller, id);
  }

  /** Admin-initiated. Refunds that follow a cancellation happen inside cancel, automatically. */
  @Post('payments/bookings/:id/refund')
  @RequirePermissions('payment.refund')
  @HttpCode(200)
  refund(@Param('id') bookingId: string, @Body(zodBody(RefundSchema)) dto: { amountMinor?: number }) {
    return this.payments.refund(bookingId, dto.amountMinor);
  }

  /** The PAY_AFTER settlement path: cash taken at the appointment. */
  @Patch('bookings/:id/mark-collected')
  @RequirePermissions('payment.mark_collected')
  @RequireApprovedVendor()
  markCollected(@Req() req: Request, @Param('id') id: string) {
    if (!req.vendorProfileId) throw Errors.notAVendor();
    return this.payments.markCollected(req.vendorProfileId, id);
  }
}

/**
 * Separate controller because it needs the RAW body for HMAC verification, and because it is
 * the only public write endpoint in the application.
 *
 * `@Public()` here is not a hole: the signature IS the authentication. An unsigned or
 * wrongly-signed delivery is refused with 401 before anything is read from it.
 */
@Controller('payments')
export class WebhookController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('webhook')
  @Public()
  @HttpCode(200)
  webhook(@Req() req: Request, @Headers('x-mock-signature') signature: string | undefined) {
    // main.ts keeps the raw buffer on this route; a re-serialised object would not reproduce
    // the provider's bytes and every signature would fail.
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!raw) throw Errors.validationFailed({ body: 'Raw body unavailable' });
    return this.payments.handleWebhook(raw, signature);
  }
}
