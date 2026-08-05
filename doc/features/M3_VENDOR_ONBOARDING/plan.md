# M3 - Vendor Onboarding (Plan)

Brief module 03. Contributes to Data & API design (15 marks) and supplies the third
enforcement gate that the Permissions area is graded on.

## Key decisions

- **Vendor status is a third gate, orthogonal to permission and ownership.** Implemented
  as `@RequireApprovedVendor()` - a separate guard, not a condition buried in a service
  method, so it is visible on the route and testable by enumeration like the permission
  decorator.
- **The profile is created at registration, not later.** `POST /auth/register/vendor`
  writes `User` + `VendorProfile` in one transaction. A vendor with no profile is an
  unrepresentable state, so no code needs to handle it.
- **Documents on local disk via Multer, filename in the database.** The brief explicitly
  permits this. Render's filesystem is ephemeral, which matters - see Risks.
- **Timezone is collected at registration and lives on the vendor profile.** It is the
  authority for all slot maths on all of that vendor's services
  ([M5](../M5_AVAILABILITY_SLOTS/plan.md)). Collecting it later means services can exist
  before their timezone does.
- **Rejection is not terminal in the data model.** `REJECTED` -> `PENDING` is allowed
  when the vendor resubmits, so a rejected vendor with a fixable problem is not a dead
  account. `APPROVED` -> `REJECTED` (revocation) is admin-only and also allowed.
- **Approval visible without re-login is a consequence of M1's design**, not extra work:
  status is never in the token, so `GET /me` reflects it immediately.

## API contract

| Method | Endpoint | Requires | Notes |
| --- | --- | --- | --- |
| GET | `/vendors/me` | `vendor.read` + own | Profile, status, `rejectionReason`, documents |
| PATCH | `/vendors/me` | `vendor.update` + own | Editable while `PENDING` or `REJECTED`. Editing while `REJECTED` resets status to `PENDING` and clears the reason |
| POST | `/vendors/me/documents` | `vendor.update` + own | `multipart/form-data`, field `file`, plus `kind` |
| DELETE | `/vendors/me/documents/:id` | `vendor.update` + own | Only while not `APPROVED` |
| GET | `/vendors/me/documents/:id/download` | `vendor.read` + own | Streams from disk |
| GET | `/admin/vendors` | `vendor.read_all` | Paginated, `?status=PENDING`, `?q=` on business name |
| GET | `/admin/vendors/:id` | `vendor.read_all` | Full profile + document list |
| GET | `/admin/vendors/:id/documents/:docId/download` | `vendor.read_all` | Streams from disk |
| PATCH | `/admin/vendors/:id/approve` | `vendor.approve` | No body |
| PATCH | `/admin/vendors/:id/reject` | `vendor.reject` | `{ reason }` - required, min 10 chars |

`GET /me` gains `vendorProfile: { id, status, rejectionReason }` for vendor callers,
which is what the client's routing switches on.

## Impact map

- `server/prisma/schema.prisma` - `VendorProfile`, `VendorDocument`, `VendorStatus` enum - add
- `server/src/vendors/vendors.module.ts` - add
- `server/src/vendors/vendors.controller.ts` - the five `/vendors/me` routes - add
- `server/src/vendors/admin-vendors.controller.ts` - the five `/admin/vendors` routes - add
- `server/src/vendors/vendors.service.ts` - `getOwnProfile`, `updateOwnProfile`,
  `attachDocument`, `removeDocument`, `listForAdmin`, `approve`, `reject` - add
- `server/src/vendors/guards/approved-vendor.guard.ts` - `canActivate` - add - loads the
  caller's profile status; the third gate
- `server/src/vendors/require-approved-vendor.decorator.ts` - add
- `server/src/vendors/upload.config.ts` - Multer storage, 5 MB limit, MIME allowlist,
  randomised stored filename - add
- `server/src/auth/auth.service.ts` - `registerVendor` - modify - wrap both writes in one
  transaction and return the profile
- `server/src/auth/auth.service.ts` - `me` - modify - include `vendorProfile`
- `client/src/routes/vendor/PendingStatus.tsx` - add - the only screen a pending vendor gets
- `client/src/routes/vendor/_layout.tsx` - add - branches on `vendorProfile.status`
- `client/src/routes/admin/VendorApplications.tsx` - add - queue, detail drawer, approve/reject

## Algorithms

### The approved-vendor gate

1. Route carries `@RequireApprovedVendor()`. Absent -> guard does not run.
2. Caller's role is `SUPER_ADMIN` -> allow. (An admin acting on a vendor's behalf is
   not blocked by the vendor's own status.)
3. Caller has no `VendorProfile` -> 403 `NOT_A_VENDOR`.
4. Status `PENDING` -> 403 `VENDOR_PENDING_APPROVAL`. Status `REJECTED` -> 403
   `VENDOR_REJECTED`, with the reason in `details` so the client can show it inline.
5. `APPROVED` -> allow.

Applied to: service create/update/publish, offering write routes, availability write
routes, and every vendor booking action. **Not** applied to `/vendors/me` or `/me` -
those are how a pending vendor learns their status, so gating them would trap the vendor
on a broken screen.

### Approve

