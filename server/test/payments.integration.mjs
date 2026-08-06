/**
 * M7 mocked payments.
 *
 * The brief's DONE WHEN items asserted here:
 *   - replaying one Idempotency-Key twice yields one booking and one payment
 *   - a forced payment failure leaves the slot bookable by someone else
 *   - both modes work, and the refund path leaves consistent state
 *
 * Outcomes come from deterministic tokens, so every path here is triggered on demand rather
 * than waited for.
 *
 * Run: node test/payments.integration.mjs   (from server/)
 */
import { PrismaClient } from '@prisma/client';
import { createHmac } from 'node:crypto';

const B = process.env.API_URL ?? 'http://localhost:3000';
const SECRET = process.env.MOCK_WEBHOOK_SECRET ?? 'mock-webhook-secret';
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
const code = (r) => r.body?.error?.code;

const IST = 'Asia/Kolkata';
const localDate = (days) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: IST, dateStyle: 'short' }).format(
    new Date(Date.now() + days * 86_400_000),
  );

/** Signs a webhook body exactly as MockPaymentProvider does. */
function signed(payload) {
  const raw = JSON.stringify(payload);
  return { raw, signature: createHmac('sha256', SECRET).update(Buffer.from(raw)).digest('hex') };
}

async function webhook(payload, signature) {
  const { raw, signature: real } = signed(payload);
  const res = await fetch(`${B}/payments/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mock-signature': signature ?? real },
    body: raw,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, body };
}

(async () => {
  const stamp = Date.now();
  let r;

  const su = (
    await post('/auth/login', {
      email: 'super@marketplace.test',
      password: process.env.TEST_ADMIN_PASSWORD ?? 'TestPass!2026',
    })
  ).body.accessToken;

  const v = await post('/auth/register/vendor', {
    email: `pv${stamp}a@marketplace.test`,
    password: 'correct-horse',
    fullName: 'Payments Vendor',
    businessName: `Payments Co ${stamp}`,
    contactName: 'P',
    contactPhone: '+91 90000 00000',
    addressLine1: '1 Ledger Lane',
    city: 'Pune',
    state: 'MH',
    postalCode: '411001',
    timezone: IST,
  });
  const vendorToken = v.body.accessToken;
  await patch(`/admin/vendors/${v.body.vendorProfile.id}/approve`, {}, su);

  const cust = (
    await post('/auth/register/customer', {
      email: `pc${stamp}a@marketplace.test`,
      password: 'correct-horse',
      fullName: 'Payments Customer',
    })
  ).body.accessToken;
  const rival = (
    await post('/auth/register/customer', {
      email: `pc${stamp}b@marketplace.test`,
      password: 'correct-horse',
      fullName: 'Rival Customer',
    })
  ).body.accessToken;
  ok(!!su && !!vendorToken && !!cust && !!rival, 'vendor and two customers ready');

  const leaf = (await call('/categories?flat=true')).body.find((c) => c.parentId);
  const svc = (
    await post(
      '/services',
      {
        title: `Payments Service ${stamp}`,
        description: 'A service used to exercise both payment modes and the refund path.',
        categoryId: leaf.id,
        slotGranularityMinutes: 60,
        freeCancellationHours: 24,
        cancellationFeePercent: 50,
      },
      vendorToken,
    )
  ).body;
  const offering = (
    await post(`/services/${svc.id}/offerings`, { name: 'Session', durationMinutes: 60, priceMinor: 200000 }, vendorToken)
  ).body;

  // Capacity 1, so "the slot is bookable by someone else" is a real claim: while the first
  // booking holds it, nobody else can take it.
  await put(
    `/services/${svc.id}/availability/rules`,
    { rules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 13 * 60, capacity: 1 })) },
    vendorToken,
  );
  await post(`/services/${svc.id}/publish`, {}, vendorToken);

  const day = localDate(6);
  const slots = (await call(`/services/${svc.id}/slots?offeringId=${offering.id}&from=${day}&to=${day}`)).body.slots;
  ok(slots.length === 4, 'four slots available', slots.length);

  const book = (startUtc, token, key, mode = 'PAY_NOW') =>
    post('/bookings', { serviceId: svc.id, offeringId: offering.id, startUtc, paymentMode: mode }, token, key);

  // ============================================================ PAY_NOW success

  r = await book(slots[0].startUtc, cust, `p1-${stamp}`);
  ok(r.status === 201, 'a PAY_NOW booking -> 201', `${r.status} ${JSON.stringify(r.body?.error)}`);
  const b1 = r.body.booking;
  const pay1 = r.body.payment;
  ok(pay1?.status === 'INITIATED', 'with an INITIATED payment attached', pay1?.status);

  r = await post(`/payments/${pay1.id}/confirm`, {}, cust);
  ok(r.status === 400 && code(r) === 'IDEMPOTENCY_KEY_REQUIRED', 'confirm with no key -> 400', `${r.status} ${code(r)}`);

  r = await post(`/payments/${pay1.id}/confirm`, { token: 'tok_success' }, cust, `c1-${stamp}`);
  ok(r.status === 200 && r.body?.payment?.status === 'SUCCESS', 'confirm with tok_success -> SUCCESS', `${r.status} ${r.body?.payment?.status}`);
  ok(r.body?.booking === null, 'and the booking stays PENDING - confirming is still the vendor decision');

  r = await call(`/bookings/${b1.id}`, {}, cust);
  ok(r.body?.status === 'PENDING', 'the booking is indeed still PENDING', r.body?.status);

  // --- the brief's idempotency DONE WHEN
  r = await post(`/payments/${pay1.id}/confirm`, { token: 'tok_success' }, cust, `c1-${stamp}`);
  ok(r.status === 200 && r.body?.replayed === true, 'replaying the confirm key -> the stored response', `${r.status} ${r.body?.replayed}`);

  const charges = await prisma.ledgerEntry.count({ where: { bookingId: b1.id, type: 'CHARGE' } });
  ok(charges === 1, 'exactly one CHARGE ledger row exists, so the replay did not charge twice', charges);
  const paymentRows = await prisma.payment.count({ where: { bookingId: b1.id } });
  ok(paymentRows === 1, 'and exactly one payment row', paymentRows);

  r = await post(`/payments/${pay1.id}/confirm`, { token: 'tok_success' }, cust, `c1-fresh-${stamp}`);
  ok(
    r.status === 422 && code(r) === 'PAYMENT_NOT_PENDING',
    'confirming an already-successful payment with a NEW key -> 422 PAYMENT_NOT_PENDING',
    `${r.status} ${code(r)}`,
  );

  // Now the vendor can confirm, which M6 gated on payment success.
  r = await patch(`/bookings/${b1.id}/confirm`, {}, vendorToken);
  ok(r.status === 200 && r.body?.status === 'CONFIRMED', 'the vendor can now confirm the booking', `${r.status} ${r.body?.status}`);

  // ============================================================ the failure path

  r = await book(slots[1].startUtc, cust, `p2-${stamp}`);
  const b2 = r.body.booking;
  const pay2 = r.body.payment;

  // While it is held, capacity 1 means nobody else can take that slot.
  r = await book(slots[1].startUtc, rival, `p2-rival-${stamp}`);
  ok(r.status === 409 && code(r) === 'SLOT_FULL', 'while held, the slot is refused to another customer', `${r.status} ${code(r)}`);

  r = await post(`/payments/${pay2.id}/confirm`, { token: 'tok_fail' }, cust, `c2-${stamp}`);
  ok(r.status === 200 && r.body?.payment?.status === 'FAILED', 'confirm with tok_fail -> FAILED', `${r.status} ${r.body?.payment?.status}`);
  ok(r.body?.payment?.failureReason === 'card_declined', 'with the reason recorded', r.body?.payment?.failureReason);
  ok(r.body?.booking?.status === 'CANCELLED', 'and the booking is CANCELLED in the same transaction', r.body?.booking?.status);

  // --- the brief's DONE WHEN: a failed payment leaves the slot bookable by someone else
  r = await call(`/services/${svc.id}/slots?offeringId=${offering.id}&from=${day}&to=${day}`);
  ok(
    r.body.slots.some((s) => s.startUtc === slots[1].startUtc),
    'the slot is offered again after the failure',
    r.body.slots.map((s) => s.startUtc).join(' '),
  );
  r = await book(slots[1].startUtc, rival, `p2-rival2-${stamp}`, 'PAY_AFTER');
  ok(r.status === 201, 'and another customer can actually book it -> 201', `${r.status} ${code(r)}`);
  const rivalBooking = r.body.booking;

  const cells = await prisma.slotCell.findFirst({
    where: { serviceId: svc.id, startUtc: new Date(slots[1].startUtc) },
    select: { capacity: true, bookedCount: true },
  });
  ok(cells.bookedCount === 1, 'the counter reflects exactly one live booking, not two', JSON.stringify(cells));

  // ============================================================ webhook

  const delayed = await book(slots[2].startUtc, cust, `p3-${stamp}`);
  const pay3 = delayed.body.payment;
  r = await post(`/payments/${pay3.id}/confirm`, { token: 'tok_delay' }, cust, `c3-${stamp}`);
  ok(r.status === 200 && r.body?.outcome === 'PENDING', 'tok_delay leaves the payment PENDING', `${r.status} ${r.body?.outcome}`);

  const providerRef = (await prisma.payment.findUnique({ where: { id: pay3.id }, select: { providerRef: true } })).providerRef;

  r = await webhook({ eventId: `evt-${stamp}-1`, providerRef, outcome: 'SUCCESS' }, 'deadbeef');
  ok(r.status === 401 && code(r) === 'WEBHOOK_SIGNATURE_INVALID', 'a wrongly-signed webhook -> 401', `${r.status} ${code(r)}`);
  let still = await prisma.payment.findUnique({ where: { id: pay3.id }, select: { status: true } });
  ok(still.status === 'INITIATED', 'and nothing was applied from it', still.status);

  r = await webhook({ eventId: `evt-${stamp}-1`, providerRef, outcome: 'SUCCESS' });
  ok(r.status === 200 && r.body?.applied === true, 'a correctly-signed webhook is applied -> 200', JSON.stringify(r.body));
  still = await prisma.payment.findUnique({ where: { id: pay3.id }, select: { status: true } });
  ok(still.status === 'SUCCESS', 'the delayed payment is now SUCCESS', still.status);

  // --- replay
  r = await webhook({ eventId: `evt-${stamp}-1`, providerRef, outcome: 'SUCCESS' });
  ok(
    r.status === 200 && r.body?.applied === false && r.body?.reason === 'duplicate_event',
    'redelivering the SAME eventId -> 200, inert, deduped by the unique index',
    JSON.stringify(r.body),
  );
  const charged = await prisma.ledgerEntry.count({ where: { bookingId: delayed.body.booking.id, type: 'CHARGE' } });
  ok(charged === 1, 'and still exactly one CHARGE row', charged);

  // A different event id for an already-settled payment is acknowledged but not applied.
  r = await webhook({ eventId: `evt-${stamp}-2`, providerRef, outcome: 'FAILED' });
  ok(
    r.status === 200 && r.body?.applied === false && r.body?.reason === 'already_settled',
    'a late webhook for a settled payment -> 200, unchanged',
    JSON.stringify(r.body),
  );
  still = await prisma.payment.findUnique({ where: { id: pay3.id }, select: { status: true } });
  ok(still.status === 'SUCCESS', 'the payment is still SUCCESS, not flipped by the late FAILED', still.status);

  r = await webhook({ eventId: `evt-${stamp}-3`, providerRef: 'mock_does_not_exist', outcome: 'SUCCESS' });
  ok(r.status === 200 && r.body?.reason === 'unknown_payment', 'a webhook for an unknown payment is acknowledged, not retried forever', JSON.stringify(r.body));

  // ============================================================ refund on cancellation

  const refundable = await prisma.booking.findUnique({ where: { id: b1.id }, select: { priceMinor: true } });
  r = await patch(`/bookings/${b1.id}/cancel`, { reason: 'Customer cancelled well ahead' }, cust);
  ok(r.status === 200 && r.body?.cancellation?.isLate === false, 'cancelling six days out is not late', JSON.stringify(r.body?.cancellation));

  const afterRefund = await prisma.payment.findFirst({ where: { bookingId: b1.id }, select: { status: true } });
  ok(afterRefund.status === 'REFUNDED', 'the successful payment is REFUNDED automatically', afterRefund.status);

  const ledger = await prisma.ledgerEntry.findMany({ where: { bookingId: b1.id }, select: { type: true, amountMinor: true } });
  const net = ledger.reduce((s, e) => s + e.amountMinor, 0);
  ok(ledger.some((e) => e.type === 'REFUND'), 'a REFUND ledger row was appended');
  ok(net === 0, 'and the ledger nets to zero - charged then fully refunded', `${JSON.stringify(ledger)} net=${net}`);

  r = await call(`/bookings/${b1.id}/payments`, {}, cust);
  ok(r.status === 200 && r.body?.outstandingMinor === 0, 'nothing is outstanding on it', JSON.stringify(r.body?.outstandingMinor));
  ok(r.body?.ledger?.length === 2, 'and the ledger is append-only: two rows, none updated', r.body?.ledger?.length);

  // ============================================================ PAY_AFTER settlement

  r = await patch(`/bookings/${rivalBooking.id}/mark-collected`, {}, cust);
  ok(r.status === 403, 'a customer cannot mark cash collected -> 403', r.status);

  r = await patch(`/bookings/${rivalBooking.id}/mark-collected`, {}, vendorToken);
  ok(r.status === 200 && r.body?.collected === true, 'the vendor records cash collected -> 200', `${r.status} ${JSON.stringify(r.body)}`);

  r = await patch(`/bookings/${rivalBooking.id}/mark-collected`, {}, vendorToken);
  ok(r.body?.alreadyRecorded === true, 'twice is idempotent - a double-click is not a second payment', JSON.stringify(r.body));

  const cash = await prisma.ledgerEntry.count({ where: { bookingId: rivalBooking.id, type: 'CASH_COLLECTED' } });
  ok(cash === 1, 'exactly one CASH_COLLECTED row', cash);

  r = await call(`/bookings/${rivalBooking.id}/payments`, {}, rival);
  ok(r.body?.outstandingMinor === 0, 'and nothing is outstanding on the PAY_AFTER booking', r.body?.outstandingMinor);
  ok(r.body?.payments?.length === 0, 'with no Payment row at all - no gateway was involved', r.body?.payments?.length);

  r = await patch(`/bookings/${b1.id}/mark-collected`, {}, vendorToken);
  ok(r.status === 422 && code(r) === 'NOT_PAY_AFTER', 'marking a PAY_NOW booking collected -> 422 NOT_PAY_AFTER', `${r.status} ${code(r)}`);

  // ============================================================ ownership

  r = await call(`/payments/${pay1.id}`, {}, rival);
  ok(r.status === 404, "another customer reading someone's payment -> 404", r.status);
  r = await call(`/payments/${pay1.id}`, {}, vendorToken);
  ok(r.status === 200, 'the vendor on the booking may read it', r.status);

  r = await post(`/payments/${pay3.id}/confirm`, { token: 'tok_success' }, rival, `c-steal-${stamp}`);
  ok(r.status === 404, "and cannot confirm a payment that is not theirs", r.status);

  r = await post(`/payments/bookings/${b1.id}/refund`, {}, vendorToken);
  ok(r.status === 403, 'a vendor cannot issue a manual refund - payment.refund is admin-only', r.status);

  await prisma.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error('suite crashed', err);
  await prisma.$disconnect();
  process.exit(1);
});
