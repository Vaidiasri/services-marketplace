# M4 - Service Catalogue (Plan)

Brief module 04. Data & API design rubric area (15 marks) - this is where server-side
pagination and filtering are graded.

## Key decisions

- **Two-level nesting enforced in the service layer, not the schema.** `Category.parentId`
  is a plain self-relation; the rule "a category with a `parentId` cannot be a parent" is
  a validation check. A schema-level depth constraint would need a trigger for no gain.
- **The public-visibility rule lives in one place.** A single
  `publicServiceWhere()` builder returns the Prisma predicate
  `{ status: 'PUBLISHED', vendorProfile: { status: 'APPROVED' } }`, and every public read
  path composes it. Duplicating that condition across list, detail, slots, and booking
  creation is how one of them ends up wrong.
- **Search via Postgres `tsvector`, not `ILIKE '%q%'`.** A generated `searchVector`
  column over title and description with a GIN index. `ILIKE` with a leading wildcard
  cannot use an index and the brief grades server-side search; showing a real index is
  cheap here. Fallback if Neon's extension set causes trouble: `pg_trgm`. Either is fine,
  but pick one at Phase 1 so the migration lands with the schema.
- **Count in the same transaction as the page.** `$transaction([findMany, count])` with the
  identical `where`, so `total` cannot disagree with the rows.
- **Keyset pagination is not used.** Offset pagination is what the brief asks for
  ("page 2 ... and a total count"), and the dataset is seed-sized. Noted in DECISIONS.md
  as a known scale limit rather than pretended away.
- **Images are filenames, no processing.** The brief permits it. Same upload plumbing as
  [M3](../M3_VENDOR_ONBOARDING/plan.md), reused, not rewritten.
- **Service suspension is STRETCH in the brief but planned in full** - it is cheap once
  the status enum and the visibility builder exist, and it is the one stretch item likely
  to be kept.

## API contract

### Categories

| Method | Endpoint | Requires | Notes |
| --- | --- | --- | --- |
| GET | `/categories` | public | Tree, `?flat=true` for a flat list. Cached client-side, rarely changes |
| POST | `/categories` | `category.create` | `{ name, parentId?, sortOrder? }`. Slug generated server-side |
| PATCH | `/categories/:id` | `category.update` | `{ name?, isActive?, sortOrder? }`. `parentId` is **not** editable - moving a subtree is not worth the depth revalidation |
| DELETE | `/categories/:id` | `category.delete` | 409 if it has children or services |

### Services

| Method | Endpoint | Requires | Notes |
| --- | --- | --- | --- |
| GET | `/services` | public | The public catalogue. `page`, `pageSize`, `q`, `categoryId`, `minPriceMinor`, `maxPriceMinor`, `sort`. Only published + approved |
| GET | `/services/:id` | public | 404 unless published + approved, **or** the caller owns it, **or** the caller holds `service.read_all` |
| GET | `/vendors/me/services` | `service.read` + own + approved vendor | The vendor's own list, all statuses, `?status=` filter |
| POST | `/services` | `service.create` + approved vendor | `{ title, description, categoryId, slotGranularityMinutes?, freeCancellationHours, cancellationFeePercent }`. Created as `DRAFT` |
| PATCH | `/services/:id` | `service.update` + own + approved vendor | Same fields. `status` is **not** accepted here |
| POST | `/services/:id/publish` | `service.publish` + own + approved vendor | 422 unless at least one active offering and at least one availability rule exist |
| POST | `/services/:id/unpublish` | `service.publish` + own | Back to `DRAFT`. Refused if future non-terminal bookings exist |
| DELETE | `/services/:id` | `service.delete` + own | Soft-blocked: 409 if any booking references it. Otherwise hard delete |
| POST | `/admin/services/:id/suspend` | `service.suspend` | `{ reason }` required. **STRETCH** |
| POST | `/admin/services/:id/unsuspend` | `service.suspend` | Returns it to `PUBLISHED`. **STRETCH** |
| GET | `/admin/services` | `service.read_all` | Cross-vendor, all statuses, `?vendorId=`, `?status=` |
| POST | `/services/:id/images` | `service.update` + own | multipart, reuses M3's upload config |

### Offerings

