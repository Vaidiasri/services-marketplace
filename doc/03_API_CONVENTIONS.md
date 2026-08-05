# API Conventions

The brief's "Applies to everything" section, made concrete. These rules are global;
feature docs only note where they deviate.

## Error envelope

One shape for every non-2xx response, from a single Nest exception filter. No route
hand-rolls an error body.

```ts
type ApiError = {
  error: { code: string; message: string; details?: unknown; requestId: string }
}
```

- `code` is a stable machine string (`EMAIL_TAKEN`, `SLOT_FULL`,
  `ILLEGAL_TRANSITION`, `FORBIDDEN`, `VALIDATION_FAILED`). The client switches on
  this, never on `message`.
- `details` carries the field-level validation issues on a 422 and is absent otherwise.
- `requestId` is generated per request and logged, so a reviewer can quote it.

### Status codes actually used

| Code | When |
| --- | --- |
| 400 | Malformed request that is not a schema failure (bad JSON, bad UUID in a path) |
| 401 | Missing, malformed, or expired access token |
| 403 | Authenticated but the permission gate or ownership gate refused |
| 404 | Not found, or hidden-by-ownership where existence itself is confidential |
| 409 | Conflict: email already used, slot capacity exhausted, idempotency key reuse with a different body |
| 422 | Schema validation failure, and illegal state-machine transitions |

The brief calls out `500 for a validation failure is a fail`. The filter maps
`ZodError` to 422 and anything unrecognised to 500 with the message replaced by a
generic string - the real error goes to the log with the `requestId`, never to the client.

### 403 vs 404 on ownership

The brief accepts either for cross-vendor access. The rule here:

- **403** when the resource is public-shaped and its existence is not a secret
  (a service, a category).
- **404** when leaking existence is itself a leak (another vendor's booking, another
  customer's booking, a `DRAFT` service to a signed-out visitor).

## Validation at the boundary

Zod schemas, one per DTO, applied by a global validation pipe. Nothing reaches a
service method unvalidated.

- **Strip, do not ignore, unknown keys.** Every schema is `.strict()`, so a body
  carrying `role`, `roleId`, `permissions`, `status`, `priceMinor`, or `vendorProfileId`
  is rejected outright rather than silently dropped. This is the direct answer to the
  deduction "prices, discounts or roles trusted from the request body."
- **Server-derived fields are never in a DTO.** Price comes from the `Offering` row,
  vendor id from the authenticated user's profile, booking status from the state
  machine, payment amount from the booking.
- Path params and query strings are validated by the same pipe, not just bodies.

## Money

- Every monetary column and every API field is an integer in **minor units**
  (paise). `priceMinor: 340000` is the brief's "3400" haircut.
- Field names always end in `Minor` so a float can never sneak in unnoticed.
- Currency is a sibling `currency` field, `"INR"` throughout. No implicit currency.
- Formatting to `3,400.00` happens only in the client, once, in a shared helper.

## Time and timezones

- Every stored timestamp is UTC (`timestamptz`).
- Every API timestamp is a UTC ISO-8601 string with `Z`.
- The **vendor's** IANA timezone (`VendorProfile.timezone`) is the authority for slot
  maths. Availability rules are local weekday plus local minutes; conversion to UTC
  instants happens on the server during slot generation.
- "Slots in the past are never offered" is evaluated against server `now` compared to
  the slot's UTC instant. The browser's clock and the browser's timezone are never
  inputs to a decision.
- Slot responses carry both the UTC instant and the vendor's timezone label, so the
  client can render "6:00 PM IST" to a customer sitting in another zone. Full
  reasoning in [M5's plan](features/M5_AVAILABILITY_SLOTS/plan.md).

## Pagination, search, filter

All list endpoints share one query contract, and all of it is applied in SQL. The
brief: "Fetching every row and filtering in the client does not satisfy this requirement."

| Param | Meaning |
| --- | --- |
| `page` | 1-based, default 1 |
| `pageSize` | default 20, max 100 |
| `sort` | `field:asc` / `field:desc`, allowlisted per endpoint |
| `q` | full-text search, per-endpoint fields |
| plus per-endpoint filters | `status`, `categoryId`, `vendorId`, `from`, `to` |

Response shape, identical everywhere:

```ts
type Paginated<T> = {
  data: T[]
  meta: { page: number; pageSize: number; total: number; totalPages: number }
}
```

`total` comes from a `COUNT` over the same `WHERE` clause, in the same transaction as
the page query, so page 2 of a filtered search cannot disagree with its own count.

## Idempotency

Applies to `POST /bookings` and `POST /payments/:id/confirm`.

- Client sends `Idempotency-Key: <uuid>`. Required on those two routes, ignored
  elsewhere.
- The server hashes the request body and stores `(userId, scope, key) -> response`.
- Same key, same body hash -> the stored status and body are replayed. No second
  booking, no second payment.
- Same key, **different** body hash -> 409 `IDEMPOTENCY_KEY_REUSED`.
- The record is written inside the same transaction as the effect, so a crash cannot
  leave a key recorded without its booking, or a booking without its key.

## Auth headers

- `Authorization: Bearer <accessToken>`, 15 minute lifetime.
- Refresh token in an `httpOnly`, `secure`, `sameSite=none` cookie (the client is on
  a different origin from the API), 7 day lifetime, rotated on every refresh.

## Secrets

No `.env` in the repository. `.env.example` lists every variable with a placeholder:
`DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ACCESS_TOKEN_TTL`,
`REFRESH_TOKEN_TTL`, `UPLOAD_DIR`, `CLIENT_ORIGIN`, `SEED_DEFAULT_PASSWORD`.
