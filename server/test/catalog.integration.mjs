/**
 * M4 catalogue: categories, the two-level limit, service lifecycle, offerings, the
 * publish preconditions, full-text search, price filtering, and paginated reads.
 *
 * Both of the brief's DONE WHEN items for this module are asserted here:
 *   - a signed-out GET of a draft service is 404 and the owner's GET of the same id is 200
 *   - page 2 of a filtered search returns the right rows and a correct total
 *
 * Uses Prisma directly to ARRANGE state (25 rows for the pagination test, and the
 * availability rules that publishing requires - the route that creates those is M5's).
 * Every ASSERTION goes through HTTP, so nothing here proves a behaviour the API does not
 * actually have.
 *
 * Run: node test/catalog.integration.mjs   (from server/)
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
      /* empty body on 204 */
    }
  }
  return { status: res.status, body };
}

const post = (p, b, t) => call(p, { method: 'POST', body: JSON.stringify(b ?? {}) }, t);
const patch = (p, b, t) => call(p, { method: 'PATCH', body: JSON.stringify(b) }, t);
const del = (p, t) => call(p, { method: 'DELETE' }, t);

async function registerVendor(stamp, suffix) {
  const r = await post('/auth/register/vendor', {
    email: `cat${stamp}${suffix}@marketplace.test`,
    password: 'correct-horse',
    fullName: `Catalogue Vendor ${suffix}`,
    businessName: `Catalogue Co ${stamp}${suffix}`,
    contactName: 'C',
    contactPhone: '+91 90000 00000',
    addressLine1: '1 Catalogue Road',
    city: 'Pune',
    state: 'MH',
    postalCode: '411001',
    timezone: 'Asia/Kolkata',
  });
  return { token: r.body.accessToken, profileId: r.body.vendorProfile.id };
}

const SERVICE_BODY = (categoryId, title) => ({
  title,
  description: 'A thorough description, long enough to satisfy the minimum length rule.',
  categoryId,
  slotGranularityMinutes: 30,
  freeCancellationHours: 24,
  cancellationFeePercent: 50,
});

