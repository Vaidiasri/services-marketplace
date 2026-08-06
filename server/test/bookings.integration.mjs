/**
 * M6 booking lifecycle end to end.
 *
 * The brief's DONE WHEN items asserted here:
 *   - a customer calling complete gets 403; a vendor calling it on a PENDING booking gets 422
 *   - Vendor A requesting Vendor B's booking never gets the record
 *   - the status timeline reads correctly after book -> reschedule -> cancel
 *
 * The 20-way capacity race lives in scripts/race.ts with its committed output, because the
 * brief asks for that one as a script.
 *
 * Run: node test/bookings.integration.mjs   (from server/)
 */
import { PrismaClient } from '@prisma/client';

const B = process.env.API_URL ?? 'http://localhost:3000';
const prisma = new PrismaClient();

let pass = 0;
let fail = 0;
const ok = (cond, label, extra) => {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${extra !== undefined ? `  <- ${extra}` : ''}`);
  }
};

async function call(path, opts = {}, token, key) {
  const headers = { ...(opts.headers ?? {}) };
  if (opts.body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['idempotency-key'] = key;
  const res = await fetch(B + path, { ...opts, headers });
  let body = null;
  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      body = await res.json();
    } catch {
      /* 204 */
    }
  }
  return { status: res.status, body };
}
const post = (p, b, t, k) => call(p, { method: 'POST', body: JSON.stringify(b ?? {}) }, t, k);
const put = (p, b, t) => call(p, { method: 'PUT', body: JSON.stringify(b) }, t);
const patch = (p, b, t) => call(p, { method: 'PATCH', body: JSON.stringify(b ?? {}) }, t);

const IST = 'Asia/Kolkata';
const localDate = (days) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: IST, dateStyle: 'short' }).format(
    new Date(Date.now() + days * 86_400_000),
  );

const code = (r) => r.body?.error?.code;

(async () => {
  const stamp = Date.now();
  let r;

  const su = (
    await post('/auth/login', {
      email: 'super@marketplace.test',
      password: process.env.TEST_ADMIN_PASSWORD ?? 'TestPass!2026',
    })
  ).body.accessToken;

  async function vendor(suffix) {
    const v = await post('/auth/register/vendor', {
      email: `bk${stamp}${suffix}@marketplace.test`,
      password: 'correct-horse',
      fullName: `Booking Vendor ${suffix}`,
      businessName: `Booking Co ${stamp}${suffix}`,
      contactName: 'B',
      contactPhone: '+91 90000 00000',
      addressLine1: '1 Booking Lane',
      city: 'Pune',
      state: 'MH',
      postalCode: '411001',
      timezone: IST,
    });
    const out = { token: v.body.accessToken, profileId: v.body.vendorProfile.id };
    await patch(`/admin/vendors/${out.profileId}/approve`, {}, su);
    return out;
  }

  async function customer(suffix) {
    const c = await post('/auth/register/customer', {
      email: `bc${stamp}${suffix}@marketplace.test`,
      password: 'correct-horse',
      fullName: `Booking Customer ${suffix}`,
    });
    return c.body.accessToken;
  }

  const a = await vendor('a');
  const b = await vendor('b');
  const cust = await customer('1');
  const other = await customer('2');
  ok(!!su && !!a.token && !!b.token && !!cust && !!other, 'two vendors and two customers');

  const leaf = (await call('/categories?flat=true')).body.find((c) => c.parentId);

  /** A published service open every day 09:00-13:00, capacity 2, with one 60-minute offering. */
  async function publishedService(owner, title, capacity = 2) {
    const s = await post(
      '/services',
      {
        title,
        description: 'A service used to exercise the booking lifecycle end to end.',
        categoryId: leaf.id,
        slotGranularityMinutes: 60,
        freeCancellationHours: 24,
        cancellationFeePercent: 50,
      },
      owner.token,
    );
    const o = await post(
      `/services/${s.body.id}/offerings`,
      { name: 'Session', durationMinutes: 60, priceMinor: 200000 },
      owner.token,
    );
    await put(
      `/services/${s.body.id}/availability/rules`,
      {
        rules: Array.from({ length: 7 }, (_, weekday) => ({
          weekday,
          startMinute: 9 * 60,
          endMinute: 13 * 60,
          capacity,
        })),
      },
      owner.token,
    );
    await post(`/services/${s.body.id}/publish`, {}, owner.token);
    return { id: s.body.id, offeringId: o.body.id };
  }

  const svcA = await publishedService(a, `Booking Service A ${stamp}`);
  const svcB = await publishedService(b, `Booking Service B ${stamp}`);

  const day = localDate(5);
  const slotsOf = async (svc) =>
    (await call(`/services/${svc.id}/slots?offeringId=${svc.offeringId}&from=${day}&to=${day}`))
      .body.slots;
  const slotsA = await slotsOf(svcA);
  ok(slotsA.length === 4, 'four 60-minute slots on the target day', slotsA.length);

  const bookAt = (svc, startUtc, token, key, mode = 'PAY_AFTER') =>
    post(
      '/bookings',
      { serviceId: svc.id, offeringId: svc.offeringId, startUtc, paymentMode: mode },
      token,
      key,
    );

  // ============================================================ create

  r = await post('/bookings', { serviceId: svcA.id, offeringId: svcA.offeringId, startUtc: slotsA[0].startUtc, paymentMode: 'PAY_AFTER' }, cust);
  ok(
    r.status === 400 && code(r) === 'IDEMPOTENCY_KEY_REQUIRED',
    'a booking with no Idempotency-Key -> 400 IDEMPOTENCY_KEY_REQUIRED',
    `${r.status} ${code(r)}`,
  );

  r = await bookAt(svcA, slotsA[0].startUtc, cust, `k1-${stamp}`);
  ok(r.status === 201, 'a valid booking -> 201', `${r.status} ${JSON.stringify(r.body?.error)}`);
  const booking = r.body.booking;
  ok(booking?.status === 'PENDING', 'created as PENDING', booking?.status);
  ok(booking?.priceMinor === 200000, 'price snapshotted from the offering row', booking?.priceMinor);
  ok(booking?.customerUserId && booking.customerUserId !== a.profileId, 'customer is the authenticated user');
  ok(!!booking?.reference, 'and it has a human-quotable reference', booking?.reference);
  ok(r.body.payment === null, 'PAY_AFTER opens no payment', JSON.stringify(r.body.payment));

  // --- price and status cannot be sent
  r = await call('/bookings', {
    method: 'POST',
    body: JSON.stringify({ serviceId: svcA.id, offeringId: svcA.offeringId, startUtc: slotsA[1].startUtc, paymentMode: 'PAY_AFTER', priceMinor: 1 }),
  }, cust, `k-price-${stamp}`);
  ok(r.status === 422, 'sending priceMinor in the body -> 422, the field does not exist', `${r.status} ${code(r)}`);

  r = await call('/bookings', {
    method: 'POST',
    body: JSON.stringify({ serviceId: svcA.id, offeringId: svcA.offeringId, startUtc: slotsA[1].startUtc, paymentMode: 'PAY_AFTER', customerUserId: 'someone-else' }),
  }, cust, `k-cust-${stamp}`);
  ok(r.status === 422, 'and so is naming another customer', r.status);

  // --- idempotency
  r = await bookAt(svcA, slotsA[0].startUtc, cust, `k1-${stamp}`);
  ok(r.status === 201 && r.body.replayed === true, 'replaying the same key returns the stored response', `${r.status} ${r.body?.replayed}`);
  ok(r.body.booking?.id === booking.id, 'the same booking, not a second one', r.body.booking?.id);

  const countAfterReplay = await prisma.booking.count({ where: { id: booking.id } });
  ok(countAfterReplay === 1, 'and exactly one row exists', countAfterReplay);

  r = await bookAt(svcA, slotsA[1].startUtc, cust, `k1-${stamp}`);
  ok(
    r.status === 409 && code(r) === 'IDEMPOTENCY_KEY_REUSED',
    'the same key with a different body -> 409 IDEMPOTENCY_KEY_REUSED',
    `${r.status} ${code(r)}`,
  );

  // Another user's identical key collides with nothing: keys are scoped per user.
  r = await bookAt(svcA, slotsA[0].startUtc, other, `k1-${stamp}`);
  ok(r.status === 201 && !r.body.replayed, "a different customer's identical key is a fresh booking", `${r.status} ${r.body?.replayed}`);
  const secondBooking = r.body.booking;

  // --- the slot is now full (capacity 2)
  const third = await customer('3');
  r = await bookAt(svcA, slotsA[0].startUtc, third, `k3-${stamp}`);
  ok(r.status === 409 && code(r) === 'SLOT_FULL', 'the third booking at a capacity-2 slot -> 409 SLOT_FULL', `${r.status} ${code(r)}`);

  r = await call(`/services/${svcA.id}/slots?offeringId=${svcA.offeringId}&from=${day}&to=${day}`);
  ok(
    !r.body.slots.some((s) => s.startUtc === slotsA[0].startUtc),
    'and the slot stops being offered',
  );

  // --- invented start times
  r = await bookAt(svcA, '2026-08-09T04:07:00.000Z', cust, `k-off-${stamp}`);
  ok(r.status === 422 && code(r) === 'INVALID_SLOT', 'an off-grid start -> 422 INVALID_SLOT', `${r.status} ${code(r)}`);

  r = await bookAt(svcA, new Date(Date.now() - 86_400_000).toISOString(), cust, `k-past-${stamp}`);
  ok(r.status === 422 && code(r) === 'SLOT_IN_PAST', 'a start in the past -> 422 SLOT_IN_PAST', `${r.status} ${code(r)}`);

  // Another service's offering cannot be borrowed to price this one.
  r = await post('/bookings', { serviceId: svcA.id, offeringId: svcB.offeringId, startUtc: slotsA[1].startUtc, paymentMode: 'PAY_AFTER' }, cust, `k-x-${stamp}`);
  ok(r.status === 422, "another service's offering -> 422", r.status);

  // ============================================================ the DONE WHEN pair

  r = await patch(`/bookings/${booking.id}/complete`, {}, cust);
  ok(
    r.status === 403 && code(r) === 'FORBIDDEN',
    'a CUSTOMER calling complete -> 403, refused by the permission guard',
    `${r.status} ${code(r)}`,
  );

  r = await patch(`/bookings/${booking.id}/complete`, {}, a.token);
  ok(
    r.status === 422 && code(r) === 'ILLEGAL_TRANSITION',
    'a VENDOR calling complete on a PENDING booking -> 422 ILLEGAL_TRANSITION',
    `${r.status} ${code(r)}`,
  );
  ok(
    r.body?.error?.details?.allowed?.includes('CONFIRMED'),
    'and the error names what IS allowed from PENDING',
    JSON.stringify(r.body?.error?.details),
  );

  // ============================================================ cross-tenant

  r = await call(`/bookings/${booking.id}`, {}, b.token);
  ok(r.status === 404, "Vendor B reading Vendor A's booking -> 404, never the record", r.status);
  ok(!JSON.stringify(r.body ?? {}).includes(booking.reference), 'and the body leaks no field from it');

  r = await patch(`/bookings/${booking.id}/confirm`, {}, b.token);
  ok(r.status === 404, "Vendor B confirming it -> 404", r.status);

  r = await call(`/bookings/${booking.id}`, {}, other);
  ok(r.status === 404, "another customer reading it -> 404", r.status);

  r = await call(`/bookings/${booking.id}`, {}, su);
  ok(r.status === 200, 'a super admin may read it', r.status);

  // A customer's list shows only their own.
  r = await call('/bookings?pageSize=100', {}, cust);
  ok(r.status === 200 && r.body.data.every((x) => x.customerUserId === booking.customerUserId), "the customer's list is scoped to them", r.body?.meta?.total);
  r = await call('/bookings?pageSize=100', {}, a.token);
  ok(r.body.data.every((x) => x.vendorProfileId === a.profileId), "and the vendor's to their own profile");

  // ============================================================ transitions

  r = await patch(`/bookings/${booking.id}/confirm`, {}, a.token);
  ok(r.status === 200 && r.body?.status === 'CONFIRMED', 'the vendor confirms -> CONFIRMED', `${r.status} ${r.body?.status}`);

  r = await patch(`/bookings/${booking.id}/reject`, { reason: 'Changed my mind about this' }, a.token);
  ok(r.status === 422 && code(r) === 'ILLEGAL_TRANSITION', 'reject after confirm -> 422, reject is PENDING-only', `${r.status} ${code(r)}`);

  r = await patch(`/bookings/${booking.id}/complete`, {}, a.token);
  ok(
    r.status === 422 && code(r) === 'TOO_EARLY_TO_COMPLETE',
    'completing before the appointment ends -> 422 TOO_EARLY_TO_COMPLETE',
    `${r.status} ${code(r)}`,
  );

  r = await patch(`/bookings/${booking.id}/no-show`, { reason: 'Customer did not arrive' }, a.token);
  ok(r.status === 422 && code(r) === 'TOO_EARLY_FOR_NO_SHOW', 'and no-show before it starts -> 422', `${r.status} ${code(r)}`);

  r = await patch(`/bookings/${booking.id}/reject`, {}, a.token);
  ok(r.status === 422, 'reject with no reason -> 422', r.status);

  // ============================================================ PAY_NOW gate

  const payNow = (await bookAt(svcA, slotsA[2].startUtc, cust, `k-pay-${stamp}`, 'PAY_NOW')).body;
  ok(payNow.payment?.status === 'INITIATED', 'a PAY_NOW booking opens an INITIATED payment', payNow.payment?.status);

  r = await patch(`/bookings/${payNow.booking.id}/confirm`, {}, a.token);
  ok(
    r.status === 422 && code(r) === 'PAYMENT_REQUIRED',
    'confirming a PAY_NOW booking before payment succeeds -> 422 PAYMENT_REQUIRED',
    `${r.status} ${code(r)}`,
  );

  // M7 supplies the gateway; here the row is moved directly so the gate's other branch is
  // proven rather than left as dead code.
  await prisma.payment.updateMany({ where: { bookingId: payNow.booking.id }, data: { status: 'SUCCESS' } });
  r = await patch(`/bookings/${payNow.booking.id}/confirm`, {}, a.token);
  ok(r.status === 200 && r.body?.status === 'CONFIRMED', 'once it succeeds, confirm works', `${r.status} ${r.body?.status}`);

  // ============================================================ reschedule

  const before = (await call(`/bookings/${booking.id}`, {}, cust)).body;
  const freeSlot = slotsA[3].startUtc;

  r = await patch(`/bookings/${booking.id}/reschedule`, { startUtc: freeSlot }, cust);
  ok(r.status === 200 && r.body?.startUtc === freeSlot, 'the customer reschedules -> 200', `${r.status} ${r.body?.startUtc}`);
  ok(r.body?.status === 'CONFIRMED', 'and the status is unchanged - a confirmed booking stays confirmed', r.body?.status);

  // The old cell was released, so the previously-full slot is bookable again.
  r = await call(`/services/${svcA.id}/slots?offeringId=${svcA.offeringId}&from=${day}&to=${day}`);
  ok(
    r.body.slots.some((s) => s.startUtc === slotsA[0].startUtc),
    'the vacated slot is offered again, so the old cell really was released',
    r.body.slots.map((s) => s.startUtc).join(' '),
  );

  r = await patch(`/bookings/${booking.id}/reschedule`, { startUtc: freeSlot }, cust);
  ok(r.status === 200, 'rescheduling to the same slot is a no-op -> 200', r.status);

  // Reschedule into a slot that is full leaves the original untouched.
  const fullSlot = slotsA[2].startUtc;
  const filler = await customer('4');
  await bookAt(svcA, fullSlot, filler, `k-fill-${stamp}`);
  r = await patch(`/bookings/${booking.id}/reschedule`, { startUtc: fullSlot }, cust);
  ok(r.status === 409 && code(r) === 'SLOT_FULL', 'rescheduling into a full slot -> 409 SLOT_FULL', `${r.status} ${code(r)}`);
  r = await call(`/bookings/${booking.id}`, {}, cust);
  ok(r.body?.startUtc === freeSlot && r.body?.status === 'CONFIRMED', 'and the original booking is untouched', `${r.body?.startUtc}`);

  r = await patch(`/bookings/${booking.id}/reschedule`, { startUtc: freeSlot }, other);
  ok(r.status === 404, "another customer rescheduling it -> 404", r.status);

  // ============================================================ cancellation policy

  // Five days out, so comfortably outside the 24-hour window: free.
  r = await patch(`/bookings/${booking.id}/cancel`, { reason: 'No longer needed' }, cust);
  ok(r.status === 200 && r.body?.status === 'CANCELLED', 'the customer cancels -> CANCELLED', `${r.status} ${r.body?.status}`);
  ok(r.body?.cancellation?.isLate === false, 'five days ahead is not late', JSON.stringify(r.body?.cancellation));
  ok(r.body?.cancellationFeeMinor === 0, 'so no fee is charged', r.body?.cancellationFeeMinor);

  r = await patch(`/bookings/${booking.id}/cancel`, { reason: 'again' }, cust);
  ok(r.status === 422 && code(r) === 'ILLEGAL_TRANSITION', 'cancelling an already-cancelled booking -> 422', `${r.status} ${code(r)}`);

  // A late cancellation charges the fee. The booking is moved close to now through Prisma,
  // because the API refuses to create a booking in the past - which is the point.
  const lateBooking = (await bookAt(svcA, slotsA[1].startUtc, cust, `k-late-${stamp}`)).body.booking;
  await prisma.booking.update({
    where: { id: lateBooking.id },
    data: { startUtc: new Date(Date.now() + 3_600_000), endUtc: new Date(Date.now() + 7_200_000) },
  });
  r = await patch(`/bookings/${lateBooking.id}/cancel`, { reason: 'Emergency' }, cust);
  ok(r.status === 200 && r.body?.cancellation?.isLate === true, 'cancelling an hour before the start is late', JSON.stringify(r.body?.cancellation));
  ok(
    r.body?.cancellationFeeMinor === 100000,
    'and forfeits 50% of the 2000.00 price, computed server-side',
    r.body?.cancellationFeeMinor,
  );

  // ============================================================ force-cancel

  const forced = (await bookAt(svcA, slotsA[1].startUtc, other, `k-force-${stamp}`)).body.booking;
  await prisma.booking.update({
    where: { id: forced.id },
    data: { startUtc: new Date(Date.now() + 3_600_000), endUtc: new Date(Date.now() + 7_200_000) },
  });

  r = await patch(`/admin/bookings/${forced.id}/force-cancel`, { reason: 'Vendor reported an outage' }, a.token);
  ok(r.status === 403, 'a vendor cannot force-cancel - it is a separate admin permission', r.status);

  r = await patch(`/admin/bookings/${forced.id}/force-cancel`, {}, su);
  ok(r.status === 422, 'force-cancel with no reason -> 422', r.status);

  r = await patch(`/admin/bookings/${forced.id}/force-cancel`, { reason: 'Vendor reported an outage' }, su);
  ok(r.status === 200 && r.body?.status === 'CANCELLED', 'an admin force-cancels -> CANCELLED', `${r.status} ${r.body?.status}`);
  ok(
    r.body?.cancellationFeeMinor === 0,
    'with no fee, though the same timing would have charged the customer',
    r.body?.cancellationFeeMinor,
  );

  // ============================================================ the timeline

  r = await call(`/bookings/${booking.id}`, {}, cust);
  const history = r.body.history;
  ok(Array.isArray(history) && history.length === 4, 'the timeline has four entries', history?.length);
  ok(history[0].fromStatus === null && history[0].toStatus === 'PENDING', 'created -> PENDING', JSON.stringify(history[0]));
  ok(history[1].toStatus === 'CONFIRMED', 'then CONFIRMED', history[1]?.toStatus);
  ok(
    history[2].fromStatus === 'CONFIRMED' && history[2].toStatus === 'CONFIRMED',
    'then the reschedule, recorded with from == to because the status did not change',
    JSON.stringify(history[2]),
  );
  ok(history[2].reason?.startsWith('rescheduled from'), 'and its reason names both times', history[2]?.reason);
  ok(history[3].toStatus === 'CANCELLED', 'then CANCELLED', history[3]?.toStatus);
  ok(
    history.every((h) => !!h.actorUserId),
    'every entry records who did it',
  );

  // ============================================================ suspension stops new bookings

  // Re-authenticate first. Access tokens live 15 minutes and this suite now runs longer than
  // that against a remote database, so the last few requests were failing with
  // 401 TOKEN_EXPIRED - the tokens really had expired, which is the auth layer working.
  const relogin = async (email) =>
    (await post('/auth/login', { email, password: 'correct-horse' })).body.accessToken;
  const custFresh = await relogin(`bc${stamp}1@marketplace.test`);
  const otherFresh = await relogin(`bc${stamp}2@marketplace.test`);
  const suFresh = (
    await post('/auth/login', {
      email: 'super@marketplace.test',
      password: process.env.TEST_ADMIN_PASSWORD ?? 'TestPass!2026',
    })
  ).body.accessToken;
  ok(!!custFresh && !!otherFresh && !!suFresh, 're-authenticated for the final section');

  await post(`/admin/services/${svcA.id}/suspend`, { reason: 'Investigating a complaint here' }, suFresh);
  r = await bookAt(svcA, slotsA[3].startUtc, custFresh, `k-susp-${stamp}`);
  ok(
    r.status === 404,
    'booking a SUSPENDED service -> 404, because create resolves through publicServiceWhere()',
    `${r.status} ${code(r)}`,
  );
  // Read as `other`, who made it. Reading it as `cust` correctly 404s, which is the
  // cross-tenant rule doing its job rather than the suspension affecting anything.
  r = await call(`/bookings/${secondBooking.id}`, {}, otherFresh);
  ok(r.status === 200 && r.body.status !== 'CANCELLED', 'while the bookings already made survive it', `${r.status} ${r.body?.status}`);
  await post(`/admin/services/${svcA.id}/unsuspend`, {}, suFresh);

  await prisma.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error('suite crashed', err);
  await prisma.$disconnect();
  process.exit(1);
});
