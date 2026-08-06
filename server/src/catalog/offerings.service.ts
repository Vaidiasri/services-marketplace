import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Errors } from '../common/errors';
import type { Caller } from '../auth/jwt-auth.guard';
import { PermissionResolver } from '../rbac/permission-resolver.service';
import { canSeeHiddenService, isPubliclyVisible } from './public-service-where';
import type { CreateOfferingDto, UpdateOfferingDto } from './catalog.dto';

const OFFERING_SELECT = {
  id: true,
  serviceId: true,
  name: true,
  durationMinutes: true,
  priceMinor: true,
  currency: true,
  isActive: true,
} satisfies Prisma.OfferingSelect;

/**
 * `priceMinor` is written here and nowhere else, only by the vendor who owns the service.
 * Booking creation in M6 reads it from this row - the booking DTO has no price field at
 * all - which is what makes a price impossible to send from a request body.
 */
@Injectable()
export class OfferingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionResolver,
  ) {}

  /**
   * Public callers see active offerings on a publicly visible service. The owner and
   * admins see all of them, including deactivated ones, through the same route.
   */
  async listForService(serviceId: string, caller: Caller | undefined) {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: { id: true, status: true, vendorProfile: { select: { status: true, userId: true } } },
    });
    if (!service) throw Errors.notFound('Service');

    const privileged = await canSeeHiddenService(
      service.vendorProfile.userId,
      caller,
      this.permissions,
    );

    // 404 rather than an empty list: an unpublished service's offerings are as private as
    // the service itself, and an empty array would confirm the id exists.
    if (!privileged && !isPubliclyVisible(service)) throw Errors.notFound('Service');

    return this.prisma.offering.findMany({
      where: { serviceId, ...(privileged ? {} : { isActive: true }) },
      select: OFFERING_SELECT,
      orderBy: [{ priceMinor: 'asc' }, { id: 'asc' }],
    });
  }

  async create(vendorProfileId: string, serviceId: string, dto: CreateOfferingDto) {
    const service = await this.requireOwnedService(vendorProfileId, serviceId);
    this.assertAligned(dto.durationMinutes, service.slotGranularityMinutes);

    return this.prisma.offering.create({
      data: { ...dto, serviceId },
      select: OFFERING_SELECT,
    });
  }

  /**
   * A price change is allowed even with future bookings outstanding, and deliberately so:
   * every booking snapshotted `priceMinor` at creation, so existing appointments hold the
   * price the customer agreed to and only new bookings see the new one. Refusing the edit
   * would leave a vendor unable to change their own prices for as long as any booking is
   * open.
   */
  async update(vendorProfileId: string, id: string, dto: UpdateOfferingDto) {
    const offering = await this.requireOwned(vendorProfileId, id);

    if (dto.durationMinutes !== undefined) {
      this.assertAligned(dto.durationMinutes, offering.service.slotGranularityMinutes);
    }

    return this.prisma.offering.update({ where: { id }, data: dto, select: OFFERING_SELECT });
  }

  async remove(vendorProfileId: string, id: string): Promise<void> {
    await this.requireOwned(vendorProfileId, id);

    const bookings = await this.prisma.booking.count({ where: { offeringId: id } });
    // Deactivating is the answer, and the error says so: a booking's priceMinor is its own
    // snapshot, but its offeringId is what names what was actually booked.
    if (bookings > 0) throw Errors.offeringInUse(bookings);

    await this.prisma.offering.delete({ where: { id } });
  }

  // ---------------------------------------------------------------- internals

  /**
   * Duration must divide evenly into the service's slot size, checked at the write rather
   * than when slots are generated. A 50-minute offering on a 15-minute grid cannot be laid
   * on the shared capacity grid M5 builds, and the failure would otherwise surface as
   * quietly wrong slot times days later.
   */
  private assertAligned(durationMinutes: number, granularityMinutes: number): void {
    if (durationMinutes % granularityMinutes !== 0) {
      throw Errors.durationNotAligned(granularityMinutes);
    }
  }

  private async requireOwnedService(vendorProfileId: string, serviceId: string) {
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, vendorProfileId },
      select: { id: true, slotGranularityMinutes: true },
    });
    if (!service) throw Errors.notFound('Service');
    return service;
  }

  /**
   * Scoped through the parent service, so an offering id belonging to another vendor is
   * simply not found. 404, not 403 - an offering id should not confirm anything about a
   * service the caller cannot see.
   */
  private async requireOwned(vendorProfileId: string, id: string) {
    const offering = await this.prisma.offering.findFirst({
      where: { id, service: { vendorProfileId } },
      select: { id: true, service: { select: { id: true, slotGranularityMinutes: true } } },
    });
    if (!offering) throw Errors.notFound('Offering');
    return offering;
  }
}
