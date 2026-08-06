import { Inject, Injectable, Logger } from '@nestjs/common';
import { BookingStatus, LedgerEntryType, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Errors } from '../common/errors';
import type { Caller } from '../auth/jwt-auth.guard';
import { IdempotencyService } from '../common/idempotency.service';
import { SUPER_ADMIN } from '../rbac/permission-resolver.service';
import { releaseCells, type Tx } from '../bookings/capacity.repository';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type ProviderResult,
} from './payment-provider.port';

const PAYMENT_SELECT = {
  id: true,
  bookingId: true,
  amountMinor: true,
  currency: true,
  status: true,
  mode: true,
  providerRef: true,
  failureReason: true,
  createdAt: true,
} satisfies Prisma.PaymentSelect;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  // ---------------------------------------------------------------- confirm

  /**
   * Two steps - create the booking, then confirm its payment - mirroring how a real gateway's
   * intent-then-confirm works, so the shape survives replacing the mock.
   */
  async confirm(caller: Caller, paymentId: string, token: string, idempotencyKey: string) {
    const replay = await this.idempotency.check(caller.userId, 'payment.confirm', idempotencyKey, { paymentId, token });
    // Returned BEFORE the provider is called, so a retry never charges twice.
    if (replay) return { replayed: true, ...(replay.responseBody as object) };

    const payment = await this.loadOwned(caller, paymentId);
    if (payment.status !== PaymentStatus.INITIATED) {
      throw Errors.paymentNotPending(payment.status);
    }

    // The provider call happens OUTSIDE the transaction. A network round trip with an open
    // transaction holds a database connection for its whole duration; with a real gateway
    // that is how connection pools die. The mock is instant, but the structure has to be the
    // one that still works when it is not.
    const result = await this.provider.initiate({
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      token,
      reference: payment.booking.reference,
    });

    return this.prisma.$transaction(async (tx) => {
      const applied = await this.applyOutcome(tx, payment.id, result);
      await this.idempotency.record(tx, caller.userId, 'payment.confirm', idempotencyKey, { paymentId, token }, 200, applied);
      return applied;
    });
  }

  // ---------------------------------------------------------------- webhook

  /**
   * Dedupe is the unique index on `WebhookEvent.eventId`, never a read of the payment's
   * status. Status-checking looks equivalent and races: two simultaneous deliveries both read
   * INITIATED and both apply. Here the second INSERT fails, and that failure IS the dedupe.
   *
   * The event row and the effect are in ONE transaction, which is what makes a double
   * delivery genuinely inert - either both land or neither does.
   */
  async handleWebhook(rawBody: Buffer, signature: string | undefined) {
    if (!this.provider.verifyWebhook(rawBody, signature)) throw Errors.webhookSignatureInvalid();

    const event = this.provider.parseWebhook(rawBody);
    if (!event) throw Errors.validationFailed({ body: 'Unrecognised webhook payload' });

    try {
      return await this.prisma.$transaction(async (tx) => {
        // This INSERT is the dedupe. It comes first so a duplicate delivery fails here,
        // before anything is applied.
        await tx.webhookEvent.create({
          data: {
            eventId: event.eventId,
            type: `payment.${event.outcome.toLowerCase()}`,
            payload: JSON.parse(rawBody.toString('utf8')) as Prisma.InputJsonValue,
          },
        });

        const payment = await tx.payment.findFirst({
          where: { providerRef: event.providerRef },
          select: { id: true, status: true },
        });

        // An event for a payment we do not have is still recorded and acknowledged. Returning
        // an error would make a real provider retry it forever.
        if (!payment) {
          this.logger.warn(`webhook for unknown providerRef ${event.providerRef}`);
          return { received: true, applied: false, reason: 'unknown_payment' };
        }
        // Late webhooks after a terminal state are normal, not an error.
        if (payment.status !== PaymentStatus.INITIATED) {
          return { received: true, applied: false, reason: 'already_settled' };
        }

        const applied = await this.applyOutcome(tx, payment.id, {
          providerRef: event.providerRef,
          outcome: event.outcome,
          failureReason: event.outcome === 'FAILED' ? 'declined_by_provider' : undefined,
        });
        return { received: true, applied: true, payment: applied.payment };
      });
    } catch (e) {
      // P2002 on eventId: this delivery is a duplicate. A duplicate is a SUCCESS from the
      // provider's point of view, so 200 with nothing changed.
      if ((e as { code?: string })?.code === 'P2002') {
        return { received: true, applied: false, reason: 'duplicate_event' };
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------- the shared effect

  /**
   * The one place a provider outcome becomes state, shared by confirm and the webhook so both
   * paths produce byte-identical results. Two implementations would drift, and the drift
   * would only show up as a booking whose payment says one thing and whose status says another.
   */
  private async applyOutcome(tx: Tx, paymentId: string, result: ProviderResult) {
    if (result.outcome === 'PENDING') {
      const payment = await tx.payment.update({
        where: { id: paymentId },
        data: { providerRef: result.providerRef },
        select: PAYMENT_SELECT,
      });
      return { payment, booking: null, outcome: 'PENDING' as const };
    }

    if (result.outcome === 'SUCCESS') {
      const payment = await tx.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.SUCCESS, providerRef: result.providerRef, failureReason: null },
        select: PAYMENT_SELECT,
      });
      await this.append(tx, payment.bookingId, payment.id, LedgerEntryType.CHARGE, payment.amountMinor);
      // The booking stays PENDING. Payment succeeding does not confirm an appointment -
      // that is still the vendor's decision, now unblocked.
      return { payment, booking: null, outcome: 'SUCCESS' as const };
    }

    // FAILED. The booking is cancelled and its cells released in this same transaction.
    //
    // Leaving it PENDING with released cells would mean a booking exists whose seat is gone,
    // so a vendor could confirm an appointment with no capacity behind it. Cancelling is the
    // honest state and it is what makes "a failed payment leaves the slot bookable by someone
    // else" actually true.
    const payment = await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: PaymentStatus.FAILED,
        providerRef: result.providerRef,
        failureReason: result.failureReason ?? 'payment_failed',
      },
      select: PAYMENT_SELECT,
    });

    const booking = await tx.booking.findUnique({
      where: { id: payment.bookingId },
      select: { id: true, status: true, slotCells: { select: { slotCellId: true } } },
    });

    if (booking && (booking.status === BookingStatus.PENDING || booking.status === BookingStatus.CONFIRMED)) {
      await releaseCells(tx, booking.slotCells.map((c) => c.slotCellId));
      await tx.bookingSlotCell.deleteMany({ where: { bookingId: booking.id } });

      const updated = await tx.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.CANCELLED, cancelReason: `payment failed: ${payment.failureReason}` },
        select: { id: true, status: true, cancelReason: true },
      });
      await tx.bookingStatusHistory.create({
        data: {
          bookingId: booking.id,
          fromStatus: booking.status,
          toStatus: BookingStatus.CANCELLED,
          actorUserId: null,
          reason: `payment failed: ${payment.failureReason}`,
        },
      });
      return { payment, booking: updated, outcome: 'FAILED' as const };
    }

    return { payment, booking: null, outcome: 'FAILED' as const };
  }

  // ---------------------------------------------------------------- refunds

  /**
   * Called by M6's cancel and by the admin refund route. The provider call happens before any
   * transaction opens, for the same reason as confirm.
   *
   * Returns null when there is nothing to refund, which is the normal case for PAY_AFTER and
   * for a booking cancelled before it was ever paid.
   */
  async refundForBooking(bookingId: string, refundableMinor: number) {
    if (refundableMinor <= 0) return null;

    const payment = await this.prisma.payment.findFirst({
      where: { bookingId, status: PaymentStatus.SUCCESS },
      select: { id: true, providerRef: true, amountMinor: true },
    });
    if (!payment?.providerRef) return null;

    const result = await this.provider.refund({
      providerRef: payment.providerRef,
      amountMinor: refundableMinor,
    });

    return this.prisma.$transaction(async (tx) => {
      if (result.outcome === 'FAILED') {
        // The refund failed at the provider. The payment stays SUCCESS - the money really was
        // taken - and the failure is recorded rather than swallowed, because a silent failure
        // here is money a customer never gets back and nobody notices.
        const failed = await tx.payment.update({
          where: { id: payment.id },
          data: { failureReason: result.failureReason ?? 'refund_failed' },
          select: PAYMENT_SELECT,
        });
        this.logger.error(`refund failed for booking ${bookingId}: ${result.failureReason}`);
        return { refunded: false, payment: failed, reason: result.failureReason };
      }

      const refunded = await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.REFUNDED },
        select: PAYMENT_SELECT,
      });
      // Negative, because the ledger is append-only and sums to the net position. Nothing in
      // it is ever updated or deleted.
      await this.append(tx, bookingId, payment.id, LedgerEntryType.REFUND, -refundableMinor);
      return { refunded: true, payment: refunded, amountMinor: refundableMinor };
    });
  }

  /** Admin-initiated manual refund, outside the cancellation path. */
  async refund(bookingId: string, amountMinor?: number) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, priceMinor: true, cancellationFeeMinor: true },
    });
    if (!booking) throw Errors.notFound('Booking');

    const amount = amountMinor ?? booking.priceMinor - booking.cancellationFeeMinor;
    const result = await this.refundForBooking(bookingId, amount);
    if (!result) throw Errors.nothingToRefund();
    return result;
  }

  // ---------------------------------------------------------------- PAY_AFTER

  /**
   * The PAY_AFTER completion path: the vendor took cash at the appointment. There is no
   * Payment row, because no gateway was involved - only a ledger entry, which is what the
   * admin revenue figure is summed from.
   */
  async markCollected(vendorProfileId: string, bookingId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, vendorProfileId },
      select: { id: true, paymentMode: true, priceMinor: true, cancellationFeeMinor: true },
    });
    if (!booking) throw Errors.notFound('Booking');
    if (booking.paymentMode !== 'PAY_AFTER') throw Errors.notPayAfter();

    const already = await this.prisma.ledgerEntry.findFirst({
      where: { bookingId, type: LedgerEntryType.CASH_COLLECTED },
      select: { id: true },
    });
    // Idempotent without a key: collecting cash twice is a double-click, not a second payment.
    if (already) return { collected: true, alreadyRecorded: true };

    await this.prisma.ledgerEntry.create({
      data: { bookingId, type: LedgerEntryType.CASH_COLLECTED, amountMinor: booking.priceMinor },
    });
    return { collected: true, amountMinor: booking.priceMinor };
  }

  // ---------------------------------------------------------------- reads

  async getOne(caller: Caller, paymentId: string) {
    const payment = await this.loadOwned(caller, paymentId);
    return { ...payment, booking: undefined, bookingId: payment.bookingId };
  }

  /**
   * Payments, the ledger, and what is still owed. `outstandingMinor` is derived from the
   * ledger rather than stored, so it cannot disagree with the rows it is computed from.
   */
  async forBooking(caller: Caller, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        priceMinor: true,
        cancellationFeeMinor: true,
        status: true,
        paymentMode: true,
        customerUserId: true,
        vendorProfileId: true,
      },
    });
    if (!booking) throw Errors.notFound('Booking');
    await this.assertCanSee(caller, booking);

    const [payments, ledger] = await Promise.all([
      this.prisma.payment.findMany({ where: { bookingId }, select: PAYMENT_SELECT, orderBy: { createdAt: 'asc' } }),
      this.prisma.ledgerEntry.findMany({
        where: { bookingId },
        select: { id: true, type: true, amountMinor: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const settled = ledger.reduce((sum, e) => sum + e.amountMinor, 0);
    const owed = booking.status === BookingStatus.CANCELLED ? booking.cancellationFeeMinor : booking.priceMinor;

    return {
      bookingId,
      priceMinor: booking.priceMinor,
      cancellationFeeMinor: booking.cancellationFeeMinor,
      settledMinor: settled,
      outstandingMinor: Math.max(0, owed - settled),
      payments,
      ledger,
    };
  }

  // ---------------------------------------------------------------- internals

  /** Append-only. Nothing in the ledger is ever updated or deleted. */
  private append(tx: Tx, bookingId: string, paymentId: string | null, type: LedgerEntryType, amountMinor: number) {
    return tx.ledgerEntry.create({ data: { bookingId, paymentId, type, amountMinor } });
  }

  private async loadOwned(caller: Caller, paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        ...PAYMENT_SELECT,
        booking: {
          select: { id: true, reference: true, customerUserId: true, vendorProfileId: true },
        },
      },
    });
    if (!payment) throw Errors.notFound('Payment');
    await this.assertCanSee(caller, payment.booking);
    return payment;
  }

  /** 404 rather than 403, so a payment id cannot be used to confirm a booking exists. */
  private async assertCanSee(
    caller: Caller,
    booking: { customerUserId: string; vendorProfileId: string },
  ): Promise<void> {
    if (booking.customerUserId === caller.userId) return;
    if (caller.roleSlug === SUPER_ADMIN) return;

    const profile = await this.prisma.vendorProfile.findUnique({
      where: { userId: caller.userId },
      select: { id: true },
    });
    if (profile?.id === booking.vendorProfileId) return;

    throw Errors.notFound('Payment');
  }
}
