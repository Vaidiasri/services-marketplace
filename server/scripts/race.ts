/**
 * The capacity race the brief names explicitly:
 *
 *   "Firing 20 simultaneous bookings at a slot with capacity 3 yields exactly 3 bookings.
 *    Include the script and its output in the repository."
 *
 * Twenty requests go out through Promise.all with distinct Idempotency-Keys - distinct so
 * that idempotency cannot be what limits the count. What limits it is the row lock in
 * capacity.repository.ts.
 *
 * Asserts four things, because three of them can pass while the system is still wrong:
 *   1. exactly 3 succeeded
 *   2. the other 17 failed with 409 SLOT_FULL - a clean refusal, not a 500
 *   3. SlotCell.bookedCount is exactly 3 - the counter agrees with the bookings
 *   4. exactly 3 Booking rows exist for that slot - no orphan increment
 *
 * Run against local:     npx ts-node scripts/race.ts
 * Run against deployed:  API_URL=https://... DATABASE_URL=... npx ts-node scripts/race.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const API = process.env.API_URL ?? 'http://localhost:3000';
const CONCURRENCY = 20;
const CAPACITY = 3;
const ADMIN_PW = process.env.TEST_ADMIN_PASSWORD ?? 'TestPass!2026';

const prisma = new PrismaClient();

async function call(path: string, opts: RequestInit = {}, token?: string, key?: string) {
  const headers: Record<string, string> = { ...((opts.headers as Record<string, string>) ?? {}) };
  if (opts.body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['idempotency-key'] = key;
  const res = await fetch(API + path, { ...opts, headers });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body: body as Record<string, unknown> };
}

const post = (p: string, b?: unknown, t?: string, k?: string) =>
  call(p, { method: 'POST', body: JSON.stringify(b ?? {}) }, t, k);
const patch = (p: string, b: unknown, t?: string) =>
  call(p, { method: 'PATCH', body: JSON.stringify(b) }, t);
const put = (p: string, b: unknown, t?: string) =>
  call(p, { method: 'PUT', body: JSON.stringify(b) }, t);

/** Local date `days` ahead in the vendor's zone. */
function localDate(days: number, zone = 'Asia/Kolkata'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, dateStyle: 'short' }).format(
    new Date(Date.now() + days * 86_400_000),
  );
}

