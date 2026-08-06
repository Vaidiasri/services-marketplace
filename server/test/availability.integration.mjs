/**
 * M5 availability and derived slots, end to end.
 *
 * The brief's DONE WHEN items for this module, all asserted here:
 *   - closing a date makes its slots disappear; reopening brings them back
 *   - a slot with capacity 2 shows remaining 1 after one booking, and stops being offered
 *     at zero
 *   - changing an offering's duration from 30 to 60 changes the generated slots
 *
 * Consumption is arranged by writing SlotCell rows through Prisma, because the route that
 * creates them is M6's. The rows are exactly what M6 will write - a counter per grid cell -
 * so the subtraction being tested is the real one.
 *
 * Run: node test/availability.integration.mjs   (from server/)
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

async function call(path, opts = {}, token) {
  const headers = { ...(opts.headers ?? {}) };
  if (opts.body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
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
const post = (p, b, t) => call(p, { method: 'POST', body: JSON.stringify(b ?? {}) }, t);
const put = (p, b, t) => call(p, { method: 'PUT', body: JSON.stringify(b) }, t);
const patch = (p, b, t) => call(p, { method: 'PATCH', body: JSON.stringify(b) }, t);
const del = (p, t) => call(p, { method: 'DELETE' }, t);

const IST = 'Asia/Kolkata';
/** A local date in the vendor's zone, `days` from today. */
const localDate = (days) => {
  const now = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST, dateStyle: 'short' }).format(now);
};
/** Local wall-clock label for a slot, in the vendor's zone. */
const at = (s) =>
  new Date(s.startUtc).toLocaleTimeString('en-GB', {
    timeZone: IST,
    hour: '2-digit',
    minute: '2-digit',
  });

async function registerVendor(stamp, suffix) {
  const r = await post('/auth/register/vendor', {
    email: `av${stamp}${suffix}@marketplace.test`,
    password: 'correct-horse',
    fullName: `Availability Vendor ${suffix}`,
    businessName: `Availability Co ${stamp}${suffix}`,
    contactName: 'A',
    contactPhone: '+91 90000 00000',
    addressLine1: '1 Slot Street',
    city: 'Pune',
    state: 'MH',
    postalCode: '411001',
    timezone: IST,
  });
  return { token: r.body.accessToken, profileId: r.body.vendorProfile.id };
}

/** Open 09:00-13:00 every weekday, so any target date behaves identically. */
const EVERY_DAY_9_TO_1 = (capacity) =>
  Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    startMinute: 9 * 60,
    endMinute: 13 * 60,
    capacity,
  }));

