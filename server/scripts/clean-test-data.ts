/**
 * Removes accounts and data left behind by the integration suites and scripts/race.ts.
 *
 * Every suite registers throwaway accounts named with a `Date.now()` stamp, so a database
 * that has been tested against accumulates hundreds of them - and a reviewer browsing the
 * deployed catalogue would page through "Slot Service 1785988016759" instead of the seeded
 * demo listings.
 *
 * The match is deliberately narrow: a known test prefix, THEN at least ten digits, THEN
 * exactly the marketplace.test domain. Real accounts (any other domain) and the seeded demo
 * accounts (no digits in their local part) cannot match it. Nothing here deletes by "everything
 * that is not seeded", which would be one typo away from removing a reviewer's own signups.
 *
 * Run: npx ts-node scripts/clean-test-data.ts        (add --dry-run to only report)
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Prefixes used by the suites: uploads, catalog, availability, bookings, timezone, race.
 *
 * The trailing `[a-z0-9_]*` matters - the suites append a discriminator (`...941a`, `..._0`)
 * after the stamp, and without it this matched only 48 of the 124 test accounts.
 */
const TEST_EMAIL = /^(up|cat|av|bk|bc|tz|race|racer|cust|vendor)\d{10,}[a-z0-9_]*@marketplace\.test$/;

async function main(): Promise<void> {
  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  const doomed = users.filter((u) => TEST_EMAIL.test(u.email));
  const kept = users.filter((u) => !TEST_EMAIL.test(u.email));

  console.log(`${users.length} users: ${doomed.length} match the test pattern, ${kept.length} kept`);
  console.log('kept:', kept.map((u) => u.email).sort().join(', ') || '(none)');

  if (doomed.length === 0) {
    console.log('nothing to do');
    return;
  }
  if (DRY_RUN) {
    console.log('\n--dry-run: no rows deleted');
    return;
  }

  const ids = doomed.map((u) => u.id);
  const profiles = await prisma.vendorProfile.findMany({
    where: { userId: { in: ids } },
    select: { id: true },
  });
  const profileIds = profiles.map((p) => p.id);

  // Bookings go first. Booking's relations to Service and User are required and therefore
  // restrict on delete, so removing the users while their bookings exist fails - and a booking
  // made by a kept customer against a doomed vendor's service has to go too, because the
  // service is about to.
  const bookings = await prisma.booking.deleteMany({
    where: {
      OR: [{ customerUserId: { in: ids } }, { vendorProfileId: { in: profileIds } }],
    },
  });

  // Everything else cascades from User: vendor profiles, their services, offerings,
  // availability rules, slot cells, refresh tokens and idempotency keys.
  const deleted = await prisma.user.deleteMany({ where: { id: { in: ids } } });

  const [remainingUsers, remainingServices, remainingBookings] = await Promise.all([
    prisma.user.count(),
    prisma.service.count(),
    prisma.booking.count(),
  ]);

  console.log(`\ndeleted ${bookings.count} bookings and ${deleted.count} users`);
  console.log(`remaining: users=${remainingUsers} services=${remainingServices} bookings=${remainingBookings}`);
}

main()
  .catch((err) => {
    console.error('cleanup failed', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
