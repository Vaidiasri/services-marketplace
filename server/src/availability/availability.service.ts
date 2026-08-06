import { Injectable } from '@nestjs/common';
import { ExceptionType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Errors } from '../common/errors';
import type { Caller } from '../auth/jwt-auth.guard';
import { PermissionResolver } from '../rbac/permission-resolver.service';
import { canSeeHiddenService, isPubliclyVisible } from '../catalog/public-service-where';
import {
  eachLocalDate,
  inclusiveDayCount,
  localMinutesToUtc,
  MINUTES_IN_DAY,
  todayLocalDate,
} from '../common/time';
import { generateSlots, type Slot } from './slot-generator';
import {
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  type CreateExceptionDto,
  type ExceptionQuery,
  type ReplaceRulesDto,
} from './availability.dto';

const RULE_SELECT = {
  id: true,
  weekday: true,
  startMinute: true,
  endMinute: true,
  capacity: true,
} satisfies Prisma.AvailabilityRuleSelect;

const EXCEPTION_SELECT = {
  id: true,
  date: true,
  type: true,
  startMinute: true,
  endMinute: true,
  capacity: true,
  reason: true,
} satisfies Prisma.AvailabilityExceptionSelect;

/** How far `next-available` looks, widening only if the earlier windows come up empty. */
const NEXT_AVAILABLE_STEPS = [7, 30, MAX_RANGE_DAYS];

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionResolver,
  ) {}

  // ---------------------------------------------------------------- rules

  async listRules(serviceId: string, caller: Caller | undefined) {
    const service = await this.loadVisibleService(serviceId, caller);
    const rules = await this.prisma.availabilityRule.findMany({
      where: { serviceId },
      select: RULE_SELECT,
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
    });

    // Grouped by weekday, because that is how the editor renders it and how a vendor thinks
    // about it. A flat list would make the client do this on every render.
    const byWeekday: Record<number, typeof rules> = {};
    for (let d = 0; d <= 6; d++) byWeekday[d] = [];
    for (const r of rules) byWeekday[r.weekday].push(r);

    return { timezone: service.vendorProfile.timezone, weekdays: byWeekday };
  }

  /**
   * Replace-all inside one transaction, so a failure cannot leave a service with half a
   * schedule - which for a PUBLISHED service would mean customers seeing slots that vanish
   * mid-booking.
   */
  async replaceRules(vendorProfileId: string, serviceId: string, dto: ReplaceRulesDto) {
    const service = await this.requireOwned(vendorProfileId, serviceId);

    for (const r of dto.rules) {
      if (r.endMinute <= r.startMinute) {
        throw Errors.invalidWindow(
          `A window must end after it starts (weekday ${r.weekday}: ${r.startMinute} -> ${r.endMinute}).`,
        );
      }
    }

    // Publishing required at least one rule (M4), so emptying the set behind a published
    // service would leave a listing customers can find and never book. Refused rather than
    // silently unpublishing, because an unpublish is the vendor's decision to make.
    if (dto.rules.length === 0 && service.status === 'PUBLISHED') {
      throw Errors.wouldOrphanPublishedService();
    }

    const [, , rules] = await this.prisma.$transaction([
      this.prisma.availabilityRule.deleteMany({ where: { serviceId } }),
      this.prisma.availabilityRule.createMany({
        data: dto.rules.map((r) => ({ ...r, serviceId })),
      }),
      this.prisma.availabilityRule.findMany({
        where: { serviceId },
        select: RULE_SELECT,
        orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
      }),
    ]);

    return { timezone: service.vendorProfile.timezone, rules };
  }

  // ---------------------------------------------------------------- exceptions

  async listExceptions(serviceId: string, caller: Caller | undefined, query: ExceptionQuery) {
    const service = await this.loadVisibleService(serviceId, caller);
    const zone = service.vendorProfile.timezone;

    const from = query.from ?? todayLocalDate(zone);
    const to = query.to ?? this.addDays(from, MAX_RANGE_DAYS - 1);

    const rows = await this.prisma.availabilityException.findMany({
      // `date` is a @db.Date column, so the bounds are dates, not instants - no timezone
      // conversion belongs here.
      where: { serviceId, date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } },
      select: EXCEPTION_SELECT,
      orderBy: { date: 'asc' },
    });

    return {
      timezone: zone,
      exceptions: rows.map((r) => ({ ...r, date: r.date.toISOString().slice(0, 10) })),
    };
  }

  /**
   * Idempotent for CLOSURE: closing an already-closed date returns the existing row rather
   * than accumulating duplicates. The schema has no unique constraint to lean on because
   * OPEN_WINDOW rows legitimately repeat on one date, so this is a service-layer check.
   */
  async addException(vendorProfileId: string, serviceId: string, dto: CreateExceptionDto) {
    const service = await this.requireOwned(vendorProfileId, serviceId);
    const zone = service.vendorProfile.timezone;

    // Compared in the VENDOR's timezone, not the server's. A closure for a date that has
    // already passed there cannot affect any future slot, so it is a mistake worth naming.
    if (dto.date < todayLocalDate(zone)) throw Errors.dateInPast(dto.date);

    if (dto.type === 'OPEN_WINDOW' && (dto.endMinute ?? 0) <= (dto.startMinute ?? 0)) {
      throw Errors.invalidWindow('An OPEN_WINDOW must end after it starts.');
    }

    const date = new Date(`${dto.date}T00:00:00Z`);

    if (dto.type === 'CLOSURE') {
      const existing = await this.prisma.availabilityException.findFirst({
        where: { serviceId, date, type: ExceptionType.CLOSURE },
        select: EXCEPTION_SELECT,
      });
      if (existing) return this.shapeException(existing);
    }

    const row = await this.prisma.availabilityException.create({
      data: {
        serviceId,
        date,
        type: dto.type as ExceptionType,
        startMinute: dto.startMinute ?? null,
        endMinute: dto.endMinute ?? null,
        capacity: dto.capacity ?? null,
        reason: dto.reason ?? null,
      },
      select: EXCEPTION_SELECT,
    });

    return this.shapeException(row);
  }

  /**
   * Deleting the row restores normal hours and changes nothing else. In particular it does
   * not resurrect anything: slots are derived, so removing a closure simply stops
   * subtracting that date.
   */
  async removeException(vendorProfileId: string, serviceId: string, exceptionId: string) {
    await this.requireOwned(vendorProfileId, serviceId);

    // Scoped by serviceId as well as id, so an exception belonging to another service is
    // not found rather than deleted.
    const row = await this.prisma.availabilityException.findFirst({
      where: { id: exceptionId, serviceId },
      select: { id: true },
    });
    if (!row) throw Errors.notFound('Exception');

    await this.prisma.availabilityException.delete({ where: { id: row.id } });
  }

  // ---------------------------------------------------------------- slots

  async slots(
    serviceId: string,
    caller: Caller | undefined,
    query: { offeringId?: string; from?: string; to?: string },
  ) {
    if (!query.offeringId) throw Errors.offeringRequired();

    const service = await this.loadVisibleService(serviceId, caller);
    const zone = service.vendorProfile.timezone;

    const offering = await this.prisma.offering.findFirst({
      where: { id: query.offeringId, serviceId },
      select: { id: true, durationMinutes: true, isActive: true },
    });
    // 422 rather than 404: the offering id is well-formed but does not belong to this
    // service, which is a client mistake about the relationship, not a missing resource.
    if (!offering) throw Errors.validationFailed({ offeringId: 'No such offering on this service' });

    const from = query.from ?? todayLocalDate(zone);
    const to = query.to ?? this.addDays(from, DEFAULT_RANGE_DAYS - 1);

    const days = inclusiveDayCount(from, to, zone);
    if (days > MAX_RANGE_DAYS) throw Errors.rangeTooLarge(MAX_RANGE_DAYS);

    const envelope = {
      timezone: zone,
      offeringId: offering.id,
      durationMinutes: offering.durationMinutes,
      from,
      to,
    };

    // An inactive offering is not bookable, so there are no slots - but that is an empty
    // list, not an error. The vendor may be mid-edit and the client should render "none
    // available" rather than a failure.
    if (!offering.isActive) return { ...envelope, slots: [] };

    return {
      ...envelope,
      slots: await this.generate(
        serviceId,
        zone,
        service.slotGranularityMinutes,
        offering,
        from,
        to,
      ),
    };
  }

  /**
   * Widening windows rather than one 62-day sweep: a vendor open tomorrow is answered after
   * scanning 7 days, and only a nearly-empty calendar pays for the full range.
   */
  async nextAvailable(serviceId: string, caller: Caller | undefined, offeringId?: string) {
    if (!offeringId) throw Errors.offeringRequired();

    const service = await this.loadVisibleService(serviceId, caller);
    const zone = service.vendorProfile.timezone;

    const offering = await this.prisma.offering.findFirst({
      where: { id: offeringId, serviceId },
      select: { id: true, durationMinutes: true, isActive: true },
    });
    if (!offering) throw Errors.validationFailed({ offeringId: 'No such offering on this service' });

    const envelope = { timezone: zone, offeringId: offering.id };
    if (!offering.isActive) return { ...envelope, slot: null };

    const from = todayLocalDate(zone);
    for (const days of NEXT_AVAILABLE_STEPS) {
      const to = this.addDays(from, days - 1);
      const slots = await this.generate(
        serviceId,
        zone,
        service.slotGranularityMinutes,
        offering,
        from,
        to,
      );
      if (slots.length) return { ...envelope, slot: slots[0] };
    }

    // Null, not 404: "nothing bookable in the next two months" is a valid answer about a
    // service that exists.
    return { ...envelope, slot: null };
  }

  // ---------------------------------------------------------------- internals

  /**
   * Loads rules, exceptions and consumption, then hands them to the pure generator.
   *
   * Consumption is ONE query over the whole UTC range, indexed into a map. A per-slot query
   * would turn a 62-day request into thousands of round trips against a free-tier database.
   */
  private async generate(
    serviceId: string,
    zone: string,
    granularityMinutes: number,
    offering: { durationMinutes: number },
    from: string,
    to: string,
  ): Promise<Slot[]> {
    const [rules, exceptions] = await Promise.all([
      this.prisma.availabilityRule.findMany({ where: { serviceId }, select: RULE_SELECT }),
      this.prisma.availabilityException.findMany({
        where: {
          serviceId,
          date: {
            gte: new Date(`${from}T00:00:00Z`),
            lte: new Date(`${to}T00:00:00Z`),
          },
        },
        select: EXCEPTION_SELECT,
      }),
    ]);

    // Widened by a day either side of the local range, because a local day's slots can
    // land on the neighbouring UTC day in either direction depending on the offset.
    const dates = eachLocalDate(from, to, zone);
    const rangeStart = localMinutesToUtc(dates[0] ?? from, -MINUTES_IN_DAY, zone);
    const rangeEnd = localMinutesToUtc(dates[dates.length - 1] ?? to, 2 * MINUTES_IN_DAY, zone);

    const cells = await this.prisma.slotCell.findMany({
      where: {
        serviceId,
        ...(rangeStart && rangeEnd ? { startUtc: { gte: rangeStart, lte: rangeEnd } } : {}),
      },
      select: { startUtc: true, capacity: true, bookedCount: true },
    });

    const consumption = new Map(
      cells.map((c) => [
        c.startUtc.toISOString(),
        { capacity: c.capacity, bookedCount: c.bookedCount },
      ]),
    );

    return generateSlots({
      timezone: zone,
      granularityMinutes,
      durationMinutes: offering.durationMinutes,
      rules,
      exceptions: exceptions.map((e) => ({
        date: e.date.toISOString().slice(0, 10),
        type: e.type,
        startMinute: e.startMinute,
        endMinute: e.endMinute,
        capacity: e.capacity,
      })),
      from,
      to,
      // The server clock, never a client parameter. There is no `now` in any DTO.
      now: new Date(),
      consumption,
    });
  }

  /**
   * The same 404-or-privileged rule the catalogue uses, so availability cannot become a
   * side channel for discovering a draft or suspended service.
   */
  private async loadVisibleService(serviceId: string, caller: Caller | undefined) {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: {
        id: true,
        status: true,
        slotGranularityMinutes: true,
        vendorProfile: { select: { id: true, status: true, userId: true, timezone: true } },
      },
    });
    if (!service) throw Errors.notFound('Service');

    if (isPubliclyVisible(service)) return service;
    const privileged = await canSeeHiddenService(
      service.vendorProfile.userId,
      caller,
      this.permissions,
    );
    if (!privileged) throw Errors.notFound('Service');
    return service;
  }

  private async requireOwned(vendorProfileId: string, serviceId: string) {
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, vendorProfileId },
      select: {
        id: true,
        status: true,
        vendorProfile: { select: { timezone: true } },
      },
    });
    if (!service) throw Errors.notFound('Service');
    return service;
  }

  private shapeException<T extends { date: Date }>(row: T): Omit<T, 'date'> & { date: string } {
    return { ...row, date: row.date.toISOString().slice(0, 10) };
  }

  /**
   * Calendar-date arithmetic on the date STRING, deliberately timezone-free: adding 13 days
   * to 2026-08-10 is 2026-08-23 in every zone. Anchored at UTC noon so a DST shift cannot
   * push the result onto the neighbouring date.
   */
  private addDays(localDate: string, days: number): string {
    const base = new Date(`${localDate}T12:00:00Z`);
    base.setUTCDate(base.getUTCDate() + days);
    return base.toISOString().slice(0, 10);
  }
}