async function main(): Promise<void> {
  const stamp = Date.now();
  console.log(`race: ${CONCURRENCY} concurrent bookings at a capacity-${CAPACITY} slot`);
  console.log(`api:  ${API}\n`);

  const su = (await post('/auth/login', { email: 'super@marketplace.test', password: ADMIN_PW }))
    .body.accessToken as string;
  if (!su) throw new Error('could not sign in as super admin - has the seed been run?');

  // ---- a vendor with one published service, capacity 3 on the target slot
  const vendor = await post('/auth/register/vendor', {
    email: `race${stamp}@marketplace.test`,
    password: 'correct-horse',
    fullName: 'Race Vendor',
    businessName: `Race Co ${stamp}`,
    contactName: 'R',
    contactPhone: '+91 90000 00000',
    addressLine1: '1 Race Road',
    city: 'Pune',
    state: 'MH',
    postalCode: '411001',
    timezone: 'Asia/Kolkata',
  });
  const vToken = vendor.body.accessToken as string;
  const vProfile = (vendor.body.vendorProfile as { id: string }).id;
  await patch(`/admin/vendors/${vProfile}/approve`, {}, su);

  const categories = (await call('/categories?flat=true')).body as unknown as { id: string; parentId: string | null }[];
  const categoryId = categories.find((c) => c.parentId)!.id;

  const service = await post(
    '/services',
    {
      title: `Race Service ${stamp}`,
      description: 'A service used solely to prove capacity holds under concurrency.',
      categoryId,
      slotGranularityMinutes: 60,
      freeCancellationHours: 24,
      cancellationFeePercent: 50,
    },
    vToken,
  );
  const serviceId = service.body.id as string;

  const offering = await post(
    `/services/${serviceId}/offerings`,
    { name: 'Race Slot', durationMinutes: 60, priceMinor: 100000 },
    vToken,
  );
  const offeringId = offering.body.id as string;

  await put(
    `/services/${serviceId}/availability/rules`,
    {
      rules: Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        startMinute: 9 * 60,
        endMinute: 10 * 60,
        capacity: CAPACITY,
      })),
    },
    vToken,
  );
  await post(`/services/${serviceId}/publish`, {}, vToken);

  // ---- the single slot everyone will fight over
  const day = localDate(3);
  const slots = (await call(`/services/${serviceId}/slots?offeringId=${offeringId}&from=${day}&to=${day}`))
    .body as unknown as { slots: { startUtc: string; capacity: number }[] };
  const target = slots.slots[0];
  if (!target) throw new Error('no slot generated - availability setup failed');
  console.log(`target slot: ${target.startUtc}  capacity ${target.capacity}\n`);

  // ---- 20 customers, so nothing is serialised by one account's own idempotency
  // A POOL of customers, not one per request. Registration is rate-limited to 10 per minute
  // (auth.controller.ts) - a deliberate anti-account-farming limit that the race has no
  // business weakening, and an earlier version of this script tripped it: ten registrations
  // silently returned no token, ten bookings went out unauthenticated, and ten 401s were
  // being counted as refusals. Twenty 401s look exactly like seventeen refusals if nobody
  // checks the codes.
  //
  // Capacity is a property of the SLOT, not of the customer, so 20 concurrent requests spread
  // across 5 accounts contend on precisely the same rows. Idempotency keys are distinct, so
  // nothing is deduplicated either.
  const POOL = 5;
  const customers: string[] = [];
  for (let i = 0; i < POOL; i++) {
    const r = await post('/auth/register/customer', {
      email: `racer${stamp}_${i}@marketplace.test`,
      password: 'correct-horse',
      fullName: `Racer ${i}`,
    });
    const token = r.body.accessToken as string | undefined;
    if (!token) throw new Error(`customer ${i} could not register: ${r.status} ${JSON.stringify(r.body)}`);
    customers.push(token);
  }
  console.log(`${customers.length} customers registered, firing ${CONCURRENCY} bookings across them\n`);

  // ---- fire
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      post(
        '/bookings',
        { serviceId, offeringId, startUtc: target.startUtc, paymentMode: 'PAY_AFTER' },
        customers[i % customers.length],
        `race-${stamp}-${i}`,
      ),
    ),
  );
  const elapsed = Date.now() - started;

  // ---- results
  const created = results.filter((r) => r.status === 201);
  const conflicted = results.filter((r) => r.status === 409);
  const other = results.filter((r) => r.status !== 201 && r.status !== 409);

  const codes = new Map<string, number>();
  for (const r of results) {
    const code =
      r.status === 201 ? '201 CREATED' : `${r.status} ${(r.body?.error as { code?: string })?.code ?? '?'}`;
    codes.set(code, (codes.get(code) ?? 0) + 1);
  }

  console.log(`created=${created.length} conflicted=${conflicted.length} other=${other.length}  (${elapsed} ms)`);
  for (const [code, n] of [...codes].sort()) console.log(`  ${String(n).padStart(2)} x ${code}`);

  const cell = await prisma.slotCell.findFirst({
    where: { serviceId, startUtc: new Date(target.startUtc) },
    select: { capacity: true, bookedCount: true },
  });
  const bookingCount = await prisma.booking.count({
    where: { serviceId, startUtc: new Date(target.startUtc) },
  });

  console.log(`\nSlotCell: capacity=${cell?.capacity} bookedCount=${cell?.bookedCount}`);
  console.log(`Booking rows for that slot: ${bookingCount}`);

  const checks: [boolean, string][] = [
    [created.length === CAPACITY, `exactly ${CAPACITY} bookings created`],
    [conflicted.length === CONCURRENCY - CAPACITY, `the other ${CONCURRENCY - CAPACITY} refused`],
    [
      conflicted.every((r) => (r.body?.error as { code?: string })?.code === 'SLOT_FULL'),
      'every refusal is a clean 409 SLOT_FULL',
    ],
    [other.length === 0, 'no request produced a 500 or any other status'],
    [cell?.bookedCount === CAPACITY, `SlotCell.bookedCount is exactly ${CAPACITY}`],
    [bookingCount === CAPACITY, `exactly ${CAPACITY} Booking rows exist for the slot`],
  ];

  console.log('');
  let failed = 0;
  for (const [pass, label] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
    if (!pass) failed++;
  }

  await prisma.$disconnect();
  console.log(failed === 0 ? '\nRESULT: capacity held.' : `\nRESULT: ${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('race script failed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
