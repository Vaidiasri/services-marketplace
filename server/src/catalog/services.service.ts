import { Injectable } from '@nestjs/common';
import { BookingStatus, Prisma, ServiceStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Errors } from '../common/errors';
import { paginated, toSkipTake, type Paginated } from '../common/pagination';
import type { Caller } from '../auth/jwt-auth.guard';
import { PermissionResolver, SUPER_ADMIN } from '../rbac/permission-resolver.service';
import { isPubliclyVisible, publicServiceWhere } from './public-service-where';
import type {
  AdminServiceQuery,
  CreateServiceDto,
  PublicServiceQuery,
  UpdateServiceDto,
  VendorServiceQuery,
} from './catalog.dto';

/** A booking in one of these states still has a claim on the service. */
const LIVE_BOOKING_STATUSES: BookingStatus[] = [BookingStatus.PENDING, BookingStatus.CONFIRMED];

/** What a customer browsing the catalogue is shown. No vendor contact details. */
const PUBLIC_SELECT = {
  id: true,
  title: true,
  description: true,
  slotGranularityMinutes: true,
  freeCancellationHours: true,
  cancellationFeePercent: true,
  createdAt: true,
  category: { select: { id: true, name: true, slug: true } },
  vendorProfile: { select: { id: true, businessName: true, city: true, state: true } },
  offerings: {
    where: { isActive: true },
    select: { id: true, name: true, durationMinutes: true, priceMinor: true, currency: true },
    orderBy: { priceMinor: 'asc' },
  },
  images: { select: { id: true, storedFilename: true, sortOrder: true }, orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.ServiceSelect;

/** The owner and admins additionally see status, the suspension reason, and inactive offerings. */
const OWNER_SELECT = {
  ...PUBLIC_SELECT,
  status: true,
  suspensionReason: true,
  updatedAt: true,
  offerings: {
    select: {
      id: true,
      name: true,
      durationMinutes: true,
      priceMinor: true,
      currency: true,
      isActive: true,
    },
    orderBy: { priceMinor: 'asc' },
  },
} satisfies Prisma.ServiceSelect;

@Injectable()
export class ServicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionResolver,
  ) {}

  // ---------------------------------------------------------------- public reads

  async listPublic(query: PublicServiceQuery): Promise<Paginated<unknown>> {
    const where: Prisma.ServiceWhereInput = publicServiceWhere();

    if (query.categoryId) {
      where.categoryId = { in: await this.categoryAndChildren(query.categoryId) };
    }

    // A service matches if ANY of its active offerings falls in range, which is what a
    // customer filtering by budget means. Both bounds land in one `some` so a single
    // offering has to satisfy both - two separate `some` clauses would match a service
    // with a cheap offering and an unrelated expensive one.
    if (query.minPriceMinor !== undefined || query.maxPriceMinor !== undefined) {
      where.offerings = {
        some: {
          isActive: true,
          priceMinor: {
            ...(query.minPriceMinor === undefined ? {} : { gte: query.minPriceMinor }),
            ...(query.maxPriceMinor === undefined ? {} : { lte: query.maxPriceMinor }),
          },
        },
      };
    }

    if (query.q) {
      const ids = await this.searchIds(query.q);
      // Nothing matched the text, so nothing can match text AND the other filters.
      // Returning early also avoids sending `id: { in: [] }` to Postgres.
      if (ids.length === 0) return paginated([], 0, query);
      where.id = { in: ids };
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.service.findMany({
        where,
        ...toSkipTake(query),
        // Tie-broken by id. Without it, two services sharing a createdAt can swap places
        // between page 1 and page 2 and a row is silently skipped - the classic
        // unstable-sort pagination bug, and the brief tests page 2 specifically.
        orderBy: [{ [query.sort]: query.order }, { id: 'asc' }],
        select: PUBLIC_SELECT,
      }),
      this.prisma.service.count({ where }),
    ]);

    return paginated(rows, total, query);
  }

  /**
   * One route serves customers, the owning vendor, and admins, and the answer to "may I
   * see this" decides between 200 and 404 - never 403. The existence of an unpublished
   * service is itself private, so a 403 would confirm the id is real.
   */
  async getOneVisibleTo(id: string, caller: Caller | undefined) {
    const service = await this.prisma.service.findUnique({
      where: { id },
      select: { ...OWNER_SELECT, vendorProfile: { select: { id: true, businessName: true, city: true, state: true, status: true, userId: true } } },
    });
    if (!service) throw Errors.notFound('Service');

    if (isPubliclyVisible(service)) return narrow(service, false);

    if (!caller) throw Errors.notFound('Service');

    const isOwner = service.vendorProfile.userId === caller.userId;
    const isSuper = caller.roleSlug === SUPER_ADMIN;
    const canReadAll =
      isSuper || (await this.permissions.getEffectiveSlugs(caller.userId)).includes('service.read_all');

    if (!isOwner && !canReadAll) throw Errors.notFound('Service');
    return narrow(service, true);
  }

  // ---------------------------------------------------------------- vendor's own

  async listOwn(vendorProfileId: string, query: VendorServiceQuery): Promise<Paginated<unknown>> {
    const where: Prisma.ServiceWhereInput = {
      vendorProfileId,
      ...(query.status ? { status: query.status as ServiceStatus } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.service.findMany({
        where,
        ...toSkipTake(query),
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        select: {
          ...OWNER_SELECT,
          _count: { select: { offerings: true, rules: true, bookings: true } },
        },
      }),
      this.prisma.service.count({ where }),
    ]);

    return paginated(rows, total, query);
  }

  async create(vendorProfileId: string, dto: CreateServiceDto) {
    await this.assertUsableCategory(dto.categoryId);

    // Always DRAFT. There is no way to create a published service, so nothing reaches the
    // public catalogue without passing the publish preconditions.
    return this.prisma.service.create({
      data: { ...dto, vendorProfileId, status: ServiceStatus.DRAFT },
      select: OWNER_SELECT,
    });
  }

  async update(vendorProfileId: string, id: string, dto: UpdateServiceDto) {
    const service = await this.requireOwned(vendorProfileId, id);

    if (dto.categoryId && dto.categoryId !== service.categoryId) {
      await this.assertUsableCategory(dto.categoryId);
    }

    // Narrowing the grid can strand offerings that no longer divide into it, which would
    // produce a service whose slot generation is quietly wrong. Refused at the boundary
    // with the offending ids, so the vendor can see exactly what to change first.
    if (
      dto.slotGranularityMinutes !== undefined &&
      dto.slotGranularityMinutes !== service.slotGranularityMinutes
    ) {
      const offerings = await this.prisma.offering.findMany({
        where: { serviceId: id, isActive: true },
        select: { id: true, durationMinutes: true },
      });
      const offending = offerings
        .filter((o) => o.durationMinutes % dto.slotGranularityMinutes! !== 0)
        .map((o) => o.id);
      if (offending.length) {
        throw Errors.granularityConflict(offending, dto.slotGranularityMinutes);
      }
    }

    return this.prisma.service.update({ where: { id }, data: dto, select: OWNER_SELECT });
  }

  /**
   * The two preconditions exist because a published service with nothing bookable is a
   * dead end for the customer who clicks it.
   *
   * Vendor approval is NOT checked here - @RequireApprovedVendor on the route already
   * refused a pending vendor with 403 before this method ran. Repeating it would be a
   * second copy of a rule that is already a guard.
   */
  async publish(vendorProfileId: string, id: string) {
    await this.requireOwned(vendorProfileId, id);

    const [activeOfferings, rules] = await this.prisma.$transaction([
      this.prisma.offering.count({ where: { serviceId: id, isActive: true } }),
      this.prisma.availabilityRule.count({ where: { serviceId: id } }),
    ]);

    if (activeOfferings === 0) throw Errors.noActiveOffering();
    if (rules === 0) throw Errors.noAvailability();

    return this.prisma.service.update({
      where: { id },
      data: { status: ServiceStatus.PUBLISHED, suspensionReason: null },
      select: OWNER_SELECT,
    });
  }

  /**
   * Refused while an upcoming booking exists. The customer's appointment would otherwise
   * stop resolving through every public path at once, silently, because those paths all
   * compose publicServiceWhere(). Admin suspension is the deliberate exception.
   */
  async unpublish(vendorProfileId: string, id: string) {
    await this.requireOwned(vendorProfileId, id);

    const upcoming = await this.prisma.booking.count({
      where: { serviceId: id, status: { in: LIVE_BOOKING_STATUSES }, startUtc: { gte: new Date() } },
    });
    if (upcoming > 0) throw Errors.futureBookingsExist(upcoming);

    return this.prisma.service.update({
      where: { id },
      data: { status: ServiceStatus.DRAFT },
      select: OWNER_SELECT,
    });
  }

  async remove(vendorProfileId: string, id: string): Promise<void> {
    await this.requireOwned(vendorProfileId, id);

    // Any booking at all, not just upcoming ones: a completed booking is a financial
    // record, and cascading its service away would leave the customer's history dangling.
    const bookings = await this.prisma.booking.count({ where: { serviceId: id } });
    if (bookings > 0) throw Errors.serviceInUse(bookings);

    await this.prisma.service.delete({ where: { id } });
  }

  // ---------------------------------------------------------------- admin

  async listForAdmin(query: AdminServiceQuery): Promise<Paginated<unknown>> {
    const where: Prisma.ServiceWhereInput = {
      ...(query.status ? { status: query.status as ServiceStatus } : {}),
      ...(query.vendorId ? { vendorProfileId: query.vendorId } : {}),
    };

    if (query.q) {
      const ids = await this.searchIds(query.q);
      if (ids.length === 0) return paginated([], 0, query);
      where.id = { in: ids };
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.service.findMany({
        where,
        ...toSkipTake(query),
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: {
          ...OWNER_SELECT,
          vendorProfile: {
            select: { id: true, businessName: true, city: true, state: true, status: true },
          },
        },
      }),
      this.prisma.service.count({ where }),
    ]);

    return paginated(rows, total, query);
  }

  /**
   * Touches the service and nothing else. New bookings stop because every public path
   * composes publicServiceWhere(); existing CONFIRMED bookings keep working because the
   * vendor's fulfilment routes key off the booking, not the service status. Suspending a
   * service must not cancel appointments a customer has already been promised.
   */
  async suspend(id: string, reason: string) {
    await this.requireExists(id);
    return this.prisma.service.update({
      where: { id },
      data: { status: ServiceStatus.SUSPENDED, suspensionReason: reason },
      select: OWNER_SELECT,
    });
  }

  /**
   * Returns to PUBLISHED, not to DRAFT: suspension is something done TO a published
   * service, so lifting it restores what was there. Dropping it to DRAFT would quietly
   * require the vendor to re-publish after an admin cleared the issue.
   */
  async unsuspend(id: string) {
    await this.requireExists(id);
    return this.prisma.service.update({
      where: { id },
      data: { status: ServiceStatus.PUBLISHED, suspensionReason: null },
      select: OWNER_SELECT,
    });
  }

  // ---------------------------------------------------------------- internals

  /**
   * The text half of the search, as an id prefilter.
   *
   * Prisma cannot express `@@` against a tsvector in a `where`, and the alternative -
   * writing the whole list query in raw SQL - would mean hand-writing the visibility
   * condition a second time, which is precisely what publicServiceWhere() exists to
   * prevent. So the index-backed match runs on its own and its ids are composed into the
   * normal Prisma predicate. The GIN index is used (verified with EXPLAIN), and both the
   * page and the count still come from one `where` in one transaction.
   *
   * `q` is a bound parameter, not interpolated. websearch_to_tsquery also never throws on
   * user text, so a malformed query is an empty result rather than a 500.
   */
  private async searchIds(q: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Service"
      WHERE "searchVector" @@ websearch_to_tsquery('english', ${q})
      LIMIT 5000`;
    return rows.map((r) => r.id);
  }

  /**
   * Filtering by a parent includes its children, so "Beauty" also returns services filed
   * under "Salon". Two levels means one extra query rather than recursion.
   */
  private async categoryAndChildren(categoryId: string): Promise<string[]> {
    const children = await this.prisma.category.findMany({
      where: { parentId: categoryId },
      select: { id: true },
    });
    return [categoryId, ...children.map((c) => c.id)];
  }

  private async assertUsableCategory(categoryId: string): Promise<void> {
    const category = await this.prisma.category.findUnique({
      where: { id: categoryId },
      select: { id: true, isActive: true },
    });
    if (!category || !category.isActive) throw Errors.categoryInvalid();
  }

  /**
   * Ownership as a scoped lookup rather than a load-then-compare: `vendorProfileId` comes
   * from ApprovedVendorGuard, so a service belonging to another vendor simply is not
   * found. That is a 404 by construction, with no branch that could return the row.
   */
  private async requireOwned(vendorProfileId: string, id: string) {
    const service = await this.prisma.service.findFirst({
      where: { id, vendorProfileId },
      select: { id: true, categoryId: true, status: true, slotGranularityMinutes: true },
    });
    if (!service) throw Errors.notFound('Service');
    return service;
  }

  private async requireExists(id: string): Promise<void> {
    const exists = await this.prisma.service.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw Errors.notFound('Service');
  }

}

/**
 * The detail route loads one shape and narrows it, rather than branching over three
 * near-identical selects before it knows who is asking. Visibility has to be decided from
 * the row, so the row is fetched first either way.
 *
 * `vendorProfile.userId` is never returned: it is only loaded to answer "is this the
 * owner", and echoing a user id into a public response leaks the vendor's account.
 */
function narrow(
  service: Record<string, unknown> & {
    vendorProfile: Record<string, unknown>;
    offerings: { isActive?: boolean }[];
  },
  privileged: boolean,
) {
  const { userId: _userId, status: vendorStatus, ...vendorProfile } = service.vendorProfile;

  if (privileged) {
    return { ...service, vendorProfile: { ...vendorProfile, status: vendorStatus } };
  }

  // Public callers see neither the internal status fields nor deactivated offerings. An
  // inactive offering is not bookable, so showing its price would advertise something
  // that cannot be purchased.
  const { status: _s, suspensionReason: _r, updatedAt: _u, ...pub } = service;
  return {
    ...pub,
    vendorProfile,
    offerings: service.offerings
      .filter((o) => o.isActive !== false)
      .map(({ isActive: _a, ...o }) => o),
  };
}
