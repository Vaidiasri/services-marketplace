# M1 - Accounts & Authentication (Plan)

Brief module 01. Feeds the Permissions rubric area (20 marks) jointly with
[M2](../M2_PERMISSIONS/plan.md). Build these two together; they are one surface.

## Key decisions

- **Argon2id over bcrypt.** `argon2` npm package, memory cost 19 MiB, time cost 2,
  parallelism 1 (OWASP baseline). Both are permitted by the brief; Argon2id is the
  current recommendation and costs nothing extra to adopt.
- **Access token carries no permissions.** Payload is `{ sub, roleSlug, jti }` only.
  Permissions are resolved from the database per request. This is what makes the
  brief's "revoke with no redeploy" check pass; a permission list in the JWT would
  stay stale until expiry.
- **Refresh token in an httpOnly cookie, not the body.** The client is on a different
  origin (Vercel) from the API (Render), so the cookie is `secure`, `sameSite=none`,
  and the API sets an explicit `CLIENT_ORIGIN` CORS allowlist with credentials on.
- **Refresh tokens rotate and are single-use.** Each refresh revokes the presented
  token and issues a new one, linked via `replacedByTokenId`. Presenting an already
  revoked token revokes the entire chain for that user - detected reuse is treated as
  theft.
- **Only the hash of a refresh token is stored.** SHA-256 is sufficient here (the
  token is 32 random bytes, so it is not brute-forceable) and is far faster than
  Argon2 on a route hit on every token refresh.
- **One role per user.** `User.roleId` is a scalar relation, not a join table. The
  brief's scenario ("assign a Catalogue Moderator role to a sub-admin") needs exactly
  one role per user; multi-role adds a resolution-order problem for no marks.

## Dependencies (new)

| Package | Why | Risk |
| --- | --- | --- |
| `argon2` | Password hashing | Native module. Render's build image compiles it fine, but it must be a production dependency, and the Node version is pinned in `package.json` `engines` so the prebuilt binary matches. |
| `@nestjs/jwt` | Sign and verify access tokens | None |
| `cookie-parser` | Read the refresh cookie | None |
| `zod` | Boundary validation | None |

## API contract

| Method | Endpoint | Request | Response |
| --- | --- | --- | --- |
| POST | `/auth/register/customer` | `{ email, password, fullName }` | 201 `{ user, accessToken }` + refresh cookie |
| POST | `/auth/register/vendor` | `{ email, password, fullName, businessName, contactPhone, address..., timezone }` | 201 `{ user, vendorProfile, accessToken }` + refresh cookie. Profile status `PENDING` |
| POST | `/auth/login` | `{ email, password }` | 200 `{ user, accessToken }` + refresh cookie |
| POST | `/auth/refresh` | refresh cookie only | 200 `{ accessToken }` + rotated refresh cookie |
| POST | `/auth/logout` | refresh cookie only | 204, cookie cleared, token row revoked |
| GET | `/me` | Bearer token | 200 `{ id, email, fullName, role: { slug, name }, permissions: string[], vendorProfile?: { id, status, rejectionReason } }` |
| POST | `/auth/forgot-password` | `{ email }` | 202 always. Reset link printed to console. **STRETCH** |
| POST | `/auth/reset-password` | `{ token, password }` | 204. Single-use, 30 min expiry. **STRETCH** |

There is deliberately no `POST /auth/register/admin`. Admins are created via
`POST /users` under `user.create` + `role.assign`, which lives in
[M8](../M8_ADMIN_CONSOLE/plan.md).

## Impact map

Greenfield, so everything is `add`.

- `server/prisma/schema.prisma` - `User`, `Role`, `Permission`, `RolePermission`,
  `RefreshToken`, `PasswordResetToken` - add - see [01_DATA_MODEL.md](../../01_DATA_MODEL.md)
- `server/src/auth/auth.module.ts` - module wiring - add
- `server/src/auth/auth.controller.ts` - the seven routes above - add
- `server/src/auth/auth.service.ts` - `registerCustomer`, `registerVendor`, `login`,
  `refresh`, `logout`, `me` - add
- `server/src/auth/token.service.ts` - `issueAccessToken`, `issueRefreshToken`,
  `rotateRefreshToken`, `revokeRefreshToken`, `revokeChain` - add - isolates all token
  lifecycle so M2's guard only ever consumes a verified payload
- `server/src/auth/password.service.ts` - `hash`, `verify` - add - one place where
  Argon2 parameters live, so a future cost bump is a one-line change
- `server/src/auth/dto/*.ts` - Zod schemas, all `.strict()` - add
- `server/src/auth/guards/jwt-auth.guard.ts` - verifies the bearer token, attaches
  `{ userId, roleSlug }` to the request - add
- `server/src/common/filters/all-exceptions.filter.ts` - the error envelope - add -
  shared, but authored here because auth is the first module to need 401/409
- `client/src/lib/api.ts` - fetch wrapper with the single-retry refresh interceptor - add
- `client/src/lib/auth-store.ts` - access token in memory, `me` from TanStack Query - add

## Algorithms

### Refresh with single retry (client)

1. Request fires with the in-memory access token.
2. On 401 with code `TOKEN_EXPIRED`, and if no refresh is already in flight, call
   `POST /auth/refresh`.
3. Concurrent 401s subscribe to that same in-flight promise rather than each firing
   their own refresh - otherwise a dashboard with six parallel queries triggers six
   rotations and five of them are treated as token reuse.
4. On refresh success, replace the in-memory token and replay the original request
   exactly once.
5. On refresh failure, clear auth state and redirect to login. Never retry a second time.

