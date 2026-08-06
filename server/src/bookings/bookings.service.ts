import { Injectable } from '@nestjs/common';
import { BookingStatus, PaymentMode, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Errors } from '../common/errors';
import { paginated, toSkipTake, type Paginated } from '../common/pagination';
import type { Caller } from '../auth/jwt-auth.guard';
import { PermissionResolver, SUPER_ADMIN } from '../rbac/permission-resolver.service';
import { publicServiceWhere } from '../catalog/public-service-where';
import { utcToLocalDate } from '../common/time';
import { planBookingCells, type PlannedCell } from '../availability/slot-generator';
import {
  assertRoom,
  ensureCells,
  incrementCells,
  lockCells,
  releaseCells,
  setLockTimeout,
  type Tx,
} from './capacity.repository';
import { assertTransition, isTerminal, type Actor } from './state-machine';
import { evaluateCancellation } from './cancellation-policy';
import { IdempotencyService } from './idempotency.service';
import type {
  AdminBookingQuery,
  BookingQuery,
  CreateBookingDto,
  RescheduleDto,
} from './bookings.dto';

/**
 * The ceiling on how long a transaction will sit behind another's row lock.
 *
 * Sized for the WORST case the brief names: twenty concurrent requests at one slot. Each
 * waiter acquires the lock, finds the slot full and rolls back, so the queue drains at
 * roughly one network round trip per waiter. Against a database in another region - this
 * project's Neon instance is us-east-2 - that is ~250 ms each, so the last of twenty waits
 * around fifteen seconds. At 8 s it timed out and answered SLOT_CONTENDED, which is true but
 * far less useful than SLOT_FULL: the slot is not contended, it is full.
 *
 * Co-located (the deployed API and Neon are in the same region) the whole race finishes in
 * about a second and this ceiling is never approached. It exists so a genuinely stuck lock
 * still fails rather than hanging forever.
 */
const LOCK_TIMEOUT_MS = 25_000;
/** Prisma's default interactive-transaction timeout of 5s is too short under 20-way contention. */
const TX_OPTIONS = { timeout: 40_000, maxWait: 40_000 } as const;

const BOOKING_SELECT = {
  id: true,
  reference: true,
  serviceId: true,
  offeringId: true,
  customerUserId: true,
  vendorProfileId: true,
  startUtc: true,
  endUtc: true,
  status: true,
  priceMinor: true,
  currency: true,
  paymentMode: true,
  cancellationFeeMinor: true,
  cancelReason: true,
  createdAt: true,
  service: { select: { id: true, title: true, slotGranularityMinutes: true } },
  offering: { select: { id: true, name: true, durationMinutes: true } },
} satisfies Prisma.BookingSelect;

