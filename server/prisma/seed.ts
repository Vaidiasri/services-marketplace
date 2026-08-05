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

async function main(): Promise<void> {
  const permissionIds = await seedPermissions();
  console.log(`[seed] permissions: ${permissionIds.size}`);
  await seedRoles(permissionIds);
  await seedCategories();

  const [permissions, roles, links, categories] = await Promise.all([
    prisma.permission.count(),
    prisma.role.count(),
    prisma.rolePermission.count(),
    prisma.category.count(),
  ]);
  console.log(
    `[seed] done. permissions=${permissions} roles=${roles} ` +
      `rolePermissions=${links} categories=${categories}`,
  );
}

main()
  .catch((err) => {
    console.error('[seed] failed', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