### Refresh rotation (server)

1. Read the cookie, hash it, look up the `RefreshToken` row.
2. No row, or `expiresAt` past -> 401.
3. Row has `revokedAt` set -> **reuse detected**: revoke every non-revoked token for
   that user and return 401.
4. Otherwise, in one transaction: set `revokedAt` on the presented row, insert a new
   row, set `replacedByTokenId` on the old one.
5. Return a new access token and set the new cookie.

## Error handling

| Operation | Failure | Behaviour |
| --- | --- | --- |
| Register | Email exists | 409 `EMAIL_TAKEN`. Checked by catching Prisma `P2002` on the unique index, not by a pre-read - a pre-read races. |
| Register | Weak password | 422 `VALIDATION_FAILED` with the field detail. Minimum 8 chars. |
| Login | Unknown email | 401 `INVALID_CREDENTIALS`, and Argon2 verify still runs against a dummy hash so the response time does not reveal which case it was. |
| Login | Wrong password | 401 `INVALID_CREDENTIALS`. Identical body to unknown email. |
| Login | `isActive = false` | 403 `ACCOUNT_DISABLED` |
| Any protected route | Expired access token | 401 `TOKEN_EXPIRED` - a distinct code so the client knows to refresh rather than log out |
| Any protected route | Malformed or forged token | 401 `TOKEN_INVALID` - client logs out, does not refresh |
| Refresh | Revoked or unknown token | 401 `REFRESH_INVALID`, cookie cleared |
| Logout | No cookie present | 204 anyway. Logout is idempotent. |
| `/me` | Role has no permissions | 200 with `permissions: []`. Not an error; a stripped role is a valid state. |
| Argon2 | Native module unavailable | Fails at boot with a clear message rather than at first login. |

## Security

| Threat | Mitigation |
| --- | --- |
| Privilege escalation via request body | Every DTO `.strict()`; `role`, `roleId`, `permissions` are not fields on any auth DTO, so their presence is a 422. Role on register is set server-side from the route (`/register/customer` -> `CUSTOMER`). |
| Password in logs | The logging interceptor redacts `password`, `token`, `authorization` keys before serialising. Verified by a test that posts a login and asserts the log line has no plaintext. |
| Token theft via XSS | Refresh token is `httpOnly`, so script cannot read it. Access token lives in memory only - never `localStorage`. |
| CSRF on the refresh cookie | `sameSite=none` is required cross-origin, so CSRF protection comes from the refresh endpoint requiring nothing else - it mints only an access token, returned in the body, which an attacker's page cannot read cross-origin. |
| Refresh token replay | Single-use rotation plus chain revocation on reuse. |
| Brute force login | Per-IP rate limit on `/auth/login` and `/auth/register/*` via `@nestjs/throttler`, 10 per minute. |
| Token never expires | 15 minute access TTL asserted by a test, not just configured. |
| Enumeration via forgot-password | Always 202, regardless of whether the email exists. |

## Implementation order

- `Role`/`Permission`/`RolePermission`/`User` schema + seed the four roles, before any
  route exists. Registration needs a `roleId` to point at.
- `password.service` and `token.service`, with unit tests, before the controller.
- The exception filter, before the first route - so the 409 is correct the first time
  rather than being retrofitted.
- Register + login + `/me`, then refresh + logout. Refresh is the fiddly one and
  benefits from having a real session to rotate.
- Client interceptor last, once a real expiring token exists to test against.

## Risks and edge cases

- **The refresh stampede.** Six parallel queries all 401 at once. Without the
  in-flight dedupe in step 3 above, five of them present the same refresh token, the
  server treats it as reuse, and the user is logged out mid-session. This is the most
  likely bug in this module and the client dedupe is not optional.
- **Cross-origin cookies on free tiers.** `sameSite=none; secure` requires HTTPS on
  both sides. Works on Vercel and Render, but breaks on `http://localhost` unless the
  cookie config is environment-aware (`sameSite=lax`, `secure=false` locally). Get
  this wrong and login works locally but silently fails deployed.
- **Clock skew on refresh.** Access TTL of 15 minutes with a 30 second `clockTolerance`
  on verify, so a mildly wrong server clock does not reject fresh tokens.
- **Vendor registration is two writes.** `User` and `VendorProfile` must be created in
  one transaction, or a crash between them leaves a vendor who can sign in with no
  profile and therefore no status page.
- **Argon2 on a cold Render instance.** First login after a cold start pays module
  load plus hashing. Acceptable, but do not set memory cost so high that the free
  tier's memory limit is hit under the concurrency script in M6.
- **Seeded passwords must work on the deployed instance.** The seed hashes with the
  same Argon2 params as the running app. If params are read from env and differ
  between seed run and app run, verification still succeeds (params are encoded in the
  hash string) - but assert this with an actual deployed login, per the brief's
  "seeded credentials that do not work against it" deduction.

## Test strategy

- **Permission guard test** is one of the brief's three high-value tests, but it lives
  in [M2](../M2_PERMISSIONS/plan.md). M1 owns the two below.
- Unit: `token.service` rotation. Presenting a revoked token revokes the chain and
  returns 401. Asserts on database state, not just the response.
- Integration (supertest, real database): register -> login -> call protected route ->
  logout -> replay the old refresh token, asserting 401. This single test covers all
  three of the module's DONE WHEN items except the client-side retry.
- Integration: duplicate email returns 409 with code `EMAIL_TAKEN` and no Prisma error
  text in the body.
- Manual against deployed: expire an access token by waiting, then confirm in the
  browser network tab that exactly one refresh call occurs.
