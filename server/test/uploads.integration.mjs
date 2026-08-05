/**
 * Vendor document uploads: the MIME allowlist, the magic-byte sniff, the size limit,
 * cross-vendor isolation, and the download headers.
 *
 * Separate from vendors.integration.mjs because it needs two vendors and multipart
 * bodies, and because it writes to disk - keeping it apart means the main M3 suite still
 * runs clean if UPLOAD_DIR is not writable.
 *
 * Run: node test/uploads.integration.mjs   (from server/)
 */
const B = process.env.API_URL ?? 'http://localhost:3000';

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
  if (opts.body && typeof opts.body === 'string') headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(B + path, { ...opts, headers });
  let body = null;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
  }
  return { status: res.status, body, headers: res.headers };
}

/** A minimal but genuinely valid PDF - magic bytes plus enough structure to be a file. */
const realPdf = () =>
  new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]), '%%EOF\n'], {
    type: 'application/pdf',
  });

/** Declares itself a PDF but its bytes are not. This is what the sniff must catch. */
const fakePdf = () => new Blob(['MZ\x90\x00 this is an executable, not a pdf'], { type: 'application/pdf' });

async function registerVendor(stamp, suffix) {
  const email = `up${stamp}${suffix}@marketplace.test`;
  const r = await call('/auth/register/vendor', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password: 'correct-horse',
      fullName: `Upload Vendor ${suffix}`,
      businessName: `Upload Co ${stamp}${suffix}`,
      contactName: 'U',
      contactPhone: '+91 90000 00000',
      addressLine1: '9 Upload Way',
      city: 'Mumbai',
      state: 'MH',
      postalCode: '400001',
      timezone: 'Asia/Kolkata',
    }),
  });
  return { token: r.body.accessToken, profileId: r.body.vendorProfile.id };
}

function form(blob, filename) {
  const fd = new FormData();
  fd.set('file', blob, filename);
  return fd;
}

(async () => {
  const stamp = Date.now();
  const a = await registerVendor(stamp, 'a');
  const b = await registerVendor(stamp, 'b');
  ok(!!a.token && !!b.token, 'two pending vendors registered');

  // ---------------------------------------------------------------- happy path
  let r = await call(
    '/vendors/me/documents?kind=REGISTRATION',
    { method: 'POST', body: form(realPdf(), 'registration.pdf') },
    a.token,
  );
  ok(r.status === 201, 'pending vendor uploads a real PDF -> 201', `${r.status} ${JSON.stringify(r.body)}`);
  ok(r.body?.kind === 'REGISTRATION', 'kind recorded from the query', r.body?.kind);
  ok(r.body?.originalFilename === 'registration.pdf', 'original filename kept for display', r.body?.originalFilename);
  const docId = r.body.id;

  // ---------------------------------------------------------------- magic bytes
  r = await call(
    '/vendors/me/documents',
    { method: 'POST', body: form(fakePdf(), 'evil.pdf') },
    a.token,
  );
  ok(
    r.status === 422 && r.body?.error?.code === 'UNSUPPORTED_FILE_TYPE',
    'a file DECLARING application/pdf whose bytes are not a PDF -> 422',
    `${r.status} ${r.body?.error?.code}`,
  );

  // A type not on the allowlist at all is refused by multer's filter, before any write.
  r = await call(
    '/vendors/me/documents',
    { method: 'POST', body: form(new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'x.svg') },
    a.token,
  );
  ok(r.status === 422, 'a disallowed MIME type (svg) -> 422', r.status);

  // ---------------------------------------------------------------- size limit
  const big = new Blob(
    [new Uint8Array([0x25, 0x50, 0x44, 0x46]), new Uint8Array(6 * 1024 * 1024)],
    { type: 'application/pdf' },
  );
  r = await call('/vendors/me/documents', { method: 'POST', body: form(big, 'big.pdf') }, a.token);
  ok(r.status === 413, 'a 6 MB file against a 5 MB limit -> 413', r.status);
  ok(r.body?.error?.code === 'FILE_TOO_LARGE', '-> FILE_TOO_LARGE, not a bare 413', r.body?.error?.code);

  // ---------------------------------------------------------------- download
  r = await call(`/vendors/me/documents/${docId}/download`, {}, a.token);
  ok(r.status === 200, 'owner downloads their own document -> 200', r.status);
  ok(
    (r.headers.get('content-disposition') ?? '').startsWith('attachment;'),
    'served as an attachment, never inline',
    r.headers.get('content-disposition'),
  );
  ok(
    r.headers.get('x-content-type-options') === 'nosniff',
    'and with nosniff, so a vendor-supplied file cannot be interpreted',
    r.headers.get('x-content-type-options'),
  );

  // ---------------------------------------------------------------- cross-vendor
  r = await call(`/vendors/me/documents/${docId}/download`, {}, b.token);
  ok(r.status === 404, "Vendor B downloading Vendor A's document -> 404, not 403", r.status);
  ok(
    !JSON.stringify(r.body ?? {}).includes('registration.pdf'),
    'and the 404 body leaks no field from the record',
  );

  r = await call(`/vendors/me/documents/${docId}`, { method: 'DELETE' }, b.token);
  ok(r.status === 404, "Vendor B deleting Vendor A's document -> 404", r.status);

  // ---------------------------------------------------------------- approved lock
  const su = (
    await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'super@marketplace.test',
        password: process.env.TEST_ADMIN_PASSWORD ?? 'TestPass!2026',
      }),
    })
  ).body.accessToken;

  await call(`/admin/vendors/${a.profileId}/approve`, { method: 'PATCH' }, su);

  r = await call(
    '/vendors/me/documents',
    { method: 'POST', body: form(realPdf(), 'after-approval.pdf') },
    a.token,
  );
  ok(
    r.status === 409 && r.body?.error?.code === 'PROFILE_LOCKED',
    'approved vendor cannot add documents -> 409 PROFILE_LOCKED (evidence is frozen)',
    `${r.status} ${r.body?.error?.code}`,
  );

  r = await call(`/vendors/me/documents/${docId}`, { method: 'DELETE' }, a.token);
  ok(r.status === 409, 'approved vendor cannot delete documents either -> 409', r.status);

  // An admin can read any vendor's document through the admin route.
  r = await call(`/admin/vendors/${a.profileId}/documents/${docId}/download`, {}, su);
  ok(r.status === 200, "admin downloads a vendor's document -> 200", r.status);

  // ---------------------------------------------------------------- delete while pending
  r = await call(
    '/vendors/me/documents',
    { method: 'POST', body: form(realPdf(), 'b-doc.pdf') },
    b.token,
  );
  ok(r.status === 201, 'pending Vendor B uploads -> 201', r.status);
  const bDoc = r.body.id;
  r = await call(`/vendors/me/documents/${bDoc}`, { method: 'DELETE' }, b.token);
  ok(r.status === 204, 'pending vendor deletes their own document -> 204', r.status);
  r = await call(`/vendors/me/documents/${bDoc}/download`, {}, b.token);
  ok(r.status === 404, 'and it is gone -> 404', r.status);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
