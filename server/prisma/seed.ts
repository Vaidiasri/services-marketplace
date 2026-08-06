// Phase 1 seed: the permission catalogue and the four system roles, nothing else.
// The full demo dataset (accounts, services, availability, bookings, payments)
// arrives in Phase 9 - see doc/features/M10_DELIVERY/plan.md.
//
// Idempotent by design: every write is an upsert and role permission sets are
// reconciled rather than appended, so Render can run this on every deploy.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Source of truth: doc/02_PERMISSION_CATALOGUE.md.
// resource/action are derived by splitting on the LAST dot, so the three-segment
// admin.dashboard.read yields resource "admin.dashboard", action "read".
const PERMISSIONS: string[] = [
  'user.read', 'user.read_all', 'user.update',
  'role.read', 'role.create', 'role.update', 'role.delete', 'role.assign',
  'permission.read',
  'vendor.read', 'vendor.read_all', 'vendor.update', 'vendor.approve', 'vendor.reject',
  'category.read', 'category.create', 'category.update', 'category.delete',
  'service.read', 'service.read_all', 'service.create', 'service.update',
  'service.delete', 'service.publish', 'service.suspend',
  'offering.create', 'offering.update', 'offering.delete',
  'availability.read', 'availability.manage',
  'booking.read', 'booking.read_all', 'booking.create', 'booking.reschedule',
  'booking.cancel', 'booking.force_cancel', 'booking.confirm', 'booking.reject',
  'booking.complete', 'booking.no_show',
  'payment.read', 'payment.read_all', 'payment.initiate', 'payment.refund',
  'payment.mark_collected',
  'admin.dashboard.read',
  'audit.read',
];

type RoleSeed = { slug: string; name: string; permissions: string[] };

const ROLES: RoleSeed[] = [
  {
    slug: 'SUPER_ADMIN',
    name: 'Super Admin',
    // Deliberately empty. The guard short-circuits on this slug rather than
    // matching slugs, because holding-all-slugs silently stops being "all" the
    // moment a new permission is added. The brief says it bypasses every check.
    permissions: [],
  },
  {
    slug: 'CUSTOMER',
    name: 'Customer',
    permissions: [
      'service.read', 'availability.read',
      'booking.read', 'booking.create', 'booking.reschedule', 'booking.cancel',
      'payment.read', 'payment.initiate',
      'user.read', 'user.update',
    ],
  },
  {
    slug: 'VENDOR',
    name: 'Vendor',
    permissions: [
      'service.read', 'service.create', 'service.update', 'service.delete',
      'service.publish',
      'offering.create', 'offering.update', 'offering.delete',
      'availability.read', 'availability.manage',
      'booking.read', 'booking.confirm', 'booking.reject', 'booking.complete',
      'booking.no_show', 'booking.cancel',
      'payment.read', 'payment.mark_collected',
      'vendor.read', 'vendor.update',
      'user.read', 'user.update',
    ],
  },
  {
    // The brief's worked example, seeded so a reviewer can sign in as a genuinely
    // restricted sub-admin. No role.*, no vendor.approve, no booking.read_all.
    slug: 'CATALOGUE_MODERATOR',
    name: 'Catalogue Moderator',
    permissions: [
      'category.read', 'category.create', 'category.update', 'category.delete',
      'service.read', 'service.read_all', 'service.suspend',
      'user.read',
    ],
  },
];

function splitSlug(slug: string): { resource: string; action: string } {
  const i = slug.lastIndexOf('.');
  return { resource: slug.slice(0, i), action: slug.slice(i + 1) };
}

async function seedPermissions(): Promise<Map<string, string>> {
  const byslug = new Map<string, string>();
  for (const slug of PERMISSIONS) {
    const { resource, action } = splitSlug(slug);
    const row = await prisma.permission.upsert({
      where: { slug },
      update: { resource, action },
      create: { slug, resource, action },
    });
    byslug.set(slug, row.id);
  }
  return byslug;
}