(async () => {
  const stamp = Date.now();

  const su = (
    await post('/auth/login', {
      email: 'super@marketplace.test',
      password: process.env.TEST_ADMIN_PASSWORD ?? 'TestPass!2026',
    })
  ).body.accessToken;

  const a = await registerVendor(stamp, 'a');
  const b = await registerVendor(stamp, 'b');
  await patch(`/admin/vendors/${a.profileId}/approve`, {}, su);
  await patch(`/admin/vendors/${b.profileId}/approve`, {}, su);
  ok(!!su && !!a.token && !!b.token, 'super admin plus two approved vendors');

  // The boundary that protects every slot this suite asserts. ICU resolves the
  // abbreviation EST to America/Panama - fixed UTC-5, no daylight saving - so a vendor who
  // registered with "EST" would have every slot an hour wrong for eight months of the year.
  // Registration must refuse it before it can reach the generator.
  let r = await post('/auth/register/vendor', {
    email: `tz${stamp}@marketplace.test`,
    password: 'correct-horse',
    fullName: 'Bad Timezone',
    businessName: `Bad Timezone Co ${stamp}`,
    contactName: 'B',
    contactPhone: '+91 90000 00000',
    addressLine1: '1 Nowhere',
    city: 'Pune',
    state: 'MH',
    postalCode: '411001',
    timezone: 'EST',
  });
  ok(
    r.status === 422,
    'registering with the abbreviation EST -> 422, though Intl would accept it',
    `${r.status} ${r.body?.error?.code}`,
  );

  r = await patch('/vendors/me', { timezone: 'IST' }, a.token);
  ok(r.status === 422, 'and PATCHing a profile to IST is refused too', r.status);
  r = await patch('/vendors/me', { timezone: 'America/New_York' }, a.token);
  ok(r.status === 200, 'a real Region/City zone is accepted', r.status);
  await patch('/vendors/me', { timezone: IST }, a.token);

  const leaf = (await call('/categories?flat=true')).body.find((c) => c.parentId);

  // Granularity 30 so a 30-minute and a 60-minute offering both align to the grid.
  r = await post(
    '/services',
    {
      title: `Slot Service ${stamp}`,
      description: 'A service used to assert derived slot arithmetic end to end.',
      categoryId: leaf.id,
      slotGranularityMinutes: 30,
      freeCancellationHours: 24,
      cancellationFeePercent: 50,
    },
    a.token,
  );
  ok(r.status === 201, 'service created', `${r.status} ${JSON.stringify(r.body?.error)}`);
  const svc = r.body.id;

  r = await post(
    `/services/${svc}/offerings`,
    { name: 'Half hour', durationMinutes: 30, priceMinor: 80000 },
    a.token,
  );
  ok(r.status === 201, 'a 30-minute offering created', r.status);
  const offering = r.body.id;

  // ============================================================ rules

  r = await put(`/services/${svc}/availability/rules`, { rules: EVERY_DAY_9_TO_1(2) }, a.token);
  ok(r.status === 200, 'PUT rules -> 200', `${r.status} ${JSON.stringify(r.body?.error)}`);
  ok(r.body?.rules?.length === 7, 'seven rules stored, one per weekday', r.body?.rules?.length);
  ok(r.body?.timezone === IST, 'and the response carries the vendor timezone', r.body?.timezone);

  r = await call(`/services/${svc}/availability/rules`, {}, a.token);
  ok(r.status === 200 && !!r.body?.weekdays, 'GET rules -> 200 grouped by weekday');
  ok(
    Object.keys(r.body.weekdays).length === 7 && r.body.weekdays['3'].length === 1,
    'every weekday key is present, including the ones with no rule',
    Object.keys(r.body.weekdays).join(','),
  );

  // Replacement, not append: a second PUT leaves seven rules, not fourteen.
  r = await put(`/services/${svc}/availability/rules`, { rules: EVERY_DAY_9_TO_1(2) }, a.token);
  ok(r.body?.rules?.length === 7, 'PUT is a full replacement, so re-sending leaves 7 not 14', r.body?.rules?.length);

  r = await put(
    `/services/${svc}/availability/rules`,
    { rules: [{ weekday: 1, startMinute: 780, endMinute: 540, capacity: 1 }] },
    a.token,
  );
  ok(
    r.status === 422 && r.body?.error?.code === 'INVALID_WINDOW',
    'a window ending before it starts -> 422 INVALID_WINDOW',
    `${r.status} ${r.body?.error?.code}`,
  );

  r = await put(
    `/services/${svc}/availability/rules`,
    { rules: [{ weekday: 1, startMinute: 540, endMinute: 780, capacity: 0 }] },
    a.token,
  );
  ok(r.status === 422, 'capacity 0 -> 422', r.status);

  r = await put(`/services/${svc}/availability/rules`, { rules: EVERY_DAY_9_TO_1(2) }, b.token);
  ok(r.status === 404, "another vendor writing rules on this service -> 404", r.status);

  // ============================================================ slots, and the grid

  const day = localDate(7);
  const range = `from=${day}&to=${day}`;

  r = await call(`/services/${svc}/slots?${range}`);
  ok(
    r.status === 422 && r.body?.error?.code === 'OFFERING_REQUIRED',
    'slots without offeringId -> 422 OFFERING_REQUIRED',
    `${r.status} ${r.body?.error?.code}`,
  );

  // A draft service is not public, and neither is its availability.
  r = await call(`/services/${svc}/slots?offeringId=${offering}&${range}`);
  ok(r.status === 404, 'slots on a DRAFT service -> 404 for a public caller', r.status);
  r = await call(`/services/${svc}/slots?offeringId=${offering}&${range}`, {}, a.token);
  ok(r.status === 200, 'but 200 for its owner', r.status);

  // 09:00-13:00, 30-minute offering, 30-minute grid: 09:00 .. 12:30 = 8 starts.
  const thirty = r.body.slots;
  ok(thirty.length === 8, 'a 4-hour window with a 30-minute offering -> 8 slots', thirty.length);
  ok(at(thirty[0]) === '09:00' && at(thirty[7]) === '12:30', 'from 09:00 to 12:30', `${at(thirty[0])}..${at(thirty[7])}`);
  ok(r.body.timezone === IST, 'the envelope names the timezone so the client need not ask', r.body.timezone);
  ok(r.body.durationMinutes === 30, 'and the duration the slots were computed for', r.body.durationMinutes);
  ok(
    thirty.every((s) => s.capacity === 2 && s.remainingCapacity === 2),
    'every slot reports capacity 2 and nothing consumed yet',
    JSON.stringify(thirty[0]),
  );

  // --- DONE WHEN: 30 -> 60 changes the generated slots
  r = await patch(`/offerings/${offering}`, { durationMinutes: 60 }, a.token);
  ok(r.status === 200, 'the offering duration is changed to 60', r.status);

  r = await call(`/services/${svc}/slots?offeringId=${offering}&${range}`, {}, a.token);
  const sixty = r.body.slots;
  ok(sixty.length === 7, 'the same window with a 60-minute offering -> 7 slots', sixty.length);
  ok(at(sixty[6]) === '12:00', 'the last start moves back to 12:00', at(sixty[6]));
  ok(
    !sixty.some((s) => at(s) === '12:30'),
    '12:30 is gone, because a 60-minute booking there would overrun the 13:00 close',
  );
  ok(
    JSON.stringify(thirty.map(at)) !== JSON.stringify(sixty.map(at)),
    'so the generated slots genuinely changed',
  );

  // Publish, so the rest exercises the public path rather than the owner path.
  r = await post(`/services/${svc}/publish`, {}, a.token);
  ok(r.status === 200 && r.body?.status === 'PUBLISHED', 'the service publishes now that rules exist', `${r.status} ${r.body?.status}`);

  r = await call(`/services/${svc}/slots?offeringId=${offering}&${range}`);
  ok(r.status === 200 && r.body.slots.length === 7, 'and a signed-out caller sees the same 7 slots', r.body?.slots?.length);

  // ============================================================ consumption

  // A 60-minute booking at 09:00 on a 30-minute grid occupies cells 09:00 and 09:30 -
  // 03:30Z and 04:00Z in IST.
  const cellA = new Date(`${day}T03:30:00.000Z`);
  const cellB = new Date(`${day}T04:00:00.000Z`);
  for (const startUtc of [cellA, cellB]) {
    await prisma.slotCell.upsert({
      where: { serviceId_startUtc: { serviceId: svc, startUtc } },
      update: { capacity: 2, bookedCount: 1 },
      create: { serviceId: svc, startUtc, capacity: 2, bookedCount: 1 },
    });
  }

  r = await call(`/services/${svc}/slots?offeringId=${offering}&${range}`);
  const after1 = r.body.slots;
  ok(
    after1.find((s) => at(s) === '09:00')?.remainingCapacity === 1,
    'capacity 2 with one booking -> the 09:00 slot reports remaining 1',
    JSON.stringify(after1.find((s) => at(s) === '09:00')),
  );
  ok(after1.length === 7, 'and the slot is still offered', after1.length);
  // The grid's whole purpose: a 60-minute booking at 09:00 also consumes the 09:30 cell,
  // so the 09:30 start is constrained even though nothing was booked "at" 09:30.
  ok(
    after1.find((s) => at(s) === '09:30')?.remainingCapacity === 1,
    'the 09:30 start is constrained too, because the booking spans its cell',
    after1.find((s) => at(s) === '09:30')?.remainingCapacity,
  );
  ok(
    after1.find((s) => at(s) === '10:30')?.remainingCapacity === 2,
    'a slot clear of both cells is untouched',
    after1.find((s) => at(s) === '10:30')?.remainingCapacity,
  );

  // Second booking fills them.
  for (const startUtc of [cellA, cellB]) {
    await prisma.slotCell.update({
      where: { serviceId_startUtc: { serviceId: svc, startUtc } },
      data: { bookedCount: 2 },
    });
  }

  r = await call(`/services/${svc}/slots?offeringId=${offering}&${range}`);
  const after2 = r.body.slots;
  ok(
    !after2.some((s) => at(s) === '09:00'),
    'at capacity, the 09:00 slot stops being offered rather than showing remaining 0',
  );
  ok(!after2.some((s) => at(s) === '09:30'), 'and so does 09:30, which shares a full cell');
  ok(after2.length === 5, 'leaving 10:00 through 12:00', after2.map(at).join(' '));

  // A cell keeps the capacity it was created with, so lowering the rule cannot invalidate it.
  await put(`/services/${svc}/availability/rules`, { rules: EVERY_DAY_9_TO_1(1) }, a.token);
  r = await call(`/services/${svc}/slots?offeringId=${offering}&${range}`);
  ok(
    r.body.slots.every((s) => s.capacity === 1),
    'lowering the rule to capacity 1 applies to cells that do not exist yet',
    JSON.stringify(r.body.slots[0]),
  );
  await put(`/services/${svc}/availability/rules`, { rules: EVERY_DAY_9_TO_1(2) }, a.token);

  // Clear consumption so the closure assertions below compare like with like.
  await prisma.slotCell.deleteMany({ where: { serviceId: svc } });

  // ============================================================ DONE WHEN: closures

  const before = (await call(`/services/${svc}/slots?offeringId=${offering}&${range}`)).body.slots;
  ok(before.length === 7, 'baseline restored to 7 slots', before.length);

  r = await post(
    `/services/${svc}/availability/exceptions`,
    { date: day, type: 'CLOSURE', reason: 'Public holiday' },
    a.token,
  );
  ok(r.status === 201, 'POST a CLOSURE -> 201', `${r.status} ${JSON.stringify(r.body?.error)}`);
  ok(r.body?.date === day, 'and it comes back as a local date, not an instant', r.body?.date);
  const closureId = r.body.id;

  r = await call(`/services/${svc}/slots?offeringId=${offering}&${range}`);
  ok(r.status === 200 && r.body.slots.length === 0, 'closing the date empties its slots', r.body?.slots?.length);

  // The neighbouring day is untouched - the closure is a date, not a switch.
  const nextDay = localDate(8);
  r = await call(`/services/${svc}/slots?offeringId=${offering}&from=${nextDay}&to=${nextDay}`);
  ok(r.body.slots.length === 7, 'the following day still has its 7 slots', r.body?.slots?.length);

  // Idempotent: closing an already-closed date does not accumulate rows.
  r = await post(
    `/services/${svc}/availability/exceptions`,
    { date: day, type: 'CLOSURE' },
    a.token,
  );
  ok(r.status === 201 && r.body?.id === closureId, 'closing an already-closed date returns the same row', `${r.body?.id} vs ${closureId}`);

  r = await call(`/services/${svc}/availability/exceptions?from=${day}&to=${day}`);
  ok(r.body?.exceptions?.length === 1, 'so there is exactly one exception on that date', r.body?.exceptions?.length);

  r = await del(`/services/${svc}/availability/exceptions/${closureId}`, b.token);
  ok(r.status === 404, "another vendor deleting the exception -> 404", r.status);

  r = await del(`/services/${svc}/availability/exceptions/${closureId}`, a.token);
  ok(r.status === 204, 'DELETE the exception -> 204', r.status);

  const restored = (await call(`/services/${svc}/slots?offeringId=${offering}&${range}`)).body.slots;
  ok(
    JSON.stringify(restored) === JSON.stringify(before),
    'and the slots come back byte-identical to before the closure',
    `${restored.length} vs ${before.length}`,
  );

  // --- OPEN_WINDOW opens hours the weekly rules do not cover
  r = await post(
    `/services/${svc}/availability/exceptions`,
    { date: day, type: 'OPEN_WINDOW', startMinute: 18 * 60, endMinute: 20 * 60, capacity: 3 },
    a.token,
  );
  ok(r.status === 201, 'POST an OPEN_WINDOW -> 201', `${r.status} ${JSON.stringify(r.body?.error)}`);
  const openId = r.body.id;

  r = await call(`/services/${svc}/slots?offeringId=${offering}&${range}`);
  const evening = r.body.slots.filter((s) => at(s) >= '18:00');
  // Three, not two: 18:00, 18:30 and 19:00 all fit a 60-minute booking before the 20:00
  // close, because starts step by the 30-minute granularity rather than by duration.
  ok(evening.length === 3, 'an 18:00-20:00 window adds three 60-minute starts', evening.map(at).join(' '));
  ok(evening[0].capacity === 3, 'with the capacity the exception declares', evening[0]?.capacity);
  ok(r.body.slots.length === 10, 'on top of the 7 the weekly rule already gave', r.body?.slots?.length);
  await del(`/services/${svc}/availability/exceptions/${openId}`, a.token);

  // --- exception validation
  r = await post(
    `/services/${svc}/availability/exceptions`,
    { date: localDate(-3), type: 'CLOSURE' },
    a.token,
  );
  ok(
    r.status === 422 && r.body?.error?.code === 'DATE_IN_PAST',
    'a closure for a date already past in the vendor timezone -> 422 DATE_IN_PAST',
    `${r.status} ${r.body?.error?.code}`,
  );

  r = await post(
    `/services/${svc}/availability/exceptions`,
    { date: day, type: 'OPEN_WINDOW' },
    a.token,
  );
  ok(r.status === 422, 'an OPEN_WINDOW with no window -> 422', r.status);

  r = await post(
    `/services/${svc}/availability/exceptions`,
    { date: day, type: 'CLOSURE', startMinute: 540, endMinute: 780 },
    a.token,
  );
  ok(r.status === 422, 'a CLOSURE carrying a window -> 422, since it covers the whole date', r.status);

  // ============================================================ range and offering guards

  r = await call(`/services/${svc}/slots?offeringId=${offering}&from=${localDate(1)}&to=${localDate(90)}`);
  ok(
    r.status === 422 && r.body?.error?.code === 'RANGE_TOO_LARGE',
    'a 90-day range -> 422 RANGE_TOO_LARGE',
    `${r.status} ${r.body?.error?.code}`,
  );
  // day 1 to day 63 inclusive is 63 days; day 1 to day 62 is exactly the 62-day cap.
  r = await call(`/services/${svc}/slots?offeringId=${offering}&from=${localDate(1)}&to=${localDate(63)}`);
  ok(r.status === 422, 'and so does 63 days, one past the cap', r.status);
  r = await call(`/services/${svc}/slots?offeringId=${offering}&from=${localDate(1)}&to=${localDate(62)}`);
  ok(r.status === 200, 'exactly 62 days is allowed', r.status);

  r = await call(`/services/${svc}/slots?offeringId=${offering}`);
  ok(r.status === 200 && r.body.slots.length > 0, 'omitting the range uses a default window', r.body?.slots?.length);
  ok(
    r.body.slots.every((s) => new Date(s.startUtc) > new Date()),
    'and every slot it returns is in the future',
  );

  // An offering on a different service is a client mistake about the relationship.
  r = await post(
    '/services',
    {
      title: `Other Service ${stamp}`,
      description: 'A second service, used to prove offerings cannot be borrowed.',
      categoryId: leaf.id,
      freeCancellationHours: 24,
      cancellationFeePercent: 50,
    },
    b.token,
  );
  const otherSvc = r.body.id;
  r = await post(
    `/services/${otherSvc}/offerings`,
    { name: 'Foreign', durationMinutes: 30, priceMinor: 50000 },
    b.token,
  );
  const foreignOffering = r.body.id;

  r = await call(`/services/${svc}/slots?offeringId=${foreignOffering}&${range}`);
  ok(r.status === 422, "an offering belonging to another service -> 422", r.status);

  // An inactive offering is not bookable, but that is an empty list rather than an error.
  await patch(`/offerings/${offering}`, { isActive: false }, a.token);
  r = await call(`/services/${svc}/slots?offeringId=${offering}&${range}`);
  ok(
    r.status === 200 && r.body.slots.length === 0,
    'an inactive offering -> 200 with no slots, not an error',
    `${r.status} ${r.body?.slots?.length}`,
  );
  await patch(`/offerings/${offering}`, { isActive: true }, a.token);

  // ============================================================ next-available

  r = await call(`/services/${svc}/slots/next-available?offeringId=${offering}`);
  ok(r.status === 200 && !!r.body?.slot, 'next-available returns a slot', JSON.stringify(r.body?.slot));
  ok(new Date(r.body.slot.startUtc) > new Date(), 'which is in the future');

  // Compared against the slots endpoint rather than a hard-coded 09:00. An earlier version
  // asserted the literal time and passed only when the suite ran before 09:00 IST - after
  // that, today's first FUTURE slot is 09:30 and the test failed on correct code. Asserting
  // the two endpoints agree is both time-independent and a stronger claim.
  const soonest = (
    await call(`/services/${svc}/slots?offeringId=${offering}&from=${localDate(0)}&to=${localDate(3)}`)
  ).body.slots[0];
  ok(
    r.body.slot.startUtc === soonest.startUtc,
    'and it is exactly the first slot the slots endpoint offers',
    `${r.body.slot.startUtc} vs ${soonest.startUtc}`,
  );

  r = await call(`/services/${svc}/slots/next-available`);
  ok(r.status === 422, 'next-available without an offering -> 422', r.status);

  // With every rule removed there is nothing to find for the next 62 days.
  await post(`/services/${svc}/unpublish`, {}, a.token);
  await put(`/services/${svc}/availability/rules`, { rules: [] }, a.token);
  r = await call(`/services/${svc}/slots/next-available?offeringId=${offering}`, {}, a.token);
  ok(
    r.status === 200 && r.body?.slot === null,
    'with no rules at all -> 200 with slot null, not a 404',
    `${r.status} ${JSON.stringify(r.body)}`,
  );

  // ============================================================ the orphan guard

  await put(`/services/${svc}/availability/rules`, { rules: EVERY_DAY_9_TO_1(2) }, a.token);
  await post(`/services/${svc}/publish`, {}, a.token);
  r = await put(`/services/${svc}/availability/rules`, { rules: [] }, a.token);
  ok(
    r.status === 409 && r.body?.error?.code === 'WOULD_ORPHAN_PUBLISHED_SERVICE',
    'emptying the rules of a PUBLISHED service -> 409, since M4 required one to publish',
    `${r.status} ${r.body?.error?.code}`,
  );
  r = await call(`/services/${svc}/slots?offeringId=${offering}&${range}`);
  ok(r.body?.slots?.length === 7, 'and the refusal left the schedule intact', r.body?.slots?.length);

  // ---------------------------------------------------------------- teardown
  await prisma.slotCell.deleteMany({ where: { serviceId: svc } });
  await prisma.$disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error('suite crashed', err);
  await prisma.$disconnect();
  process.exit(1);
});
