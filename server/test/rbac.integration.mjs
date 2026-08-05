const B = process.env.API_URL ?? "http://localhost:3000";
const PW = process.env.TEST_ADMIN_PASSWORD ?? "TestPass!2026";
let pass = 0, fail = 0;
const ok = (c, l, e) => { if (c) { pass++; console.log("PASS  " + l); } else { fail++; console.log("FAIL  " + l + (e !== undefined ? "  <- " + e : "")); } };
async function call(path, opts = {}, token) {
  const h = { "content-type": "application/json", ...(opts.headers || {}) };
  if (token) h.authorization = "Bearer " + token;
  const r = await fetch(B + path, { ...opts, headers: h });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
}
const login = async (email) => (await call("/auth/login", { method: "POST", body: JSON.stringify({ email, password: PW }) })).body.accessToken;

(async () => {
  const su = await login("super@marketplace.test");
  const mod = await login("moderator@marketplace.test");
  ok(!!su && !!mod, "both admins signed in");

  // super admin bypasses by role slug while holding ZERO permission rows
  let r = await call("/me", {}, su);
  ok(r.body.permissions.length === 1 && r.body.permissions[0] === "*", "super admin /me reports '*'", JSON.stringify(r.body.permissions));
  r = await call("/roles", {}, su);
  ok(r.status === 200, "super admin GET /roles -> 200 despite holding no rows", r.status);
  const roles = r.body;
  const modRole = roles.find(x => x.slug === "CATALOGUE_MODERATOR");
  ok(modRole.permissions.length === 8, "CATALOGUE_MODERATOR holds 8 slugs", modRole.permissions.length);
  ok(roles.find(x => x.slug === "SUPER_ADMIN").permissions.length === 0, "SUPER_ADMIN row holds 0 slugs (bypass, not grant)");

  // the restricted sub-admin is genuinely restricted
  r = await call("/roles", {}, mod);
  ok(r.status === 403, "moderator GET /roles -> 403", r.status);

  // ---- THE REVOCATION DEMO, no restart anywhere in here
  r = await call("/roles/" + modRole.id, { method: "PATCH", body: JSON.stringify({ permissionSlugs: [...modRole.permissions, "role.read"] }) }, su);
  ok(r.status === 200 && r.body.permissions.includes("role.read"), "super admin grants role.read to moderator", r.status);

  r = await call("/roles", {}, mod);
  ok(r.status === 200, "moderator's NEXT request with the SAME token -> 200 (grant took effect live)", r.status);

  r = await call("/roles/" + modRole.id + "/permissions/role.read", { method: "DELETE" }, su);
  ok(r.status === 200 && !r.body.permissions.includes("role.read"), "super admin revokes role.read", r.status);

  r = await call("/roles", {}, mod);
  ok(r.status === 403, "moderator's NEXT request, same token -> 403 (revoke took effect live, no redeploy)", r.status);

  r = await call("/me", {}, mod);
  ok(r.body.permissions.length === 8 && !r.body.permissions.includes("role.read"), "/me shrank back to 8 slugs", r.body.permissions.length);

  // ---- subset rule: escalation blocked
  r = await call("/roles/" + modRole.id, { method: "PATCH", body: JSON.stringify({ permissionSlugs: [...modRole.permissions, "role.update", "role.create"] }) }, su);
  ok(r.status === 200, "super admin temporarily grants moderator role.update + role.create", r.status);

  r = await call("/roles", { method: "POST", body: JSON.stringify({ slug: "ESCALATED", name: "x", permissionSlugs: ["booking.read_all"] }) }, mod);
  ok(r.status === 403, "moderator with role.update cannot mint a role holding booking.read_all", r.status);
  ok(r.body.error && r.body.error.code === "ESCALATION_BLOCKED", "-> ESCALATION_BLOCKED", r.body.error && r.body.error.code);

  r = await call("/roles/" + modRole.id, { method: "PATCH", body: JSON.stringify({ permissionSlugs: [...modRole.permissions, "role.update", "role.create", "booking.read_all"] }) }, mod);
  ok(r.status === 403, "moderator cannot add booking.read_all to its OWN role", r.status);

  // it CAN grant what it already holds
  r = await call("/roles", { method: "POST", body: JSON.stringify({ slug: "SUBSET_OK", name: "Subset OK", permissionSlugs: ["category.read"] }) }, mod);
  ok(r.status === 201, "moderator CAN mint a role holding category.read, which it does hold", r.status);
  const made = r.body.id;

  // system roles cannot be deleted or renamed
  r = await call("/roles/" + modRole.id, { method: "DELETE" }, su);
  ok(r.status === 409 && r.body.error.code === "SYSTEM_ROLE_IMMUTABLE", "DELETE a system role -> 409 SYSTEM_ROLE_IMMUTABLE", r.status);
  r = await call("/roles/" + modRole.id, { method: "PATCH", body: JSON.stringify({ name: "Renamed" }) }, su);
  ok(r.status === 409, "renaming a system role -> 409", r.status);

  // unknown slug fails whole request
  r = await call("/roles", { method: "POST", body: JSON.stringify({ slug: "BOGUS", name: "b", permissionSlugs: ["not.a.real.slug"] }) }, su);
  ok(r.status === 422 && r.body.error.code === "UNKNOWN_PERMISSIONS", "unknown permission slug -> 422, nothing created", r.status);

  // last super admin protection
  const custRole = roles.find(x => x.slug === "CUSTOMER");
  const suId = (await call("/me", {}, su)).body.id;
  r = await call("/users/" + suId + "/role", { method: "PUT", body: JSON.stringify({ roleId: custRole.id }) }, su);
  ok(r.status === 409 && r.body.error.code === "LAST_SUPER_ADMIN", "demoting the only super admin -> 409 LAST_SUPER_ADMIN", r.status);

  // cleanup
  await call("/roles/" + made, { method: "DELETE" }, su);
  await call("/roles/" + modRole.id, { method: "PATCH", body: JSON.stringify({ permissionSlugs: modRole.permissions }) }, su);
  r = await call("/roles/" + modRole.id, {}, su);
  ok(r.body.permissions.length === 8, "moderator role restored to 8 slugs", r.body.permissions.length);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