async function seedRoles(permissionIds: Map<string, string>): Promise<void> {
  for (const role of ROLES) {
    const row = await prisma.role.upsert({
      where: { slug: role.slug },
      update: { name: role.name, isSystem: true },
      create: { slug: role.slug, name: role.name, isSystem: true },
    });

    const wanted = new Set(
      role.permissions.map((slug) => {
        const id = permissionIds.get(slug);
        // A typo in a role's list would otherwise seed a quietly smaller role, and
        // the permission tests would fail somewhere far from the cause.
        if (!id) throw new Error(`Role ${role.slug} references unknown permission ${slug}`);
        return id;
      }),
    );

    // Reconcile rather than append, so removing a slug from a list above actually
    // removes it on the next run.
    const existing = await prisma.rolePermission.findMany({
      where: { roleId: row.id },
      select: { permissionId: true },
    });
    const have = new Set(existing.map((e) => e.permissionId));

    const toAdd = [...wanted].filter((id) => !have.has(id));
    const toRemove = [...have].filter((id) => !wanted.has(id));

    if (toAdd.length) {
      await prisma.rolePermission.createMany({
        data: toAdd.map((permissionId) => ({ roleId: row.id, permissionId })),
        skipDuplicates: true,
      });
    }
    if (toRemove.length) {
      await prisma.rolePermission.deleteMany({
        where: { roleId: row.id, permissionId: { in: toRemove } },
      });
    }

    console.log(
      `[seed] role ${role.slug}: ${wanted.size} permissions ` +
        `(+${toAdd.length} -${toRemove.length})`,
    );
  }
}

/**
 * Two levels, matching the limit CategoriesService enforces. Seeded because a service
 * cannot be created without a category to point at, so an empty database would leave a
 * vendor with nothing to do on their first screen.
 *
 * Slugs are parent-prefixed here exactly as CategoriesService generates them, so a seeded
 * category and an admin-created one are indistinguishable.
 */