| Method | Endpoint | Requires | Notes |
| --- | --- | --- | --- |
| GET | `/services/:id/offerings` | public if service public | Active only for public callers; all for the owner |
| POST | `/services/:id/offerings` | `offering.create` + own + approved | `{ name, durationMinutes, priceMinor, currency }` |
| PATCH | `/offerings/:id` | `offering.update` + own + approved | `{ name?, durationMinutes?, priceMinor?, isActive? }` |
| DELETE | `/offerings/:id` | `offering.delete` + own | 409 if bookings reference it; deactivate instead |

## Impact map

- `server/prisma/schema.prisma` - `Category`, `Service`, `ServiceImage`, `Offering`,
  `ServiceStatus` enum, `searchVector` + GIN index - add
- `server/prisma/migrations/*_service_search` - raw SQL for the generated column and
  index - add - Prisma cannot express a generated `tsvector`, so this is hand-written
  inside a normal migration
- `server/src/catalog/catalog.module.ts` - add
- `server/src/catalog/categories.controller.ts` / `categories.service.ts` - add -
  `assertDepthLimit` is the only non-CRUD logic
- `server/src/catalog/services.controller.ts` - public routes - add
- `server/src/catalog/vendor-services.controller.ts` - owner routes - add
- `server/src/catalog/admin-services.controller.ts` - suspend/unsuspend/list-all - add
- `server/src/catalog/services.service.ts` - `listPublic`, `getOneVisibleTo`, `create`,
  `update`, `publish`, `unpublish`, `suspend`, `unsuspend` - add
- `server/src/catalog/offerings.controller.ts` / `offerings.service.ts` - add
- `server/src/catalog/public-service-where.ts` - `publicServiceWhere()` - add - **the**
  single source of the visibility rule
- `server/src/common/pagination.ts` - `parsePageQuery`, `paginate` - add - shared by every
  list endpoint in M4, M6, M8
- `client/src/routes/public/Catalogue.tsx` - list, search, filters, pager - add
- `client/src/routes/public/ServiceDetail.tsx` - add
- `client/src/routes/vendor/Services.tsx` + `ServiceEditor.tsx` + `Offerings.tsx` - add
- `client/src/routes/admin/Categories.tsx` - add

## Algorithms

### Public list query

1. Parse and clamp `page`/`pageSize` (max 100), validate `sort` against an allowlist of
   `createdAt`, `title`, `minPrice`.
2. Compose `where` from `publicServiceWhere()` plus optional `categoryId` (matching the
   category **or any of its children**, so filtering by `Beauty` includes `Salon`), plus
   optional price range applied against the service's active offerings.
3. If `q` is present, add `searchVector @@ websearch_to_tsquery('english', q)`.
4. Run `findMany` + `count` in one `$transaction` with the identical `where`.
5. Return the shared `Paginated<T>` envelope.

### Publish preconditions

Publishing is refused with 422 unless: the vendor is `APPROVED`, the service has at
least one `isActive` offering, and the service has at least one `AvailabilityRule`. A
published service with no bookable slots is a dead end for customers and an obvious
defect in a demo, so the API prevents creating one.

### Suspend

One transaction: set `status = SUSPENDED` and `suspensionReason`. Deliberately touches
**no** bookings. New bookings stop because booking creation calls `publicServiceWhere()`
and the slots endpoint does the same. Existing `CONFIRMED` bookings keep working because
the vendor's fulfilment routes key off the booking, not the service status.

## Error handling

| Operation | Failure | Behaviour |
| --- | --- | --- |
| `GET /services/:id` | Draft/suspended, caller not owner or admin | 404 `NOT_FOUND` - never 403, because existence of an unpublished service is itself private. The brief's DONE WHEN |
| `GET /services/:id` | Vendor not approved | 404, same reason |
| `POST /categories` | Parent already has a parent | 422 `CATEGORY_DEPTH_EXCEEDED` |
| `POST /categories` | Name collides at the same level | 409 `CATEGORY_EXISTS` |
| `DELETE /categories/:id` | Has children or services | 409 `CATEGORY_IN_USE` with the counts |
| `POST /services` | `categoryId` unknown or inactive | 422 |
| `POST /services/:id/publish` | No active offering | 422 `NO_ACTIVE_OFFERING` |
| `POST /services/:id/publish` | No availability rule | 422 `NO_AVAILABILITY` |
| `POST /services/:id/publish` | Vendor not approved | 403 `VENDOR_PENDING_APPROVAL` |
| `PATCH /services/:id` | Body contains `status` | 422 - status changes go through dedicated routes only |
| `PATCH /offerings/:id` | `durationMinutes` not a multiple of the service's `slotGranularityMinutes` | 422 `DURATION_NOT_ALIGNED`. See M5 for why |
| `PATCH /offerings/:id` | Price changed while future bookings exist | 200, allowed. Existing bookings hold their snapshotted `priceMinor` and are unaffected |
| `DELETE /offerings/:id` | Referenced by a booking | 409 `OFFERING_IN_USE`, suggesting `isActive: false` |
| `POST /admin/services/:id/suspend` | Missing reason | 422 |
| Search | `q` is malformed tsquery input | Sanitised by `websearch_to_tsquery`, which never throws on user text. No 500 path |
| Any list | `pageSize` over 100 | Clamped to 100, not an error |