const DETAIL_SELECT = {
  ...BOOKING_SELECT,
  history: {
    select: {
      id: true,
      fromStatus: true,
      toStatus: true,
      reason: true,
      actorUserId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  },
  payments: {
    select: {
      id: true,
      amountMinor: true,
      currency: true,
      status: true,
      mode: true,
      providerRef: true,
      failureReason: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.BookingSelect;

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionResolver,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ---------------------------------------------------------------- create

  /**
   * The graded transaction. Everything from `$transaction` to commit is one unit: if the
   * process dies anywhere inside, Postgres rolls back the booking, the counter increments,
   * the history row, the payment and the idempotency record together. There is no state in
   * which a seat is consumed by a booking that does not exist.
   */
  async create(caller: Caller, dto: CreateBookingDto, idempotencyKey: string) {
    const replay = await this.idempotency.check(caller.userId, 'booking.create', idempotencyKey, dto);
    // A retry of the same request returns the original answer verbatim - one booking, one
    // payment, one seat consumed, however many times the client sends it.
    if (replay) return { replayed: true, ...(replay.responseBody as object) };

    // Resolved through the SAME visibility rule as the public catalogue, which is what makes
    // M4's suspension actually stop new bookings rather than merely hiding the listing.
    const service = await this.prisma.service.findFirst({
      where: { id: dto.serviceId, ...publicServiceWhere() },
      select: {
        id: true,
        vendorProfileId: true,
        slotGranularityMinutes: true,
        vendorProfile: { select: { timezone: true } },
      },
    });
    if (!service) throw Errors.notFound('Service');

    const startUtc = new Date(dto.startUtc);
    const zone = service.vendorProfile.timezone;

    const offering = await this.prisma.offering.findFirst({
      where: { id: dto.offeringId, serviceId: dto.serviceId, isActive: true },
      select: { id: true, durationMinutes: true, priceMinor: true, currency: true },
    });
    if (!offering) throw Errors.validationFailed({ offeringId: 'No such active offering' });

    // Planned OUTSIDE the transaction, deliberately. Validating the requested start reads
    // availability rules and exceptions, and doing that while holding a row lock keeps every
    // other contender waiting through two round trips to a remote database. Measured: with
    // this inside, 7 of 20 concurrent requests hit the lock timeout and answered
    // SLOT_CONTENDED instead of SLOT_FULL. Nothing here decides capacity - that is settled
    // after the lock by assertRoom - so it is safe to compute before it.
    const cells = await this.planCells(this.prisma, service, zone, offering.durationMinutes, startUtc);

    const created = await this.runLocked(async (tx) => {
      await ensureCells(tx, service.id, cells);
      // The lock. The second concurrent request for the last seat blocks here until the
      // first commits, then reads the incremented counter below.
      const locked = await lockCells(tx, service.id, cells.map((c) => c.startUtc));
      assertRoom(locked);
      await incrementCells(tx, locked.map((c) => c.id));

      const booking = await tx.booking.create({
        data: {
          reference: reference(),
          serviceId: service.id,
          offeringId: offering.id,
          // From the authenticated user, never the body. There is no way to book for someone
          // else, because there is no field in which to name them.
          customerUserId: caller.userId,
          vendorProfileId: service.vendorProfileId,
          startUtc,
          endUtc: new Date(startUtc.getTime() + offering.durationMinutes * 60_000),
          status: BookingStatus.PENDING,
          // Snapshotted from the offering row inside the transaction. The DTO has no price.
          priceMinor: offering.priceMinor,
          currency: offering.currency,
          paymentMode: dto.paymentMode as PaymentMode,
        },
        select: BOOKING_SELECT,
      });

      // The record of what was actually consumed. Release on cancel and reschedule reads
      // these rows rather than recomputing the range from the offering's current duration,
      // which would be wrong the moment a vendor edits that duration.
      await tx.bookingSlotCell.createMany({
        data: locked.map((c) => ({ bookingId: booking.id, slotCellId: c.id })),
      });

      await tx.bookingStatusHistory.create({
        data: {
          bookingId: booking.id,
          fromStatus: null,
          toStatus: BookingStatus.PENDING,
          actorUserId: caller.userId,
          reason: 'created',
        },
      });

      // PAY_NOW opens an INITIATED payment now so the confirm gate has something to check.
      // M7 supplies the mock gateway that moves it to SUCCESS or FAILED.
      const payment =
        dto.paymentMode === 'PAY_NOW'
          ? await tx.payment.create({
              data: {
                bookingId: booking.id,
                amountMinor: booking.priceMinor,
                currency: booking.currency,
                status: PaymentStatus.INITIATED,
                mode: PaymentMode.PAY_NOW,
                providerRef: `mock_${booking.reference}`,
              },
              select: { id: true, status: true, amountMinor: true, providerRef: true },
            })
          : null;

      const body = { booking, payment };
      await this.idempotency.record(
        tx,
        caller.userId,
        'booking.create',
        idempotencyKey,
        dto,
        201,
        body,
      );

      return body;
    });

    return created;
  }

  // ---------------------------------------------------------------- reads

  async list(caller: Caller, query: BookingQuery): Promise<Paginated<unknown>> {
    const vendorProfileId = await this.callerVendorProfileId(caller);

    // Scoped BEFORE the query, never filtered after it: the paginated total comes from the
    // same where clause, so post-filtering would leak the real row count while hiding rows.
    const scope: Prisma.BookingWhereInput =
      caller.roleSlug === SUPER_ADMIN
        ? {}
        : vendorProfileId
          ? { vendorProfileId }
          : { customerUserId: caller.userId };

    const where: Prisma.BookingWhereInput = {
      ...scope,
      ...(query.status ? { status: query.status as BookingStatus } : {}),
      ...(query.from || query.to
        ? {
            startUtc: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.booking.findMany({
        where,
        ...toSkipTake(query),
        orderBy: [{ startUtc: 'desc' }, { id: 'asc' }],
        select: BOOKING_SELECT,
      }),
      this.prisma.booking.count({ where }),
    ]);

    return paginated(rows, total, query);
  }

  async getOne(caller: Caller, id: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      select: DETAIL_SELECT,
    });
    if (!booking) throw Errors.notFound('Booking');

    await this.assertCanSee(caller, booking);
    return booking;
  }

  // ---------------------------------------------------------------- vendor transitions

  async confirm(caller: Caller, vendorProfileId: string, id: string) {
    return this.transition(caller, id, BookingStatus.CONFIRMED, {
      vendorProfileId,
      before: async (booking) => {
        if (booking.paymentMode !== PaymentMode.PAY_NOW) return;
        const paid = await this.prisma.payment.count({
          where: { bookingId: booking.id, status: PaymentStatus.SUCCESS },
        });
        // Only ever fires for PAY_NOW. A PAY_AFTER booking is confirmed on the vendor's word
        // and paid later, which is the point of the mode.
        if (paid === 0) throw Errors.paymentRequired();
      },
    });
  }

  async reject(caller: Caller, vendorProfileId: string, id: string, reason: string) {
    return this.transition(caller, id, BookingStatus.REJECTED, {
      vendorProfileId,
      reason,
      // A rejected booking never happens, so its seats go back immediately.
      release: true,
    });
  }

  async complete(caller: Caller, vendorProfileId: string, id: string) {
    return this.transition(caller, id, BookingStatus.COMPLETED, {
      vendorProfileId,
      before: (booking) => {
        // A vendor cannot farm completions for a dashboard number by completing appointments
        // that have not happened.
        if (booking.endUtc.getTime() > Date.now()) throw Errors.tooEarlyToComplete();
      },
    });
  }

  async noShow(caller: Caller, vendorProfileId: string, id: string, reason: string) {
    return this.transition(caller, id, BookingStatus.NO_SHOW, {
      vendorProfileId,
      reason,
      before: (booking) => {
        if (booking.startUtc.getTime() > Date.now()) throw Errors.tooEarlyForNoShow();
      },
      // Deliberately NOT released. The vendor held the slot open and the customer did not
      // arrive; handing the seat back would reward the no-show with a free cancellation.
    });
  }

  // ---------------------------------------------------------------- cancel

  /**
   * Customer or vendor. The fee is computed server-side from the service row and the server
   * clock - there is no client input to the money, which is what makes the policy
   * unbypassable rather than merely inconvenient to bypass.
   */
  async cancel(caller: Caller, id: string, reason: string | undefined) {
    return this.transition(caller, id, BookingStatus.CANCELLED, {
      reason: reason ?? 'cancelled',
      release: true,
      applyPolicy: true,
    });
  }

  /** Admin override: bypasses the window entirely, fee zero, reason mandatory. */
  async forceCancel(caller: Caller, id: string, reason: string) {
    return this.transition(caller, id, BookingStatus.CANCELLED, {
      reason,
      release: true,
      applyPolicy: false,
      forceActor: 'ADMIN',
    });
  }

  // ---------------------------------------------------------------- reschedule

  /**
   * Old and new cells are locked together as ONE ascending list, never old-then-new. Two
   * reschedules crossing each other - one moving 10:00 to 11:00 while the other moves 11:00
   * to 10:00 - would otherwise take overlapping locks in opposite orders and deadlock.
   *
   * Status does not change: a confirmed booking stays confirmed. The history row is what
   * records the move, which is why history permits fromStatus == toStatus.
   */
  async reschedule(caller: Caller, id: string, dto: RescheduleDto) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      select: {
        ...BOOKING_SELECT,
        slotCells: { select: { slotCellId: true } },
        service: {
          select: {
            id: true,
            title: true,
            slotGranularityMinutes: true,
            status: true,
            vendorProfileId: true,
            vendorProfile: { select: { timezone: true, status: true } },
          },
        },
      },
    });
    if (!booking) throw Errors.notFound('Booking');
    await this.assertCanSee(caller, booking);

    if (isTerminal(booking.status)) {
      throw Errors.illegalTransition(booking.status, booking.status, []);
    }

    const newStart = new Date(dto.startUtc);
    // A no-op returns the booking unchanged and writes no history row, so a double-click
    // does not litter the timeline.
    if (newStart.getTime() === booking.startUtc.getTime()) return booking;

    const zone = booking.service.vendorProfile.timezone;
    const oldCellIds = booking.slotCells.map((c) => c.slotCellId);

    return this.runLocked(async (tx) => {
      const offering = await tx.offering.findUnique({
        where: { id: booking.offeringId },
        select: { durationMinutes: true },
      });
      if (!offering) throw Errors.notFound('Offering');

      const newCells = await this.planCells(
        tx,
        { id: booking.serviceId, slotGranularityMinutes: booking.service.slotGranularityMinutes },
        zone,
        offering.durationMinutes,
        newStart,
      );

      await ensureCells(tx, booking.serviceId, newCells);

      const oldRows = await tx.slotCell.findMany({
        where: { id: { in: oldCellIds } },
        select: { startUtc: true },
      });

      // One combined list. lockCells sorts, so the union is acquired in a single ascending
      // pass regardless of which direction the move goes.
      const locked = await lockCells(tx, booking.serviceId, [
        ...oldRows.map((r) => r.startUtc),
        ...newCells.map((c) => c.startUtc),
      ]);
      const byStart = new Map(locked.map((c) => [c.startUtc.toISOString(), c]));

      const newLocked = newCells.map((c) => {
        const row = byStart.get(c.startUtc.toISOString());
        if (!row) throw Errors.slotFull();
        return row;
      });

      // Room is assessed on the NEW cells only, and against their state after excluding this
      // booking's own occupancy where the ranges overlap - a booking shifted by one cell must
      // not block itself.
      const ownedIds = new Set(oldCellIds);
      for (const cell of newLocked) {
        const selfHeld = ownedIds.has(cell.id) ? 1 : 0;
        if (cell.bookedCount - selfHeld >= cell.capacity) throw Errors.slotFull();
      }

      await releaseCells(tx, oldCellIds);
      await tx.bookingSlotCell.deleteMany({ where: { bookingId: booking.id } });
      await incrementCells(tx, newLocked.map((c) => c.id));
      await tx.bookingSlotCell.createMany({
        data: newLocked.map((c) => ({ bookingId: booking.id, slotCellId: c.id })),
      });

      const updated = await tx.booking.update({
        where: { id: booking.id },
        data: {
          startUtc: newStart,
          endUtc: new Date(newStart.getTime() + offering.durationMinutes * 60_000),
        },
        select: BOOKING_SELECT,
      });

      await tx.bookingStatusHistory.create({
        data: {
          bookingId: booking.id,
          fromStatus: booking.status,
          toStatus: booking.status,
          actorUserId: caller.userId,
          reason: `rescheduled from ${booking.startUtc.toISOString()} to ${newStart.toISOString()}`,
        },
      });

      return updated;
    });
  }

  // ---------------------------------------------------------------- internals

  /**
   * Validates the requested start and returns its cell plan.
   *
   * `consumption` is deliberately EMPTY here. The generator drops a slot with no remaining
   * capacity, so passing real consumption would make a full slot indistinguishable from an
   * invented time - a 422 INVALID_SLOT for what is really a 409 SLOT_FULL. Whether there is
   * room is decided after the lock, by assertRoom, which is the only place that can answer
   * it correctly anyway.
   */
  private async planCells(
    tx: Tx | PrismaService,
    service: { id: string; slotGranularityMinutes: number },
    zone: string,
    durationMinutes: number,
    startUtc: Date,
  ): Promise<PlannedCell[]> {
    if (startUtc.getTime() <= Date.now()) throw Errors.slotInPast();

    const localDate = utcToLocalDate(startUtc, zone);
    const [rules, exceptions] = await Promise.all([
      tx.availabilityRule.findMany({
        where: { serviceId: service.id },
        select: { weekday: true, startMinute: true, endMinute: true, capacity: true },
      }),
      tx.availabilityException.findMany({
        where: { serviceId: service.id },
        select: { date: true, type: true, startMinute: true, endMinute: true, capacity: true },
      }),
    ]);

    // A one-day window either side, because a local date's slots can spill into the
    // neighbouring UTC day and the requested instant might sit on either.
    const cells = planBookingCells(
      {
        timezone: zone,
        granularityMinutes: service.slotGranularityMinutes,
        durationMinutes,
        rules,
        exceptions: exceptions.map((e) => ({
          date: e.date.toISOString().slice(0, 10),
          type: e.type,
          startMinute: e.startMinute,
          endMinute: e.endMinute,
          capacity: e.capacity,
        })),
        from: shiftDate(localDate, -1),
        to: shiftDate(localDate, 1),
        now: new Date(),
        consumption: new Map(),
      },
      startUtc,
    );

    // The start did not fall on the grid, or fell outside an open window, or on a closed
    // date. A client cannot invent a bookable time.
    if (!cells) throw Errors.invalidSlot();
    return cells;
  }

  /**
   * One transition path for every status change, so the history row cannot be forgotten and
   * the state machine cannot be bypassed. `assertTransition` runs before any write.
   */
  private async transition(
    caller: Caller,
    id: string,
    to: BookingStatus,
    opts: {
      vendorProfileId?: string;
      reason?: string;
      release?: boolean;
      applyPolicy?: boolean;
      forceActor?: Actor;
      before?: (booking: {
        id: string;
        status: BookingStatus;
        startUtc: Date;
        endUtc: Date;
        paymentMode: PaymentMode;
      }) => void | Promise<void>;
    },
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      select: {
        ...BOOKING_SELECT,
        slotCells: { select: { slotCellId: true } },
        service: {
          select: {
            id: true,
            title: true,
            slotGranularityMinutes: true,
            freeCancellationHours: true,
            cancellationFeePercent: true,
          },
        },
      },
    });
    if (!booking) throw Errors.notFound('Booking');

    // 404, never 403, and before anything else: a booking id belonging to another vendor or
    // customer must not be confirmed to exist.
    const actor = opts.forceActor ?? (await this.assertCanSee(caller, booking, opts.vendorProfileId));

    assertTransition(booking.status, to, actor);
    await opts.before?.(booking);

    const outcome =
      opts.applyPolicy && to === BookingStatus.CANCELLED
        ? evaluateCancellation(booking.service, booking, new Date())
        : null;

    const cellIds = booking.slotCells.map((c) => c.slotCellId);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: to,
          ...(opts.reason ? { cancelReason: opts.reason } : {}),
          ...(outcome ? { cancellationFeeMinor: outcome.feeMinor } : {}),
        },
        select: BOOKING_SELECT,
      });

      if (opts.release) await releaseCells(tx, cellIds);

      // Same transaction as the status change, so a booking whose status moved without a
      // history row is unrepresentable.
      await tx.bookingStatusHistory.create({
        data: {
          bookingId: booking.id,
          fromStatus: booking.status,
          toStatus: to,
          actorUserId: caller.userId,
          reason:
            outcome?.isLate === true
              ? `${opts.reason ?? 'cancelled'} (late, fee ${outcome.feeMinor})`
              : (opts.reason ?? null),
        },
      });

      return outcome ? { ...updated, cancellation: outcome } : updated;
    }, TX_OPTIONS);
  }

  /**
   * Wraps a transaction with the lock timeout and turns a timed-out waiter into 409
   * SLOT_CONTENDED. The last of twenty concurrent requests deserves a clean refusal rather
   * than an internal error.
   */
  private async runLocked<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await setLockTimeout(tx, LOCK_TIMEOUT_MS);
        return fn(tx);
      }, TX_OPTIONS);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: string })?.code;

      // P2024 is Prisma's connection-pool timeout. It shows up here because every waiting
      // transaction holds a connection while it queues for a row lock, so heavy contention
      // exhausts the pool before it exhausts the database. That is a "try again", not an
      // internal error - answering 500 would make a working capacity guarantee look broken.
      // The durable fix is connection_limit in DATABASE_URL; this is the honest fallback.
      if (
        code === 'P2024' ||
        /statement timeout|canceling statement|deadlock detected|connection pool/i.test(message)
      ) {
        throw Errors.slotContended();
      }
      throw e;
    }
  }

  /**
   * Returns the actor role, and throws 404 if the caller has no relationship to the booking.
   * The actor is derived from the RELATIONSHIP, not from the role slug - a super admin who
   * happens to be the customer on a booking is still acting as the customer.
   */
  private async assertCanSee(
    caller: Caller,
    booking: { customerUserId: string; vendorProfileId: string },
    knownVendorProfileId?: string,
  ): Promise<Actor> {
    if (booking.customerUserId === caller.userId) return 'CUSTOMER';

    const vendorProfileId = knownVendorProfileId ?? (await this.callerVendorProfileId(caller));
    if (vendorProfileId && vendorProfileId === booking.vendorProfileId) return 'VENDOR';

    if (caller.roleSlug === SUPER_ADMIN) return 'ADMIN';
    const slugs = await this.permissions.getEffectiveSlugs(caller.userId);
    if (slugs.includes('booking.read_all')) return 'ADMIN';

    throw Errors.notFound('Booking');
  }

  private async callerVendorProfileId(caller: Caller): Promise<string | null> {
    const profile = await this.prisma.vendorProfile.findUnique({
      where: { userId: caller.userId },
      select: { id: true },
    });
    return profile?.id ?? null;
  }

  // ---------------------------------------------------------------- admin

  async listForAdmin(query: AdminBookingQuery): Promise<Paginated<unknown>> {
    const where: Prisma.BookingWhereInput = {
      ...(query.status ? { status: query.status as BookingStatus } : {}),
      ...(query.vendorId ? { vendorProfileId: query.vendorId } : {}),
      ...(query.customerId ? { customerUserId: query.customerId } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.booking.findMany({
        where,
        ...toSkipTake(query),
        orderBy: [{ startUtc: 'desc' }, { id: 'asc' }],
        select: BOOKING_SELECT,
      }),
      this.prisma.booking.count({ where }),
    ]);

    return paginated(rows, total, query);
  }
}

/**
 * A human-quotable reference. Not a security token - the id is the identifier and every
 * route checks ownership - so collision resistance matters more than unpredictability, and
 * the unique index is the backstop.
 */
function reference(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `BK-${out}`;
}

function shiftDate(localDate: string, days: number): string {
  const d = new Date(`${localDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
