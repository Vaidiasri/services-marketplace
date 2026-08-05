# Data Model

One Postgres database, Prisma schema. Every feature doc references tables by the
names below. Money is always `Int` in minor units. Every timestamp is `DateTime` in
UTC. Nothing stores a float.

## Identity and access

| Table | Columns | Notes |
| --- | --- | --- |
| `User` | id, email (unique), passwordHash, fullName, roleId, isActive, createdAt | One role per user. Permissions come from the role, never from the user row. |
| `Role` | id, slug (unique), name, isSystem, createdAt | Roles are **data**, not an enum. `isSystem` protects the four seeded roles from deletion. |
| `Permission` | id, slug (unique), resource, action, description | Slug shape `resource.action`. Full catalogue in [02_PERMISSION_CATALOGUE.md](02_PERMISSION_CATALOGUE.md). |
| `RolePermission` | roleId, permissionId | Composite primary key. The join that makes permissions revocable without a redeploy. |
| `RefreshToken` | id, userId, tokenHash, expiresAt, revokedAt, replacedByTokenId, createdAt | Hash stored, never the token. Rotation chain via `replacedByTokenId`. |
| `PasswordResetToken` | id, userId, tokenHash, expiresAt, usedAt | STRETCH. Single-use. |

`User.roleId -> Role`, `Role` many-to-many `Permission` through `RolePermission`.

## Vendors

| Table | Columns | Notes |
| --- | --- | --- |
| `VendorProfile` | id, userId (unique), businessName, contactName, contactPhone, addressLine1, addressLine2, city, state, postalCode, timezone, status, rejectionReason, reviewedByUserId, reviewedAt, createdAt | `status` enum `PENDING \| APPROVED \| REJECTED`. `timezone` is an IANA string and is the authority for all slot maths on this vendor's services. |
| `VendorDocument` | id, vendorProfileId, kind, originalFilename, storedFilename, mimeType, sizeBytes, createdAt | Local disk storage. Only the filename is in the database. |

## Catalogue

| Table | Columns | Notes |
| --- | --- | --- |
| `Category` | id, name, slug (unique), parentId, isActive, sortOrder | Self-relation. Two levels enforced in the service layer: a category whose `parentId` is set cannot itself be a parent. |
| `Service` | id, vendorProfileId, categoryId, title, description, status, suspensionReason, slotGranularityMinutes, freeCancellationHours, cancellationFeePercent, createdAt, updatedAt | `status` enum `DRAFT \| PUBLISHED \| SUSPENDED`. Cancellation policy lives per service, as the brief requires. |
| `ServiceImage` | id, serviceId, storedFilename, sortOrder | Filenames only. |
| `Offering` | id, serviceId, name, durationMinutes, priceMinor, currency, isActive | `durationMinutes` drives slot length. `priceMinor` is the source of truth for booking price - never the request body. |

## Availability

| Table | Columns | Notes |
| --- | --- | --- |
| `AvailabilityRule` | id, serviceId, weekday, startMinute, endMinute, capacity | `weekday` 0-6. `startMinute`/`endMinute` are minutes from local midnight in the vendor's timezone. Multiple rows per weekday give multiple windows. |
| `AvailabilityException` | id, serviceId, date, type, startMinute, endMinute, capacity, reason | `type` enum `CLOSURE \| OPEN_WINDOW`. A `CLOSURE` removes the whole local date. An `OPEN_WINDOW` adds a window on a normally-closed day. Deleting the row restores normal hours. |
| `SlotCell` | id, serviceId, startUtc, capacity, bookedCount | **Unique on (serviceId, startUtc).** Materialised counter, created lazily on first booking attempt. This is a consumption ledger, not a slot table - see the note below. |

### Why `SlotCell` does not violate "slots must be derived"

The brief rejects hand-entered slot rows. Bookable slots here are still computed on
every read from `AvailabilityRule` minus `AvailabilityException` minus consumption.
`SlotCell` never creates availability; it only records how much of a derived slot has
been consumed, and it exists so the capacity check can take a real row lock. No row
in `SlotCell` makes a slot appear, and deleting every row in it changes no slot's
existence - only its remaining capacity. Full argument in
[M5's plan](features/M5_AVAILABILITY_SLOTS/plan.md).

## Bookings

| Table | Columns | Notes |
| --- | --- | --- |
| `Booking` | id, reference (unique), serviceId, offeringId, customerUserId, vendorProfileId, startUtc, endUtc, status, priceMinor, currency, paymentMode, cancellationFeeMinor, cancelReason, createdAt, updatedAt | `status` enum `PENDING \| CONFIRMED \| COMPLETED \| REJECTED \| CANCELLED \| NO_SHOW`. `priceMinor` is the price **at time of booking**, copied from `Offering`. `vendorProfileId` is denormalised so ownership checks and admin filters need no join. |
| `BookingStatusHistory` | id, bookingId, fromStatus, toStatus, actorUserId, actorRoleSlug, reason, createdAt | Written inside the same transaction as every status change. Drives the timeline on the booking detail page. |
| `BookingSlotCell` | bookingId, slotCellId | Composite key. Records which grid cells a booking consumed, so reschedule and cancel can release exactly those cells. |

## Payments

| Table | Columns | Notes |
| --- | --- | --- |
| `Payment` | id, bookingId, amountMinor, currency, status, mode, provider, providerRef, failureReason, createdAt, updatedAt | `status` enum `INITIATED \| SUCCESS \| FAILED \| REFUNDED`. `provider` is `"mock"`. `providerRef` is the mock's reference. |
| `LedgerEntry` | id, bookingId, paymentId, type, amountMinor, currency, createdAt | `type` enum `CHARGE \| REFUND \| CASH_COLLECTED \| CANCELLATION_FEE`. Append-only; nothing is ever updated. |
| `IdempotencyKey` | id, userId, key, scope, requestHash, responseStatus, responseBody, createdAt | **Unique on (userId, scope, key).** Replay returns the stored response. Same key with a different `requestHash` is a 409. |
| `WebhookEvent` | id, eventId (unique), type, payload, processedAt | Dedupe table. A second delivery of the same `eventId` is acknowledged and ignored. |
| `AuditLog` | id, actorUserId, action, targetType, targetId, metadata, createdAt | STRETCH. |

## Relations at a glance

```
User 1--1 VendorProfile 1--* VendorDocument
User *--1 Role *--* Permission          (via RolePermission)
Category 1--* Category                  (parentId, max depth 2)
Category 1--* Service *--1 VendorProfile
Service 1--* Offering
Service 1--* ServiceImage
Service 1--* AvailabilityRule
Service 1--* AvailabilityException
Service 1--* SlotCell
Booking *--1 Service, *--1 Offering, *--1 User (customer), *--1 VendorProfile
Booking 1--* BookingStatusHistory
Booking *--* SlotCell                   (via BookingSlotCell)
Booking 1--* Payment 1--* LedgerEntry
```

## Indexes that matter

Not decoration - each one backs a query the brief explicitly grades.

- `Service (status, categoryId)` and a trigram or `to_tsvector` index on
  `Service.title` - the paginated public catalogue search.
- `Booking (vendorProfileId, status, startUtc)` - vendor booking list.
- `Booking (customerUserId, startUtc)` - customer's own bookings.
- `Booking (startUtc, status)` - admin cross-vendor date-range filter and the
  "bookings today" dashboard count.
- `SlotCell (serviceId, startUtc)` unique - the lock target for the capacity race.
- `AvailabilityRule (serviceId, weekday)` and `AvailabilityException (serviceId, date)`
  - slot generation reads both per request.