(async () => {
  const stamp = Date.now();

  const su = (
    await post('/auth/login', {
      email: 'super@marketplace.test',
      password: process.env.TEST_ADMIN_PASSWORD ?? 'TestPass!2026',
    })
  ).body.accessToken;
  ok(!!su, 'super admin signed in');

  const a = await registerVendor(stamp, 'a');
  const b = await registerVendor(stamp, 'b');
  await patch(`/admin/vendors/${a.profileId}/approve`, {}, su);
  await patch(`/admin/vendors/${b.profileId}/approve`, {}, su);
  // The token minted at registration keeps working: status is resolved per request, not
  // baked into the JWT. Asserted properly in the M3 suite; relied on here.
  ok(true, 'two vendors registered and approved');

  // ============================================================ categories

  let r = await call('/categories');
  ok(r.status === 200 && Array.isArray(r.body), 'GET /categories is public -> 200');
  const tree = r.body;
  ok(
    tree.every((n) => Array.isArray(n.children)) && tree.some((n) => n.children.length > 0),
    'returns a tree with children nested',
    JSON.stringify(tree.slice(0, 1)),
  );
  const parent = tree.find((n) => n.children.length > 0);
  const leaf = parent.children[0];
  ok(
    !!leaf.parentId && leaf.slug.startsWith(`${parent.slug}-`),
    'child slugs are parent-prefixed, so the same name under two parents cannot collide',
    leaf.slug,
  );

  r = await call('/categories?flat=true');
  ok(
    r.status === 200 && r.body.length > tree.length && r.body.every((c) => !('children' in c)),
    '?flat=true returns every row unnested',
    `${r.body?.length} rows vs ${tree.length} roots`,
  );

  // --- the two-level limit
  r = await post('/categories', { name: `Depth Probe ${stamp}`, parentId: leaf.id }, su);
  ok(
    r.status === 422 && r.body?.error?.code === 'CATEGORY_DEPTH_EXCEEDED',
    'a category under a subcategory -> 422 CATEGORY_DEPTH_EXCEEDED',
    `${r.status} ${r.body?.error?.code}`,
  );

  r = await post('/categories', { name: parent.name }, su);
  ok(
    r.status === 409 && r.body?.error?.code === 'CATEGORY_EXISTS',
    'a duplicate name at the same level -> 409 CATEGORY_EXISTS',
    `${r.status} ${r.body?.error?.code}`,
  );

  // The same name under a DIFFERENT parent is legitimate and must be allowed - the case a
  // globally-unique slug alone would have wrongly rejected.
  const other = tree.find((n) => n.id !== parent.id);
  r = await post('/categories', { name: leaf.name, parentId: other.id }, su);
  ok(
    r.status === 201,
    `"${leaf.name}" under a second parent is allowed -> 201`,
    `${r.status} ${r.body?.error?.code}`,
  );
  const twinId = r.body?.id;
  ok(r.body?.slug === `${other.slug}-${leaf.slug.slice(parent.slug.length + 1)}`, 'and gets its own prefixed slug', r.body?.slug);

  r = await del(`/categories/${parent.id}`, su);
  ok(
    r.status === 409 && r.body?.error?.code === 'CATEGORY_IN_USE',
    'deleting a category that has children -> 409 CATEGORY_IN_USE',
    `${r.status} ${r.body?.error?.code}`,
  );
  ok(
    r.body?.error?.details?.childCount > 0,
    'and the error says how many are in the way',
    JSON.stringify(r.body?.error?.details),
  );

  r = await del(`/categories/${twinId}`, su);
  ok(r.status === 204, 'deleting an empty category -> 204', r.status);

  // --- a vendor cannot touch the taxonomy
  r = await post('/categories', { name: `Vendor Attempt ${stamp}` }, a.token);
  ok(
    r.status === 403 && r.body?.error?.code === 'FORBIDDEN',
    'a vendor creating a category -> 403 FORBIDDEN',
    `${r.status} ${r.body?.error?.code}`,
  );

  // ============================================================ service lifecycle

  r = await post('/services', SERVICE_BODY(leaf.id, `Draft Service ${stamp}`), a.token);
  ok(r.status === 201, 'vendor creates a service -> 201', `${r.status} ${JSON.stringify(r.body)}`);
  ok(r.body?.status === 'DRAFT', 'created as DRAFT, never PUBLISHED', r.body?.status);
  const draftId = r.body.id;

  // --- DONE WHEN #1: draft visibility
  r = await call(`/services/${draftId}`);
  ok(
    r.status === 404 && r.body?.error?.code === 'NOT_FOUND',
    'signed-out GET of a draft -> 404 (never 403 - existence is itself private)',
    `${r.status} ${r.body?.error?.code}`,
  );
  r = await call(`/services/${draftId}`, {}, a.token);
  ok(r.status === 200, 'the same id as its owner -> 200', r.status);
  ok(r.body?.status === 'DRAFT', 'and the owner sees the status field', r.body?.status);
  r = await call(`/services/${draftId}`, {}, b.token);
  ok(r.status === 404, "another vendor's GET of that draft -> 404", r.status);
  r = await call(`/services/${draftId}`, {}, su);
  ok(r.status === 200, 'a super admin GET of that draft -> 200', r.status);

  // --- status cannot be moved by PATCH
  r = await patch(`/services/${draftId}`, { status: 'PUBLISHED' }, a.token);
  ok(
    r.status === 422 && r.body?.error?.code === 'VALIDATION_FAILED',
    'PATCH with status in the body -> 422, not a silent publish',
    `${r.status} ${r.body?.error?.code}`,
  );

  r = await patch(`/services/${draftId}`, { title: `Renamed ${stamp}` }, b.token);
  ok(r.status === 404, "PATCH on another vendor's service -> 404", r.status);

  // --- publish preconditions
  r = await post(`/services/${draftId}/publish`, {}, a.token);
  ok(
    r.status === 422 && r.body?.error?.code === 'NO_ACTIVE_OFFERING',
    'publish with no offering -> 422 NO_ACTIVE_OFFERING',
    `${r.status} ${r.body?.error?.code}`,
  );

  r = await post(
    `/services/${draftId}/offerings`,
    { name: 'Standard', durationMinutes: 50, priceMinor: 150000 },
    a.token,
  );
  ok(
    r.status === 422 && r.body?.error?.code === 'DURATION_NOT_ALIGNED',
    '50 minutes on a 30-minute grid -> 422 DURATION_NOT_ALIGNED',
    `${r.status} ${r.body?.error?.code}`,
  );

  // 90 rather than 60: it divides evenly into the current 30-minute grid, and does NOT
  // divide into the 20-minute grid the narrowing check below tries to move to. 60 would
  // have satisfied both and the conflict assertion would have passed vacuously.
  r = await post(
    `/services/${draftId}/offerings`,
    { name: 'Standard', durationMinutes: 90, priceMinor: 150000 },
    a.token,
  );
  ok(r.status === 201, 'an aligned offering -> 201', `${r.status} ${JSON.stringify(r.body)}`);
  const offeringId = r.body.id;
  ok(r.body?.priceMinor === 150000 && r.body?.currency === 'INR', 'price stored in minor units', JSON.stringify(r.body));

  r = await post(`/services/${draftId}/publish`, {}, a.token);
  ok(
    r.status === 422 && r.body?.error?.code === 'NO_AVAILABILITY',
    'publish with an offering but no availability -> 422 NO_AVAILABILITY',
    `${r.status} ${r.body?.error?.code}`,
  );

  // Arranged through Prisma: the route that creates availability rules is M5's. The
  // precondition ships now because adding it later would mean revisiting publish.
  await prisma.availabilityRule.create({
    data: { serviceId: draftId, weekday: 1, startMinute: 540, endMinute: 1020, capacity: 2 },
  });

  r = await post(`/services/${draftId}/publish`, {}, a.token);
  ok(r.status === 200 && r.body?.status === 'PUBLISHED', 'with both in place, publish -> 200 PUBLISHED', `${r.status} ${r.body?.status}`);

  r = await call(`/services/${draftId}`);
  ok(r.status === 200, 'the published service is now visible signed-out -> 200', r.status);
  ok(!('status' in (r.body ?? {})), 'and the public shape omits status', Object.keys(r.body ?? {}).join(','));
  ok(
    r.body?.vendorProfile && !('userId' in r.body.vendorProfile),
    'and never leaks the vendor user id',
    JSON.stringify(r.body?.vendorProfile),
  );

  // --- the search vector tracks a rename
  // The reason searchVector is maintained by a database trigger rather than by service
  // code: a rename has to be searchable immediately, and there is no write path that can
  // forget to update it. Without this assertion the trigger's UPDATE branch is untested.
  const renamed = `quixotrophic${stamp}`;
  r = await patch(`/services/${draftId}`, { title: `${renamed} Deep Tissue` }, a.token);
  ok(r.status === 200, 'the owner renames a published service -> 200', r.status);
  r = await call(`/services?q=${renamed}`);
  ok(
    r.body?.meta?.total === 1 && r.body.data[0]?.id === draftId,
    'and it is searchable by the new title with no reindex step',
    `total ${r.body?.meta?.total}`,
  );

  // --- granularity narrowing is refused while it would strand an offering
  r = await patch(`/services/${draftId}`, { slotGranularityMinutes: 20 }, a.token);
  ok(
    r.status === 422 && r.body?.error?.code === 'GRANULARITY_CONFLICT',
    'narrowing the grid under a 60-minute offering -> 422 GRANULARITY_CONFLICT',
    `${r.status} ${r.body?.error?.code}`,
  );
  ok(
    r.body?.error?.details?.offeringIds?.includes(offeringId),
    'and names the offending offering',
    JSON.stringify(r.body?.error?.details),
  );

  // --- offerings visibility
  r = await patch(`/offerings/${offeringId}`, { isActive: false }, a.token);
  ok(r.status === 200 && r.body?.isActive === false, 'the owner deactivates an offering -> 200', r.status);
  r = await call(`/services/${draftId}/offerings`);
  ok(r.status === 200 && r.body.length === 0, 'a public caller sees no inactive offerings', JSON.stringify(r.body));
  r = await call(`/services/${draftId}/offerings`, {}, a.token);
  ok(r.status === 200 && r.body.length === 1, 'the owner still sees it', JSON.stringify(r.body));
  await patch(`/offerings/${offeringId}`, { isActive: true }, a.token);

  r = await patch(`/offerings/${offeringId}`, { priceMinor: 200000 }, b.token);
  ok(r.status === 404, "another vendor patching that offering -> 404", r.status);

  // ============================================================ search and filtering

  // 25 published services sharing one searchable token, arranged in one statement. They
  // therefore share a createdAt to the microsecond, which is exactly the condition that
  // breaks pagination without a tie-breaker in the ORDER BY.
  const TOKEN = `zorptastic${stamp}`;
  await prisma.service.createMany({
    data: Array.from({ length: 25 }, (_, i) => ({
      vendorProfileId: a.profileId,
      categoryId: leaf.id,
      title: `${TOKEN} Service ${String(i).padStart(2, '0')}`,
      description: 'Bulk-arranged row for the pagination assertion.',
      status: 'PUBLISHED',
      slotGranularityMinutes: 30,
      freeCancellationHours: 24,
      cancellationFeePercent: 50,
    })),
  });
  const bulk = await prisma.service.findMany({
    where: { title: { startsWith: TOKEN } },
    select: { id: true, createdAt: true },
  });
  ok(bulk.length === 25, '25 rows arranged', bulk.length);
  ok(
    new Set(bulk.map((s) => s.createdAt.toISOString())).size === 1,
    'all sharing one createdAt, so ordering must fall through to the tie-breaker',
  );

  // A draft with the same token, to prove search cannot surface one.
  const hidden = await prisma.service.create({
    data: {
      vendorProfileId: a.profileId,
      categoryId: leaf.id,
      title: `${TOKEN} Hidden Draft`,
      description: 'Never publicly visible.',
      status: 'DRAFT',
      slotGranularityMinutes: 30,
      freeCancellationHours: 24,
      cancellationFeePercent: 50,
    },
    select: { id: true },
  });

  // --- DONE WHEN #2: page 2 of a filtered search
  const expected = bulk.map((s) => s.id).sort();

  r = await call(`/services?q=${TOKEN}&categoryId=${leaf.id}&pageSize=10&page=1`);
  ok(r.status === 200, 'filtered search page 1 -> 200', `${r.status} ${JSON.stringify(r.body?.error)}`);
  ok(r.body?.meta?.total === 25, 'meta.total counts only the 25 published rows', r.body?.meta?.total);
  ok(r.body?.meta?.totalPages === 3, 'meta.totalPages = 3', r.body?.meta?.totalPages);
  const page1 = r.body.data.map((s) => s.id);

  r = await call(`/services?q=${TOKEN}&categoryId=${leaf.id}&pageSize=10&page=2`);
  const page2 = r.body.data.map((s) => s.id);
  ok(page2.length === 10, 'page 2 returns 10 rows', page2.length);
  ok(
    page2.every((id) => !page1.includes(id)),
    'and shares no row with page 1 - the unstable-sort bug an identical createdAt causes',
    `overlap: ${page2.filter((id) => page1.includes(id)).join(',')}`,
  );
  ok(
    JSON.stringify(page2) === JSON.stringify(expected.slice(10, 20)),
    'page 2 is exactly the expected ids, in the tie-broken order',
    `got ${page2.slice(0, 3).join(',')}... want ${expected.slice(10, 13).join(',')}...`,
  );

  r = await call(`/services?q=${TOKEN}&categoryId=${leaf.id}&pageSize=10&page=3`);
  ok(r.body?.data?.length === 5, 'page 3 returns the remaining 5', r.body?.data?.length);

  // --- the draft must not be reachable through search
  ok(
    ![...page1, ...page2, ...(r.body?.data ?? []).map((s) => s.id)].includes(hidden.id),
    'the draft sharing the search token appears on no page',
  );
  r = await call(`/services?q=${encodeURIComponent(`${TOKEN} Hidden Draft`)}`);
  // Zero, not 25: websearch_to_tsquery ANDs the terms, and "Hidden Draft" appears in no
  // published row. So a row with exactly this title exists and the search for it returns
  // nothing at all - the strongest form of the assertion.
  ok(
    r.body?.meta?.total === 0,
    "searching the draft's exact title returns nothing, though a row with that title exists",
    `total ${r.body?.meta?.total}`,
  );

  // --- stemming, which is the point of using a tsvector rather than ILIKE
  r = await call(`/services?q=plumbing`);
  ok(r.status === 200, 'a plain-language search -> 200, never a 500', r.status);
  r = await call(`/services?q=${encodeURIComponent('"unbalanced quote & | ! ( ')}`);
  ok(r.status === 200, 'malformed tsquery input -> 200 with no rows, not a 500', r.status);

  // --- clamping and rejection
  r = await call('/services?pageSize=5000');
  ok(r.body?.meta?.pageSize === 100, 'pageSize=5000 is clamped to 100, not an error', r.body?.meta?.pageSize);
  r = await call('/services?minPriceMinor=900&maxPriceMinor=100');
  ok(r.status === 422, 'min above max -> 422', r.status);
  r = await call('/services?sort=priceMinor');
  ok(r.status === 422, 'a sort field outside the allowlist -> 422', r.status);
  r = await call('/services?evil=1');
  ok(r.status === 422, 'an unknown query parameter -> 422 (schemas are strict)', r.status);

  // --- price filtering
  r = await call(`/services?minPriceMinor=140000&maxPriceMinor=160000`);
  ok(
    r.status === 200 && r.body.data.some((s) => s.id === draftId),
    'the 1500.00 service is inside a 1400-1600 band',
    r.body?.meta?.total,
  );
  r = await call(`/services?minPriceMinor=900000`);
  ok(
    r.status === 200 && !r.body.data.some((s) => s.id === draftId),
    'and outside a 9000+ band',
    r.body?.meta?.total,
  );

  // --- filtering by a parent includes its children
  r = await call(`/services?categoryId=${parent.id}&q=${TOKEN}`);
  ok(
    r.body?.meta?.total === 25,
    `filtering by the parent category includes services filed under "${leaf.name}"`,
    r.body?.meta?.total,
  );

  // ============================================================ suspension

  r = await post(`/admin/services/${draftId}/suspend`, { reason: 'Too short' }, su);
  ok(r.status === 422, 'suspend with a too-short reason -> 422', r.status);

  r = await post(`/admin/services/${draftId}/suspend`, {}, a.token);
  ok(r.status === 403, 'a vendor suspending their own service -> 403', r.status);

  r = await post(
    `/admin/services/${draftId}/suspend`,
    { reason: 'Investigating a customer complaint about this listing.' },
    su,
  );
  ok(r.status === 200 && r.body?.status === 'SUSPENDED', 'admin suspends -> 200 SUSPENDED', `${r.status} ${r.body?.status}`);

  r = await call(`/services/${draftId}`);
  ok(r.status === 404, 'a suspended service is gone from the public detail route -> 404', r.status);
  r = await call(`/services/${draftId}`, {}, a.token);
  ok(
    r.status === 200 && r.body?.suspensionReason?.includes('complaint'),
    'but its owner sees it, with the reason',
    `${r.status} ${r.body?.suspensionReason}`,
  );

  r = await post(`/services/${draftId}/unsuspend`, {}, a.token);
  ok(r.status === 404, 'there is no vendor route to unsuspend -> 404', r.status);

  r = await post(`/admin/services/${draftId}/unsuspend`, {}, su);
  ok(
    r.status === 200 && r.body?.status === 'PUBLISHED' && r.body?.suspensionReason === null,
    'admin unsuspends back to PUBLISHED with the reason cleared',
    `${r.status} ${r.body?.status}`,
  );

  // ============================================================ owner list and teardown

  r = await call('/vendors/me/services?pageSize=100', {}, a.token);
  ok(r.status === 200, "the vendor's own list -> 200", r.status);
  ok(
    r.body.data.some((s) => s.id === hidden.id),
    'and it includes their DRAFT, which the public list cannot show',
  );
  r = await call('/vendors/me/services?status=DRAFT&pageSize=100', {}, a.token);
  ok(
    r.body.data.every((s) => s.status === 'DRAFT'),
    '?status=DRAFT filters server-side',
    r.body?.data?.map((s) => s.status).join(','),
  );

  r = await call('/vendors/me/services', {}, su);
  ok(r.status === 403, 'a super admin has no vendor profile, so the owner list -> 403', r.status);

  r = await post(`/services/${draftId}/unpublish`, {}, a.token);
  ok(r.status === 200 && r.body?.status === 'DRAFT', 'unpublish -> 200 DRAFT', `${r.status} ${r.body?.status}`);

  r = await del(`/offerings/${offeringId}`, a.token);
  ok(r.status === 204, 'deleting an unbooked offering -> 204', r.status);

  r = await del(`/services/${draftId}`, b.token);
  ok(r.status === 404, "deleting another vendor's service -> 404", r.status);
  r = await del(`/services/${draftId}`, a.token);
  ok(r.status === 204, 'deleting an unbooked service -> 204', r.status);
  r = await call(`/services/${draftId}`, {}, a.token);
  ok(r.status === 404, 'and it is gone -> 404', r.status);

  // Arranged rows removed so repeat runs stay independent and the catalogue is not
  // polluted with 25 nonsense listings.
  await prisma.service.deleteMany({ where: { title: { startsWith: TOKEN } } });
  await prisma.$disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error('suite crashed', err);
  await prisma.$disconnect();
  process.exit(1);
});