const CATEGORIES: { name: string; children: string[] }[] = [
  { name: 'Beauty & Wellness', children: ['Salon', 'Spa & Massage', 'Nails'] },
  { name: 'Home Services', children: ['Cleaning', 'Plumbing', 'Electrical', 'Pest Control'] },
  { name: 'Fitness', children: ['Personal Training', 'Yoga'] },
  { name: 'Repairs', children: ['Appliance Repair', 'Device Repair'] },
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function seedCategories(): Promise<void> {
  let created = 0;

  for (const parent of CATEGORIES) {
    const parentSlug = slugify(parent.name);
    // Upsert on slug, so re-running the seed neither duplicates a category nor resets an
    // isActive flag or sortOrder an admin has since changed.
    const row = await prisma.category.upsert({
      where: { slug: parentSlug },
      update: {},
      create: { name: parent.name, slug: parentSlug },
    });
    created++;

    for (const child of parent.children) {
      await prisma.category.upsert({
        where: { slug: `${parentSlug}-${slugify(child)}` },
        update: {},
        create: { name: child, slug: `${parentSlug}-${slugify(child)}`, parentId: row.id },
      });
      created++;
    }
  }

  console.log(`[seed] categories reconciled: ${created}`);
}

// ---------------------------------------------------------------- demo dataset

/**
 * One password for every seeded account, so the README can list credentials a reviewer can
 * actually paste. Defaults to the value the integration suites already use, so seeding does
 * not invalidate them.
 *
 * This is a demo credential for throwaway accounts on a demo database, which is why it is
 * allowed to appear in the repository. No real secret is committed anywhere in this project.
 */
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'TestPass!2026';

/** Argon2id with the same parameters as the auth service, so seeded logins behave identically. */
async function hashPassword(): Promise<string> {
  const argon2 = await import('argon2');
  return argon2.hash(DEMO_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

/** The UTC instant for a local wall-clock hour on a date `days` from today, in `zone`. */
async function localHourUtc(days: number, hour: number, zone: string): Promise<Date> {
  const { DateTime } = await import('luxon');
  return DateTime.now()
    .setZone(zone)
    .plus({ days })
    .set({ hour, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toJSDate();
}

async function upsertUser(
  email: string,
  fullName: string,
  roleSlug: string,
  passwordHash: string,
): Promise<string> {
  const role = await prisma.role.findUnique({ where: { slug: roleSlug }, select: { id: true } });
  if (!role) throw new Error(`role ${roleSlug} missing - seedRoles must run first`);

  const user = await prisma.user.upsert({
    where: { email },
    // The password is reset on every run on purpose: a reviewer following the README must be
    // able to log in even if someone changed it while poking at the deployment.
    update: { roleId: role.id, passwordHash, isActive: true, fullName },
    create: { email, fullName, roleId: role.id, passwordHash },
    select: { id: true },
  });
  return user.id;
}

const TZ = 'Asia/Kolkata';

/**
 * The accounts and data the brief asks a seed script to produce: a super admin, a restricted
 * sub-admin, an approved vendor, a pending vendor, two customers, and services, availability
 * and bookings in assorted states.
 *
 * Idempotent throughout - upserts keyed on email, category slug, service title, slot cell and
 * booking reference - because Render may run it on every deploy and because a reviewer will
 * run it against a database that already has data.
 */
async function seedDemo(): Promise<void> {
  const passwordHash = await hashPassword();

  const superAdminId = await upsertUser('super@marketplace.test', 'Super Admin', 'SUPER_ADMIN', passwordHash);
  await upsertUser('moderator@marketplace.test', 'Catalogue Moderator', 'CATALOGUE_MODERATOR', passwordHash);
  const vendorUserId = await upsertUser('vendor@marketplace.test', 'Approved Vendor', 'VENDOR', passwordHash);
  const pendingUserId = await upsertUser('pending@marketplace.test', 'Pending Vendor', 'VENDOR', passwordHash);
  const customer1 = await upsertUser('customer1@marketplace.test', 'Asha Customer', 'CUSTOMER', passwordHash);
  const customer2 = await upsertUser('customer2@marketplace.test', 'Bilal Customer', 'CUSTOMER', passwordHash);

  const approved = await prisma.vendorProfile.upsert({
    where: { userId: vendorUserId },
    update: { status: 'APPROVED', reviewedByUserId: superAdminId, reviewedAt: new Date() },
    create: {
      userId: vendorUserId,
      businessName: 'Bloom Salon & Spa',
      contactName: 'Asha Bloom',
      contactPhone: '+91 90000 11111',
      addressLine1: '12 Laurel Road',
      city: 'Pune',
      state: 'MH',
      postalCode: '411001',
      timezone: TZ,
      status: 'APPROVED',
      reviewedByUserId: superAdminId,
      reviewedAt: new Date(),
    },
    select: { id: true },
  });

  // Left PENDING so the approval queue has something in it and so the third gate can be
  // demonstrated: this vendor's token is refused by every write route with VENDOR_PENDING_APPROVAL.
  await prisma.vendorProfile.upsert({
    where: { userId: pendingUserId },
    update: { status: 'PENDING' },
    create: {
      userId: pendingUserId,
      businessName: 'Kettle & Co Home Repairs',
      contactName: 'Ravi Kettle',
      contactPhone: '+91 90000 22222',
      addressLine1: '4 Foundry Lane',
      city: 'Mumbai',
      state: 'MH',
      postalCode: '400001',
      timezone: TZ,
      status: 'PENDING',
    },
    select: { id: true },
  });

  const salon = await prisma.category.findUnique({ where: { slug: 'beauty-wellness-salon' }, select: { id: true } });
  const cleaning = await prisma.category.findUnique({ where: { slug: 'home-services-cleaning' }, select: { id: true } });
  if (!salon || !cleaning) throw new Error('expected seeded categories to exist');

  /** A published service with one offering and a full week of availability. */
  async function service(
    title: string,
    description: string,
    categoryId: string,
    offeringName: string,
    durationMinutes: number,
    priceMinor: number,
    capacity: number,
  ) {
    const existing = await prisma.service.findFirst({
      where: { vendorProfileId: approved.id, title },
      select: { id: true },
    });

    const row = existing
      ? await prisma.service.update({ where: { id: existing.id }, data: { status: 'PUBLISHED' }, select: { id: true } })
      : await prisma.service.create({
          data: {
            vendorProfileId: approved.id,
            categoryId,
            title,
            description,
            status: 'PUBLISHED',
            slotGranularityMinutes: 60,
            freeCancellationHours: 24,
            cancellationFeePercent: 50,
          },
          select: { id: true },
        });

    const offering = await prisma.offering.findFirst({
      where: { serviceId: row.id, name: offeringName },
      select: { id: true },
    });
    const off = offering
      ? await prisma.offering.update({
          where: { id: offering.id },
          data: { durationMinutes, priceMinor, isActive: true },
          select: { id: true },
        })
      : await prisma.offering.create({
          data: { serviceId: row.id, name: offeringName, durationMinutes, priceMinor },
          select: { id: true },
        });

    // Replaced rather than appended, matching the PUT semantics of the rules endpoint.
    await prisma.availabilityRule.deleteMany({ where: { serviceId: row.id } });
    await prisma.availabilityRule.createMany({
      data: Array.from({ length: 7 }, (_, weekday) => ({
        serviceId: row.id,
        weekday,
        startMinute: 9 * 60,
        endMinute: 17 * 60,
        capacity,
      })),
    });

    return { id: row.id, offeringId: off.id, durationMinutes, priceMinor };
  }

  const haircut = await service(
    'Precision Haircut & Styling',
    'A consultation, cut and finish with a senior stylist. Includes a wash and blow-dry.',
    salon.id,
    'Haircut & style',
    60,
    340000,
    2,
  );
  const deepClean = await service(
    'Deep Home Cleaning',
    'A two-person team, kitchen and bathrooms included, all materials supplied.',
    cleaning.id,
    'Standard deep clean',
    120,
    650000,
    1,
  );

  /**
   * Creates a booking together with the SlotCell counters it consumes, exactly as the booking
   * transaction does. Seeding the booking without the cells would advertise a seat that is
   * already taken.
   */
  async function booking(opts: {
    reference: string;
    svc: { id: string; offeringId: string; durationMinutes: number; priceMinor: number };
    customerUserId: string;
    startUtc: Date;
    status: 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
    paymentMode: 'PAY_NOW' | 'PAY_AFTER';
    paymentStatus?: 'INITIATED' | 'SUCCESS' | 'REFUNDED';
    cancellationFeeMinor?: number;
    cancelReason?: string;
  }): Promise<void> {
    const { reference, svc, startUtc, status } = opts;
    const endUtc = new Date(startUtc.getTime() + svc.durationMinutes * 60_000);

    const existing = await prisma.booking.findUnique({ where: { reference }, select: { id: true } });
    if (existing) return;

    const row = await prisma.booking.create({
      data: {
        reference,
        serviceId: svc.id,
        offeringId: svc.offeringId,
        customerUserId: opts.customerUserId,
        vendorProfileId: approved.id,
        startUtc,
        endUtc,
        status,
        priceMinor: svc.priceMinor,
        paymentMode: opts.paymentMode,
        cancellationFeeMinor: opts.cancellationFeeMinor ?? 0,
        cancelReason: opts.cancelReason ?? null,
      },
      select: { id: true },
    });

    // A terminal booking holds no seat, so only live ones consume capacity.
    const holdsCapacity = status === 'PENDING' || status === 'CONFIRMED';
    const cellCount = Math.ceil(svc.durationMinutes / 60);

    for (let i = 0; i < cellCount; i++) {
      const cellStart = new Date(startUtc.getTime() + i * 60 * 60_000);
      const cell = await prisma.slotCell.upsert({
        where: { serviceId_startUtc: { serviceId: svc.id, startUtc: cellStart } },
        update: holdsCapacity ? { bookedCount: { increment: 1 } } : {},
        create: { serviceId: svc.id, startUtc: cellStart, capacity: 2, bookedCount: holdsCapacity ? 1 : 0 },
        select: { id: true },
      });
      if (holdsCapacity) {
        await prisma.bookingSlotCell.create({ data: { bookingId: row.id, slotCellId: cell.id } });
      }
    }

    await prisma.bookingStatusHistory.create({
      data: { bookingId: row.id, fromStatus: null, toStatus: 'PENDING', actorUserId: opts.customerUserId, reason: 'created' },
    });
    if (status !== 'PENDING') {
      await prisma.bookingStatusHistory.create({
        data: {
          bookingId: row.id,
          fromStatus: 'PENDING',
          toStatus: status,
          actorUserId: status === 'CANCELLED' ? opts.customerUserId : vendorUserId,
          reason: opts.cancelReason ?? `marked ${status.toLowerCase()}`,
        },
      });
    }

    if (opts.paymentMode === 'PAY_NOW') {
      const payment = await prisma.payment.create({
        data: {
          bookingId: row.id,
          amountMinor: svc.priceMinor,
          status: opts.paymentStatus ?? 'INITIATED',
          mode: 'PAY_NOW',
          providerRef: `mock_${reference}`,
        },
        select: { id: true },
      });
      if (opts.paymentStatus === 'SUCCESS' || opts.paymentStatus === 'REFUNDED') {
        await prisma.ledgerEntry.create({
          data: { bookingId: row.id, paymentId: payment.id, type: 'CHARGE', amountMinor: svc.priceMinor },
        });
      }
      if (opts.paymentStatus === 'REFUNDED') {
        await prisma.ledgerEntry.create({
          data: {
            bookingId: row.id,
            paymentId: payment.id,
            type: 'REFUND',
            amountMinor: -(svc.priceMinor - (opts.cancellationFeeMinor ?? 0)),
          },
        });
      }
    }
  }

  // Assorted states, deliberately spanning past and future. COMPLETED and NO_SHOW must be in
  // the past because the API refuses to complete an appointment that has not happened - the
  // seed writes what the API would have written a week ago.
  await booking({
    reference: 'BK-SEEDPEND',
    svc: haircut,
    customerUserId: customer1,
    startUtc: await localHourUtc(3, 10, TZ),
    status: 'PENDING',
    paymentMode: 'PAY_AFTER',
  });
  await booking({
    reference: 'BK-SEEDCONF',
    svc: haircut,
    customerUserId: customer2,
    startUtc: await localHourUtc(4, 11, TZ),
    status: 'CONFIRMED',
    paymentMode: 'PAY_NOW',
    paymentStatus: 'SUCCESS',
  });
  await booking({
    reference: 'BK-SEEDDONE',
    svc: haircut,
    customerUserId: customer1,
    startUtc: await localHourUtc(-7, 12, TZ),
    status: 'COMPLETED',
    paymentMode: 'PAY_NOW',
    paymentStatus: 'SUCCESS',
  });
  await booking({
    reference: 'BK-SEEDCANC',
    svc: deepClean,
    customerUserId: customer2,
    startUtc: await localHourUtc(-2, 9, TZ),
    status: 'CANCELLED',
    paymentMode: 'PAY_NOW',
    paymentStatus: 'REFUNDED',
    cancellationFeeMinor: 325000,
    cancelReason: 'Cancelled inside the 24-hour window, 50% fee applied',
  });
  await booking({
    reference: 'BK-SEEDNOSH',
    svc: haircut,
    customerUserId: customer2,
    startUtc: await localHourUtc(-5, 15, TZ),
    status: 'NO_SHOW',
    paymentMode: 'PAY_AFTER',
    cancelReason: 'Customer did not arrive',
  });

  console.log('[seed] demo accounts, 2 published services, availability and 5 bookings ready');
}

async function main(): Promise<void> {
  const permissionIds = await seedPermissions();
  console.log(`[seed] permissions: ${permissionIds.size}`);
  await seedRoles(permissionIds);
  await seedCategories();
  await seedDemo();

  const [permissions, roles, links, categories, users, services, bookings] = await Promise.all([
    prisma.permission.count(),
    prisma.role.count(),
    prisma.rolePermission.count(),
    prisma.category.count(),
    prisma.user.count(),
    prisma.service.count(),
    prisma.booking.count(),
  ]);
  console.log(
    `[seed] done. permissions=${permissions} roles=${roles} rolePermissions=${links} ` +
      `categories=${categories} users=${users} services=${services} bookings=${bookings}`,
  );
}

main()
  .catch((err) => {
    console.error('[seed] failed', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