One transaction: set `status = APPROVED`, null `rejectionReason`, stamp
`reviewedByUserId` and `reviewedAt`. Nothing cascades - the vendor has no services yet
in the normal flow, and if they drafted some while pending, those stay `DRAFT` until
they publish them.

### Reject

One transaction: set `status = REJECTED` and store the reason. Any `PUBLISHED` services
belonging to the vendor are moved to `SUSPENDED` with the same reason - this only
matters for the revoke-an-approved-vendor path, but leaving live services published
under a rejected vendor would break the M4 invariant that the public catalogue only
shows approved vendors' services.

## Error handling

| Operation | Failure | Behaviour |
| --- | --- | --- |
| Register vendor | Second write fails | Transaction rolls back, 500 with `requestId`, no orphan `User` |
| Upload | File over 5 MB | 413 `FILE_TOO_LARGE` |
| Upload | Disallowed MIME | 422 `UNSUPPORTED_FILE_TYPE`. Allowlist: `application/pdf`, `image/png`, `image/jpeg`. Checked against the sniffed magic bytes, not the client-supplied `Content-Type` |
| Upload | Disk write fails | 500, and no `VendorDocument` row - the row is inserted only after the write resolves |
| Download | Row exists, file missing from disk | 410 `FILE_GONE`, not 500. Expected on Render after a redeploy; see Risks |
| Approve | Already `APPROVED` | 200, idempotent. Re-approving is not an error |
| Reject | Missing or short reason | 422. The brief requires the reason, so it is not optional |
| Reject | Already `REJECTED` | 200, updates the reason |
| Approve/reject | Target has no vendor profile | 404 |
| `PATCH /vendors/me` | Status is `APPROVED` | 409 `PROFILE_LOCKED`. Approved vendors change business details through an admin, so approval cannot be laundered by editing the profile afterwards |
| Any vendor write route | Vendor pending | 403 `VENDOR_PENDING_APPROVAL` |

## Security

| Threat | Mitigation |
| --- | --- |
| **Self-approval.** A vendor calls the approve endpoint on their own id. | `vendor.approve` is not in the `VENDOR` role. The permission gate refuses before the vendor-status gate is even consulted. Covered by an integration test. |
| Publishing while pending | The third gate, on the route. Tested by curl with a real pending vendor's token - the brief's DONE WHEN. |
| Path traversal on upload | Stored filename is a generated UUID plus a validated extension. The client's filename is stored in `originalFilename` for display and is never used to build a path. |
| Cross-vendor document read | Download routes go through `assertOwnership` with `notFoundOnMismatch` - Vendor A gets 404 for Vendor B's document id. |
| Unauthenticated document read | Documents are streamed through an authenticated route, never served from a static directory. `UPLOAD_DIR` is outside any static mount. |
| Malicious file executed | Files are never executed or interpreted; served with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. |
| Approved-vendor status cached in a token | Status is never in a token. |

## Implementation order

- Schema + the `PENDING` write inside `registerVendor`, and confirm a fresh vendor
  registration lands with a profile.
- `GET /vendors/me` and the client status screen - the vendor's only surface.
- `approved-vendor.guard`, applied to one placeholder write route, and prove the 403 by
  curl before M4 exists to attach it to properly.
- Admin queue: list, detail, approve, reject.
- Uploads last. They are the fiddliest and the least graded part of the module.

## Risks and edge cases

- **Render's filesystem is ephemeral.** Every redeploy wipes uploaded documents, so
  seeded vendors' documents vanish and downloads 410. Mitigations, in order of
  preference: (a) the seed writes its sample documents to disk on every run, and the
  Render start command runs the seed, so seeded documents always exist; (b) the 410 is
  handled gracefully in the UI as "file no longer available"; (c) mention it in
  DECISIONS.md as the known trade-off of not using object storage. Do all three. A 500
  on a reviewer's document click reads as a defect.
- **A vendor who drafts services while pending, then gets rejected.** Handled by the
  reject cascade, but the drafts survive - which is correct, they were never public.
- **Approve then revoke.** `APPROVED` -> `REJECTED` suspends live services but must not
  touch `CONFIRMED` bookings, mirroring the service-suspension rule in M4. Existing
  bookings survive; new ones stop.
- **The gate on booking actions.** A vendor who is approved, takes bookings, then gets
  revoked cannot confirm or complete them - which strands customers. Decision: booking
  *fulfilment* routes (`complete`, `no_show`) stay open to a revoked vendor so existing
  obligations can be closed out; `confirm` is blocked. Documented in DECISIONS.md
  because it is a judgement call, not an obvious rule.
- **Timezone validation.** An invalid IANA string breaks slot generation for every one
  of that vendor's services, silently, later. Validated at registration against
  `Intl.supportedValuesOf('timeZone')` and rejected at the boundary.

## Test strategy

- Integration: pending vendor's token on `POST /services/:id/publish` -> 403
  `VENDOR_PENDING_APPROVAL`. This is a DONE WHEN item and belongs in the committed suite.
- Integration: approve, then re-fetch `/me` with the **same** access token -> status is
  `APPROVED`. Proves no logout is required, the other DONE WHEN item.
- Integration: vendor calls `PATCH /admin/vendors/:ownId/approve` -> 403.
- Integration: reject with a 4-character reason -> 422; with a valid reason -> the
  vendor's `GET /vendors/me` returns that exact string.
- Unit: the approved-vendor guard's five branches.