## Security

| Threat | Mitigation |
| --- | --- |
| **Price trusted from the client.** | `priceMinor` is only ever written on `Offering` by its owning vendor. Booking creation reads it from the row; the booking DTO has no price field at all. This is the direct answer to the "prices trusted from the request body" deduction. |
| Vendor publishes into another vendor's service | Ownership gate via `assertOwnership` on every `:id` route. |
| Vendor sets their own `status` to `PUBLISHED` via PATCH | `status` is not a field on the update DTO and DTOs are `.strict()`, so it is a 422. |
| Draft leak via the list endpoint | The list composes `publicServiceWhere()` unconditionally; the owner list is a separate controller with its own route and guard. |
| Draft leak via search | Same builder, so `q` cannot surface a draft. Asserted by a test that indexes a draft and searches its exact title. |
| Category injection into another vendor's tree | Categories are admin-owned; vendors only reference them. |
| Enumeration of service ids | 404s are uniform for missing and hidden, so ids reveal nothing. |

## Implementation order

- Categories first, with the depth check. Services need a category to point at.
- `publicServiceWhere()` and `common/pagination.ts` before the first list route.
- Service CRUD as `DRAFT`, then offerings, then publish with its preconditions - publish
  cannot be written before the things it checks exist.
- The search migration (generated column + GIN) as its own migration, verified with a
  raw query before the endpoint uses it.
- Suspend/unsuspend last, as STRETCH.
- Client catalogue after the list endpoint returns real paginated data.

## Risks and edge cases

- **The generated `tsvector` column is hand-written SQL inside a Prisma migration.**
  `prisma migrate dev` will want to drift-correct it if the schema and database disagree.
  The column must be declared in `schema.prisma` as `Unsupported("tsvector")` with
  `@@index(type: Gin)` so Prisma knows about it. Get this wrong and `migrate reset` on a
  cold clone fails - which the brief scores as a README failure.
- **Category filter including children** needs the child ids resolved first. With two
  levels that is one extra query, not recursion. If a filter by a leaf category is
  requested, no expansion happens.
- **Price-range filtering across offerings** means a service matches if *any* active
  offering falls in range, which requires a `some` relation filter. Sorting by price then
  needs a subquery for the minimum - the allowlisted `minPrice` sort. Keep the sort
  allowlist short for this reason.
- **`slotGranularityMinutes` versus offering durations.** If a service is 15-minute
  granularity and an offering is 50 minutes, the slot grid cannot represent it cleanly.
  The alignment check on offering write prevents the bad state at the boundary rather
  than producing wrong slots later. Changing a service's granularity while misaligned
  offerings exist is refused with 422 and the list of offending offerings.
- **Unpublish with live bookings.** Refused if any non-terminal booking has a future
  `startUtc`, because the customer's appointment would silently stop resolving. Suspend
  by an admin is the deliberate exception, and it keeps bookings intact.
- **Suspension must not be reachable by a vendor.** `service.suspend` is only in the
  admin roles, and there is no vendor route for it.

## Test strategy

- Integration: signed-out `GET /services/:draftId` -> 404, and the same id as its owner
  -> 200. Both DONE WHEN items in one test.
- Integration: seed 25 published services, filter by category and `q`, request page 2 with
  `pageSize=10`, assert the exact ids and `meta.total`. The brief's pagination DONE WHEN.
- Integration: publish with no offering -> 422; add an offering and a rule, publish -> 200.
- Integration: suspend a service that has a `CONFIRMED` booking; assert the booking is
  still `CONFIRMED` and readable, the service is absent from `GET /services`, and a new
  booking attempt on it returns 404.
- Unit: `publicServiceWhere()` composition, and the category-depth check.
