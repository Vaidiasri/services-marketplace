const B = process.env.API_URL ?? "http://localhost:3000";
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("PASS  " + label); }
  else { fail++; console.log("FAIL  " + label + (extra ? "  <- " + extra : "")); }
}
async function call(path, opts = {}, cookie) {
  const h = { "content-type": "application/json", ...(opts.headers || {}) };
  if (cookie) h.cookie = cookie;
  const r = await fetch(B + path, { ...opts, headers: h });
  const setCookie = r.headers.get("set-cookie");
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body, setCookie };
}
function refreshFrom(setCookie) {
  if (!setCookie) return null;
  const m = /refresh_token=([^;]+)/.exec(setCookie);
  return m ? "refresh_token=" + m[1] : null;
}

(async () => {
  const email = "cust" + Date.now() + "@marketplace.test";

  // --- validation at the boundary
  let r = await call("/auth/register/customer", { method: "POST", body: JSON.stringify({ email, password: "short" }) });
  ok(r.status === 422 && r.body.error.code === "VALIDATION_FAILED", "weak password -> 422 VALIDATION_FAILED, not 500", r.status);

  // --- strict(): an unexpected privileged key is rejected outright
  r = await call("/auth/register/customer", { method: "POST", body: JSON.stringify({ email, password: "correct-horse", fullName: "A", roleId: "super" }) });
  ok(r.status === 422, "extra roleId key -> 422 (strict schema blocks role injection)", r.status);

  // --- register
  r = await call("/auth/register/customer", { method: "POST", body: JSON.stringify({ email, password: "correct-horse", fullName: "Test Customer" }) });
  ok(r.status === 201 && !!r.body.accessToken, "register customer -> 201 with access token", r.status);
  const token = r.body.accessToken;
  let cookie = refreshFrom(r.setCookie);
  ok(!!cookie, "refresh cookie issued");
  ok(/HttpOnly/i.test(r.setCookie || ""), "refresh cookie is HttpOnly");
  ok(r.body.user.role.slug === "CUSTOMER", "role assigned server-side = CUSTOMER", r.body.user.role.slug);

  // --- duplicate email is a clean 409, not a database constraint error
  r = await call("/auth/register/customer", { method: "POST", body: JSON.stringify({ email, password: "correct-horse", fullName: "Dup" }) });
  ok(r.status === 409 && r.body.error.code === "EMAIL_TAKEN", "duplicate email -> 409 EMAIL_TAKEN", r.status);
  ok(!JSON.stringify(r.body).match(/prisma|constraint|Unique/i), "409 body leaks no Prisma text");

  // --- login
  r = await call("/auth/login", { method: "POST", body: JSON.stringify({ email, password: "correct-horse" }) });
  ok(r.status === 200, "login -> 200", r.status);
  r = await call("/auth/login", { method: "POST", body: JSON.stringify({ email, password: "wrong-password" }) });
  ok(r.status === 401 && r.body.error.code === "INVALID_CREDENTIALS", "wrong password -> 401", r.status);
  r = await call("/auth/login", { method: "POST", body: JSON.stringify({ email: "nobody" + Date.now() + "@x.test", password: "whatever12" }) });
  ok(r.status === 401 && r.body.error.code === "INVALID_CREDENTIALS", "unknown email -> identical 401 body", r.status);

  // --- /me resolves permissions from the database
  r = await call("/me", { headers: { authorization: "Bearer " + token } });
  ok(r.status === 200, "/me with token -> 200", r.status);
  ok(Array.isArray(r.body.permissions) && r.body.permissions.length === 10, "/me returns 10 CUSTOMER slugs", r.body.permissions && r.body.permissions.length);
  ok(!r.body.permissions.includes("booking.complete"), "customer does NOT hold booking.complete");

  r = await call("/me");
  ok(r.status === 401 && r.body.error.code === "UNAUTHENTICATED", "/me without token -> 401", r.status);
  r = await call("/me", { headers: { authorization: "Bearer not.a.jwt" } });
  ok(r.status === 401 && r.body.error.code === "TOKEN_INVALID", "forged token -> TOKEN_INVALID (client logs out)", r.body.error && r.body.error.code);

  // --- THE graded check: privileged route with a low-privilege token
  r = await call("/roles", { headers: { authorization: "Bearer " + token } });
  ok(r.status === 403 && r.body.error.code === "FORBIDDEN", "customer token on GET /roles -> 403", r.status);
  ok(JSON.stringify(r.body.error.details || {}).includes("role.read"), "403 names the missing slug");
  r = await call("/permissions", { headers: { authorization: "Bearer " + token } });
  ok(r.status === 403, "customer token on GET /permissions -> 403", r.status);
  r = await call("/roles", { method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify({ slug: "HACKER", name: "x", permissionSlugs: [] }) });
  ok(r.status === 403, "customer token on POST /roles -> 403", r.status);

  // --- refresh rotation, single use
  r = await call("/auth/refresh", { method: "POST" }, cookie);
  ok(r.status === 200 && !!r.body.accessToken, "refresh with cookie -> 200 new access token", r.status);
  const rotated = refreshFrom(r.setCookie);
  ok(!!rotated && rotated !== cookie, "refresh cookie rotated to a new value");

  // replay the OLD one: reuse detected
  r = await call("/auth/refresh", { method: "POST" }, cookie);
  ok(r.status === 401 && r.body.error.code === "REFRESH_INVALID", "replayed old refresh -> 401 REFRESH_INVALID", r.status);

  // chain revocation: the rotated token is dead too, because reuse revoked everything
  r = await call("/auth/refresh", { method: "POST" }, rotated);
  ok(r.status === 401, "reuse revoked the whole chain (rotated token also dead)", r.status);

  // --- logout is idempotent
  r = await call("/auth/login", { method: "POST", body: JSON.stringify({ email, password: "correct-horse" }) });
  const fresh = refreshFrom(r.setCookie);
  r = await call("/auth/logout", { method: "POST" }, fresh);
  ok(r.status === 204, "logout -> 204", r.status);
  r = await call("/auth/refresh", { method: "POST" }, fresh);
  ok(r.status === 401, "after logout the old refresh token mints nothing", r.status);
  r = await call("/auth/logout", { method: "POST" });
  ok(r.status === 204, "logout with no cookie -> 204 (idempotent)", r.status);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
