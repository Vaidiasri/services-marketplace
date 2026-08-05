/**
 * M3 vendor onboarding. Covers both of the brief's DONE WHEN items that are testable
 * without M4's catalogue routes, plus the third gate's branches and the self-approval
 * hole.
 *
 * Requires the two admin accounts from test/make-admins.mjs.
 * Run: node test/vendors.integration.mjs   (from server/)
 */
const B = process.env.API_URL ?? 'http://localhost:3000';
const PW = process.env.TEST_ADMIN_PASSWORD ?? 'TestPass!2026';

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
  const headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(B + path, { ...opts, headers });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 204 and streams have no JSON body */
  }
  return { status: res.status, body };
}

const login = async (email) =>
  (await call('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: PW }) }))
    .body?.accessToken;

(async () => {
  const su = await login('super@marketplace.test');
  ok(!!su, 'super admin signed in');

  // ---------------------------------------------------------------- registration
  const stamp = Date.now();
  const vendorEmail = `vendor${stamp}@marketplace.test`;
  let r = await call('/auth/register/vendor', {
    method: 'POST',
    body: JSON.stringify({
      email: vendorEmail,
      password: 'correct-horse',
      fullName: 'Vendor One',
      businessName: `Glass Salon ${stamp}`,
      contactName: 'Vendor One',
      contactPhone: '+91 99999 00000',
      addressLine1: '1 Test Road',
      city: 'Mumbai',
      state: 'MH',
      postalCode: '400001',
      timezone: 'Asia/Kolkata',
    }),
  });
  ok(r.status === 201, 'vendor registers -> 201', r.status);
  ok(r.body?.vendorProfile?.status === 'PENDING', 'profile created as PENDING', r.body?.vendorProfile?.status);
  const vendorToken = r.body.accessToken;
  const profileId = r.body.vendorProfile.id;

  // An invalid timezone must be refused at the boundary: it would silently break every
  // slot calculation for this vendor later.
  r = await call('/auth/register/vendor', {
    method: 'POST',
    body: JSON.stringify({
      email: `bad${stamp}@marketplace.test`,
      password: 'correct-horse',
      fullName: 'Bad TZ',
      businessName: 'Bad TZ Co',
      contactName: 'Bad',
      contactPhone: '+91 99999 00001',
      addressLine1: '2 Test Road',
      city: 'Mumbai',
      state: 'MH',
      postalCode: '400001',
      timezone: 'Mars/Olympus_Mons',
    }),
  });
  ok(r.status === 422, 'invalid IANA timezone -> 422 at the boundary', r.status);

  // Status is not settable from the request body.
  r = await call('/auth/register/vendor', {
    method: 'POST',
    body: JSON.stringify({
      email: `sneaky${stamp}@marketplace.test`,
      password: 'correct-horse',
      fullName: 'Sneaky',
      businessName: 'Sneaky Co',
      contactName: 'S',
      contactPhone: '+91 99999 00002',
      addressLine1: '3 Test Road',
      city: 'Mumbai',
      state: 'MH',
      postalCode: '400001',
      timezone: 'Asia/Kolkata',
      status: 'APPROVED',
    }),
  });
  ok(r.status === 422, 'status:APPROVED in the register body -> 422 (strict schema)', r.status);

  // ---------------------------------------------------------------- pending vendor's surface
  r = await call('/vendors/me', {}, vendorToken);
  ok(r.status === 200 && r.body.status === 'PENDING', 'pending vendor CAN read own profile', r.status);
  ok(r.body.timezone === 'Asia/Kolkata', 'timezone stored on the profile', r.body.timezone);

  r = await call('/me', {}, vendorToken);
  ok(r.body?.vendorProfile?.status === 'PENDING', '/me exposes vendorProfile.status', r.body?.vendorProfile?.status);

  // A vendor must not reach the approval queue at all.
  r = await call('/admin/vendors', {}, vendorToken);
  ok(r.status === 403, 'vendor on GET /admin/vendors -> 403', r.status);

  // THE self-approval hole: refused by the permission gate, before vendor status matters.
  r = await call(`/admin/vendors/${profileId}/approve`, { method: 'PATCH' }, vendorToken);
  ok(r.status === 403, 'vendor approving THEMSELVES -> 403', r.status);
  ok(r.body?.error?.code === 'FORBIDDEN', '-> FORBIDDEN from the permission gate, not the vendor gate', r.body?.error?.code);

  // ---------------------------------------------------------------- admin queue
  r = await call('/admin/vendors?status=PENDING&pageSize=100', {}, su);
  ok(r.status === 200, 'admin lists pending vendors -> 200', r.status);
  ok(Array.isArray(r.body.data) && typeof r.body.meta?.total === 'number', 'paginated envelope { data, meta }');
  ok(r.body.data.some((v) => v.id === profileId), 'the new vendor appears in the PENDING queue');

  r = await call('/admin/vendors?pageSize=5000', {}, su);
  ok(r.body?.meta?.pageSize === 100, 'oversized pageSize clamped to 100, not rejected', r.body?.meta?.pageSize);

  // ---------------------------------------------------------------- reject
  r = await call(`/admin/vendors/${profileId}/reject`, { method: 'PATCH', body: JSON.stringify({ reason: 'too short' }) }, su);
  ok(r.status === 422, 'reject with a 9-char reason -> 422', r.status);

  const REASON = 'Business registration document is unreadable, please re-upload it.';
  r = await call(`/admin/vendors/${profileId}/reject`, { method: 'PATCH', body: JSON.stringify({ reason: REASON }) }, su);
  ok(r.status === 200 && r.body.status === 'REJECTED', 'reject with a valid reason -> REJECTED', r.status);

  // The brief: "a rejection carries a reason the vendor can read".
  r = await call('/vendors/me', {}, vendorToken);
  ok(r.body?.rejectionReason === REASON, 'vendor reads the exact rejection reason', r.body?.rejectionReason);

  // ---------------------------------------------------------------- rejected is not terminal
  r = await call('/vendors/me', { method: 'PATCH', body: JSON.stringify({ contactPhone: '+91 88888 11111' }) }, vendorToken);
  ok(r.status === 200 && r.body.status === 'PENDING', 'editing while REJECTED reopens as PENDING', `${r.status} ${r.body?.status}`);
  ok(r.body?.rejectionReason === null, 'and clears the stale rejection reason', r.body?.rejectionReason);

  // ---------------------------------------------------------------- approve, same token
  r = await call(`/admin/vendors/${profileId}/approve`, { method: 'PATCH' }, su);
  ok(r.status === 200 && r.body.status === 'APPROVED', 'admin approves -> APPROVED', r.status);

  // DONE WHEN: approval is visible without logging out and back in. Same access token.
  r = await call('/me', {}, vendorToken);
  ok(r.body?.vendorProfile?.status === 'APPROVED', 'SAME access token now reports APPROVED - no re-login', r.body?.vendorProfile?.status);

  r = await call(`/admin/vendors/${profileId}/approve`, { method: 'PATCH' }, su);
  ok(r.status === 200, 're-approving is idempotent, not an error', r.status);

  // ---------------------------------------------------------------- the approved lock
  r = await call('/vendors/me', { method: 'PATCH', body: JSON.stringify({ businessName: 'Renamed After Approval' }) }, vendorToken);
  ok(r.status === 409 && r.body?.error?.code === 'PROFILE_LOCKED', 'approved vendor cannot rename the business -> 409 PROFILE_LOCKED', r.status);

  // The deliberate divergence from the plan: timezone stays editable, or a vendor
  // approved with the wrong zone could never fix it and every slot would be wrong.
  r = await call('/vendors/me', { method: 'PATCH', body: JSON.stringify({ timezone: 'Europe/London' }) }, vendorToken);
  ok(r.status === 200 && r.body.timezone === 'Europe/London', 'approved vendor CAN still fix timezone', `${r.status} ${r.body?.timezone}`);

  // ---------------------------------------------------------------- unknown ids
  r = await call('/admin/vendors/does-not-exist', {}, su);
  ok(r.status === 404, 'unknown vendor id -> 404', r.status);
  r = await call('/admin/vendors/does-not-exist/approve', { method: 'PATCH' }, su);
  ok(r.status === 404, 'approving an unknown vendor -> 404', r.status);
  r = await call('/vendors/me/documents/does-not-exist/download', {}, vendorToken);
  ok(r.status === 404, 'unknown document id -> 404', r.status);

  // ---------------------------------------------------------------- not a vendor
  const cust = `cust${stamp}@marketplace.test`;
  await call('/auth/register/customer', { method: 'POST', body: JSON.stringify({ email: cust, password: 'correct-horse', fullName: 'Cust' }) });
  const custToken = (await call('/auth/login', { method: 'POST', body: JSON.stringify({ email: cust, password: PW === 'x' ? PW : 'correct-horse' }) })).body?.accessToken;
  r = await call('/vendors/me', {}, custToken);
  ok(r.status === 403, 'customer on /vendors/me -> 403 (lacks vendor.read)', r.status);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
