# M2 - Roles & Permissions (Plan)

Brief module 02. **Reviewed first** per the brief. Permissions rubric area, 20 marks -
the largest single block, tied with booking integrity.

## Key decisions

- **Roles and permissions are rows, never TypeScript enums.** The only string literals
  in the codebase are the slug constants used in route decorators, which are compared
  against database rows. `Role.slug` is not typed as a union - a role created at runtime
  must work with no type change, which a union would forbid.
- **Permissions resolved per request, not from the token.** A short per-request cache
  (see below) makes this cheap. The alternative - permissions in the JWT - fails the
  brief's revocation check outright.
- **Two guards, not one.** `PermissionsGuard` answers "may this role do this verb at
  all", and runs at the route level. Ownership is a **service-layer scope**, not a
  guard, because the guard cannot know how to load an arbitrary resource. Details below.
- **`SUPER_ADMIN` bypasses via role-slug short-circuit.** Not by holding all slugs.
- **403 for public-shaped resources, 404 for confidential ones.** The brief accepts
  either; the split is documented in [03_API_CONVENTIONS.md](../../03_API_CONVENTIONS.md).
- **System roles cannot be deleted or renamed.** `Role.isSystem` guards the four seeded
  roles. Their *permissions* remain editable - that is the whole demo.

## API contract

| Method | Endpoint | Requires | Notes |
| --- | --- | --- | --- |
| GET | `/permissions` | `permission.read` | Flat list, grouped by `resource` for the UI |
| GET | `/roles` | `role.read` | Includes permission slugs and a user count per role |
| GET | `/roles/:id` | `role.read` | |
| POST | `/roles` | `role.create` | `{ slug, name, permissionSlugs: string[] }` |
| PATCH | `/roles/:id` | `role.update` | `{ name?, permissionSlugs? }`. Sending `permissionSlugs` replaces the whole set |
| DELETE | `/roles/:id` | `role.delete` | 409 if `isSystem` or if any user holds it |
| PUT | `/users/:id/role` | `role.assign` | `{ roleId }` |
| DELETE | `/roles/:id/permissions/:slug` | `role.update` | The single-permission revoke used for the live demo |

## Impact map

- `server/prisma/schema.prisma` - `Role`, `Permission`, `RolePermission` - add
- `server/prisma/seed.ts` - permission catalogue + four roles - add - idempotent
  `upsert` on slug, so re-running the seed against the deployed database never
  duplicates and never wipes an admin's runtime edits to non-system roles
- `server/src/rbac/rbac.module.ts` - add, exported globally so every feature module can
  use the guard without re-importing
- `server/src/rbac/permissions.guard.ts` - `canActivate` - add - the single enforcement point
- `server/src/rbac/require-permissions.decorator.ts` - `RequirePermissions(...slugs)` - add
- `server/src/rbac/permission-resolver.service.ts` - `getEffectiveSlugs(userId)` - add -
  the only place that reads `RolePermission`; also backs `/me`
- `server/src/rbac/ownership.ts` - `assertOwnership`, `scopeToCaller` - add - shared
  helpers each feature service calls
- `server/src/rbac/roles.controller.ts` / `roles.service.ts` - the eight routes - add
- `server/src/auth/auth.service.ts` - `me` - modify - returns resolved slugs
- `client/src/lib/permissions.ts` - `useCan(slug)` hook - add
- `client/src/components/Can.tsx` - conditional render wrapper - add
- `client/src/routes/*` - route guards driven by `useCan` - add

## The guard

```ts
@RequirePermissions('booking.cancel')            // route declares what it needs
canActivate(ctx: ExecutionContext): Promise<boolean>
```

1. Read required slugs from route metadata. None declared -> the route is public,
   allow. (Public is opt-in by omission, so a forgotten decorator on an admin route
   would be a hole - mitigated by the test in Test Strategy below.)
2. Read `{ userId, roleSlug }` attached by `JwtAuthGuard`. Absent -> 401.
3. `roleSlug === 'SUPER_ADMIN'` -> allow.
4. Resolve effective slugs for the user. Every required slug must be present - the
   check is AND, not OR. A route needing either of two permissions declares one and
   branches in the service.
5. Missing any -> 403 `FORBIDDEN`, with the missing slug in `details` (safe to reveal:
   it tells the caller nothing they could not learn from the API reference, and makes
   the reviewer's job easy).

**Cache:** effective slugs are memoised per request in `AsyncLocalStorage`, keyed by
user id. So a request touching three guards makes one query. There is deliberately no
cross-request cache - a 30-second Redis cache would make the revocation demo look
broken for 30 seconds, and that demo is worth more than the query.

## Ownership

Not a guard. A guard would have to load an arbitrary resource by id from an arbitrary
table, which means either a giant switch or a generic loader that is worse than the
thing it replaces. Instead:

- **List endpoints** call `scopeToCaller(where, caller)`, which adds the ownership
  predicate to the Prisma `where` **before** the query runs. A vendor listing bookings
  gets `vendorProfileId = <theirs>` merged in. Filtering after the fetch is not done
  anywhere - it would leak via the `total` count even when rows are hidden.
- **Detail and mutation endpoints** load the record, then call
  `assertOwnership(record, caller, { notFoundOnMismatch: true })`.

```ts
function scopeToCaller<W>(where: W, caller: Caller, resource: OwnedResource): W
function assertOwnership(record: { ownerUserId?: string; vendorProfileId?: string },
                         caller: Caller, opts?: { notFoundOnMismatch?: boolean }): void
```

Ownership rules by resource:

| Resource | Customer sees | Vendor sees | Holder of `*.read_all` |
| --- | --- | --- | --- |
| Booking | `customerUserId = self` | `vendorProfileId = own` | all |
| Service | published only | `vendorProfileId = own` | all, any status |
| Payment | via own booking | via own service's booking | all |
| VendorProfile | none | own | all |
| Availability | read-only, published services | own services | all |

`SUPER_ADMIN` skips both helpers.

## Error handling

| Operation | Failure | Behaviour |
| --- | --- | --- |
| Guard | No token | 401 `UNAUTHENTICATED` |
| Guard | Missing permission | 403 `FORBIDDEN`, `details.missing` lists the slugs |
| Ownership | Cross-tenant on a confidential resource | 404 `NOT_FOUND` - Vendor A asking for Vendor B's booking |
| Ownership | Cross-tenant on a public-shaped resource | 403 `FORBIDDEN` |
| `POST /roles` | Slug already exists | 409 `ROLE_SLUG_TAKEN` |
| `POST`/`PATCH /roles` | Unknown permission slug in the array | 422 with the offending slugs listed. Partial application is never done - the whole request fails. |
| `DELETE /roles/:id` | `isSystem` | 409 `SYSTEM_ROLE_IMMUTABLE` |
| `DELETE /roles/:id` | Users still hold it | 409 `ROLE_IN_USE` with the count. Reassign first. |
| `PUT /users/:id/role` | Caller assigns a role holding permissions the caller lacks | 403 `ESCALATION_BLOCKED`. See Security. |
| Resolver | User's role row deleted underneath them | Treated as zero permissions, 403. Not a 500. |

## Security

| Threat | Mitigation |
| --- | --- |
| **Escalation by role assignment.** A sub-admin with `role.assign` grants themselves, or a confederate, a role containing `role.update` and owns the system. | A non-super-admin may only assign a role whose permission set is a **subset** of their own. Same rule on `role.create` and `role.update`: you cannot mint a role holding a permission you do not hold. Without this, `role.assign` is equivalent to super admin. |
| Escalation by request body | `roleId` and `permissions` are absent from every non-RBAC DTO, and all DTOs are `.strict()`. Role assignment happens only on the dedicated route, behind `role.assign`. |
| Client-only enforcement | Every protected route carries `@RequirePermissions`. Enforced by the metadata test below, not by discipline. |
| Stale permissions after revoke | No cross-request cache; resolved per request. |
| Last super admin removed | `PUT /users/:id/role` and `DELETE /users/:id` refuse if the target is the only active `SUPER_ADMIN` - 409 `LAST_SUPER_ADMIN`. Otherwise the deployed instance can be bricked, which the brief scores as a load-time failure. |
| System role tampering | `isSystem` blocks delete and slug change. |

## Implementation order

- Schema + seed the catalogue and four roles. Everything else needs rows to read.
- `permission-resolver.service` with a unit test, then wire it into `/me`. `/me` being
  correct is the contract the whole client depends on.
- `PermissionsGuard` + decorator, applied to one throwaway route, and prove 403 before
  spreading it.
- `ownership.ts`, exercised against `Service` first (simplest owner field).
- Roles CRUD, with the subset rule from day one - retrofitting it means auditing every
  route again.

## Risks and edge cases

- **A protected route with no decorator is silently public.** The single highest risk
  in this module. Mitigated by a test that enumerates every registered route via the
  Nest router explorer and fails if any non-allowlisted path lacks both
  `@Public()` and `@RequirePermissions`. The allowlist is explicit and short:
  `/health`, `/auth/*`, public catalogue reads.
- **The subset rule can lock out a legitimate admin** who needs to grant a permission
  they do not personally hold. Accepted: super admin can always do it. Documented in
  DECISIONS.md rather than silently worked around.
- **`permissionSlugs` as full replacement** means a UI that sends a partial list wipes
  permissions. The client always sends the complete set from the checkbox state; the
  single-slug revoke route exists for the demo so the demo cannot be the thing that
  wipes a role.
- **Per-request query cost.** One extra join per request. At the free tier's traffic
  this is noise, and Neon's connection pooler handles it - but the M6 concurrency
  script will hit it 20 times at once, so the resolver query must be indexed
  (`RolePermission(roleId)`).
- **Two-level guard order matters.** `JwtAuthGuard` must run before `PermissionsGuard`,
  or the latter sees no user and returns 401 for everything including public routes.
  Global guard registration order is asserted in a test.

## Test strategy

The brief names the permission guard as one of the three tests that carry weight.

- **Guard unit test:** table-driven over (roleSlug, heldSlugs, requiredSlugs) ->
  expected allow/deny. Includes the super-admin bypass and the empty-permissions role.
- **Integration - the graded curl:** seeded catalogue moderator's token against
  `GET /admin/bookings`, `POST /roles`, `PATCH /vendors/:id/approve` - all 403. Same
  requests with the super admin token - all 2xx. Run against the **deployed** API too,
  since the brief says "this is tested against the deployed API."
- **Integration - live revocation:** moderator creates a category (201), super admin
  revokes `category.create`, moderator retries (403), all in one test with no restart
  between. This is the proof that roles are data.
- **Integration - cross-tenant:** Vendor A's token requesting Vendor B's booking id ->
  404, and the response body contains no field from the record.
- **Route coverage test:** every route has a permission declaration or is explicitly
  allowlisted as public.
