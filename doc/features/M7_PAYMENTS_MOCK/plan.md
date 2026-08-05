# M7 - Payments, Mocked (Plan)

Brief module 07. Payment flow rubric area (15 marks). The brief forbids any real or
sandbox gateway - what is graded is structure, idempotency, and failure handling.

## Key decisions

- **A `PaymentProvider` port with a `MockPaymentProvider` adapter.** The interface is
  narrow on purpose - four methods - and no service imports the mock directly; it is
  injected by token. Answers the walkthrough question "what changes when the mock is
  replaced with a real one": one adapter class and one provider registration. Nothing else.
- **The provider is stateless.** All state lives in `Payment`, `LedgerEntry`, and
  `WebhookEvent`. The mock returns a decision; the service records it. A stateful mock
  would be the thing that does not survive replacement.
- **Deterministic tokens, not random failure.** `tok_fail` etc. Randomness cannot be
  demonstrated on request, and the brief requires the outcome to be triggerable.
- **Idempotency lives in shared middleware**, not in the payments service, because
  [M6](../M6_BOOKING_LIFECYCLE/plan.md)'s booking creation needs it too. Written once, in
  `common/idempotency.interceptor.ts`.
- **The idempotency record is written inside the effect's transaction.** A separate write
  can leave a key stored without its payment (a replay then returns success for something
  that never happened) or a payment without its key (a replay charges twice).
- **Webhook dedupe by a unique `eventId` column, not by checking the payment's status.**
  Status-checking looks like it works but races: two simultaneous deliveries both read
  `INITIATED` and both process. A unique index makes the second insert fail, and the
  failure is the dedupe.
- **A failed `PAY_NOW` releases the slot cells in the same transaction as the status
  change.** This is the brief's DONE WHEN and it is why the payments service depends on
  M6's `capacity.repository` rather than reimplementing release.
- **No cron, no timeout job.** `tok_delay` payments stay `INITIATED` until a webhook is
  delivered by hand. A background expiry sweeper is real-system behaviour but nothing in
  the brief asks for it, and a Render free-tier instance sleeps anyway. Noted in
  DECISIONS.md.
- **Money never leaves integer minor units**, including the fee and refund arithmetic.
  `Math.round` applied exactly once, at fee computation in M6.

## The port

```ts
interface PaymentProvider {
  initiate(input: { amountMinor: number; currency: string; token: string;
                    reference: string }): Promise<ProviderResult>
  refund(input: { providerRef: string; amountMinor: number }): Promise<ProviderResult>
  verifyWebhook(rawBody: Buffer, signature: string): boolean
  parseWebhook(rawBody: Buffer): { eventId: string; providerRef: string;
                                   outcome: 'SUCCESS' | 'FAILED' }
}
type ProviderResult = { providerRef: string; outcome: 'SUCCESS' | 'FAILED' | 'PENDING';
                        failureReason?: string }
```

`verifyWebhook` exists in the mock as an HMAC over the raw body using
`MOCK_WEBHOOK_SECRET`. It is not decoration: leaving webhook verification out is the
thing that does not survive a real provider, and implementing it costs four lines.

### Mock token table (goes in the README verbatim)

| Token | `initiate` returns | Notes |
| --- | --- | --- |
| `tok_success` | `SUCCESS` | Default when no token is sent |
| `tok_fail` | `FAILED`, reason `"card_declined"` | Releases the slot |
| `tok_delay` | `PENDING` | Resolve via webhook |
| `tok_refund_fail` | `SUCCESS`, but `refund` returns `FAILED` | Exercises the refund failure path |

## API contract

| Method | Endpoint | Requires | Notes |
| --- | --- | --- | --- |
| POST | `/payments/:id/confirm` | `payment.initiate` + own booking | `Idempotency-Key` required. `{ token }`. Calls the provider and applies the outcome |
| GET | `/payments/:id` | `payment.read` + own | |
| GET | `/bookings/:id/payments` | `payment.read` + own | Payments + ledger + `outstandingMinor` |
| POST | `/payments/webhook` | **public**, HMAC-verified | `{ eventId, providerRef, outcome }` + `X-Mock-Signature`. Manually callable |
| POST | `/payments/:id/refund` | `payment.refund` | Admin-initiated manual refund. Automatic refunds happen inside cancel |
| PATCH | `/bookings/:id/mark-collected` | `payment.mark_collected` + own vendor | `PAY_AFTER` only. Writes a `CASH_COLLECTED` ledger row |

`POST /bookings` with `paymentMode: PAY_NOW` creates the `INITIATED` payment as part of
its transaction, so the client gets a payment id back in the booking response and calls
confirm next. Two steps, mirroring how a real gateway's intent-then-confirm works.

## Impact map

- `server/prisma/schema.prisma` - `Payment`, `LedgerEntry`, `IdempotencyKey`,
  `WebhookEvent`, `PaymentStatus` + `LedgerEntryType` enums - add
- `server/src/payments/payments.module.ts` - add - binds `PAYMENT_PROVIDER` to the mock
- `server/src/payments/provider/payment-provider.port.ts` - add
- `server/src/payments/provider/mock-payment.provider.ts` - add - **the only file that
  knows about tokens**
- `server/src/payments/payments.service.ts` - `confirm`, `refund`, `markCollected`,
  `applyOutcome` - add - `applyOutcome` is shared by confirm and the webhook so both paths
  produce identical state
- `server/src/payments/webhook.controller.ts` - add - raw-body parser for HMAC
- `server/src/payments/ledger.service.ts` - `append(tx, ...)` - add - append-only, takes `tx`
- `server/src/payments/outstanding.ts` - `computeOutstanding(booking, payments, ledger)` - add - pure
- `server/src/common/idempotency.interceptor.ts` - add - shared with M6
- `server/src/bookings/bookings.service.ts` - `create`, `cancel`, `confirm` - modify -
  create inserts the `INITIATED` payment; cancel triggers refund; confirm gates on payment
  status
- `client/src/routes/customer/PaymentStep.tsx` - add - includes a token selector, visible
  in non-production, so a reviewer can trigger failure from the UI
- `client/src/routes/vendor/CollectCash.tsx` - add

## Algorithm - confirm a PAY_NOW payment

1. Idempotency interceptor checks `(userId, 'payment.confirm', key)`. Hit -> replay the
   stored response, return. No provider call.
2. Load the payment and its booking; assert ownership and that the payment is `INITIATED`.
3. **Call the provider outside the transaction.** A network call inside an open
   transaction holds a database connection for the round trip; with a real provider that
   is how connection pools die. The mock is instant, but the structure must be the one
   that survives replacement.
4. Open a transaction and run `applyOutcome`:
   - `SUCCESS` -> payment `SUCCESS`, `CHARGE` ledger row. Booking stays `PENDING` -
     confirmation is the vendor's decision, and now unblocked.
   - `FAILED` -> payment `FAILED` with reason, **release the booking's slot cells** via
     `capacity.repository.releaseCells`, booking -> `CANCELLED` with the reason
     `"payment failed"`, history row written.
   - `PENDING` -> nothing changes. The client polls or waits for a webhook.
5. Store the idempotency record in the same transaction. Commit.

### Why a failed payment cancels the booking rather than leaving it PENDING

Leaving it `PENDING` with released cells means the booking exists but its seat is gone -
so the vendor could confirm a booking with no capacity behind it. Cancelling is the honest
state, and it is what makes "the slot is bookable by someone else" true and consistent.

## Algorithm - webhook

1. Verify HMAC over the **raw** body. Bad signature -> 401, nothing recorded.
2. Parse `{ eventId, providerRef, outcome }`.
3. In one transaction: `INSERT INTO "WebhookEvent" (eventId, ...)`. Unique violation
   (`P2002`) -> **already processed**, commit nothing, return 200. A duplicate delivery is
   a success from the provider's point of view; returning an error makes a real provider
   retry forever.
4. Load the payment by `providerRef`. Not found -> record the event as processed anyway and
   return 200 (an event for an unknown payment must not be retried indefinitely), but log
   it with the `requestId`.
5. Payment already terminal (`SUCCESS`/`FAILED`/`REFUNDED`) -> record and return 200 without
   changing anything. Late webhooks are normal.
6. Otherwise run the same `applyOutcome` as confirm. Commit.

Steps 3 and 6 in one transaction is what makes double delivery genuinely inert: either the
event row and the effect both land, or neither does.

## Algorithm - refund on cancellation

Called from M6's cancel, inside its transaction where possible; the provider call is made
before the transaction opens, same reasoning as confirm.

1. Find the `SUCCESS` payment for the booking. None -> nothing to refund, done.
2. `refundableMinor = priceMinor - cancellationFeeMinor` (M6 computed the fee; force-cancel
   sets it to 0).
3. Call `provider.refund`.
4. `SUCCESS` -> payment `REFUNDED`, `REFUND` ledger row for `refundableMinor`, plus a
   `CANCELLATION_FEE` row for the retained fee if non-zero. The two rows sum to the
   original charge, so the ledger balances.
5. `FAILED` (the `tok_refund_fail` path) -> the booking **stays cancelled**, the payment
   stays `SUCCESS`, and a `REFUND_FAILED` flag plus the reason is recorded. The
   cancellation is not rolled back - the customer's appointment is genuinely gone, and
   reinstating it because a refund failed would be worse. Surfaced to admins as a pending
   manual refund. This is a judgement call and goes in DECISIONS.md.

## Outstanding balance (PAY_AFTER)

`computeOutstanding` is pure: `priceMinor` minus `SUCCESS` charges minus `CASH_COLLECTED`
minus `REFUND`. Returned on booking detail as `outstandingMinor` and rendered as a badge
until it reaches zero. `mark-collected` is refused unless the booking is `COMPLETED` or
`CONFIRMED` and `outstandingMinor > 0`, and is idempotent - a second call with the balance
already zero returns 200 with no new ledger row.

## Error handling

| Operation | Failure | Behaviour |
| --- | --- | --- |
| Confirm | Payment not `INITIATED` | 409 `PAYMENT_NOT_PENDING` |
| Confirm | Booking terminal | 409 `BOOKING_CLOSED`, no provider call |
| Confirm | Missing `Idempotency-Key` | 400 |
| Confirm | Key replayed, same body | 200, stored response. One booking, one payment - the brief's DONE WHEN |
| Confirm | Key replayed, different body | 409 `IDEMPOTENCY_KEY_REUSED` |
| Confirm | Unknown token | 422 `UNKNOWN_PAYMENT_TOKEN`, listing the valid mock tokens |
| Confirm | Provider throws | Payment stays `INITIATED`, 502 `PROVIDER_UNAVAILABLE`. Retryable with the same key |
| Webhook | Bad or missing signature | 401, nothing recorded |
| Webhook | Duplicate `eventId` | 200, no effect - the brief's DONE WHEN |
| Webhook | Unknown `providerRef` | 200, recorded, logged. Never a retry loop |
| Webhook | Payment already terminal | 200, no effect |
| Refund | No `SUCCESS` payment | 200, no-op |
| Refund | Provider refuses | Booking stays cancelled, refund flagged for manual handling, 200 to the caller with `refundStatus: 'FAILED'` |
| Refund | Amount exceeds the original charge | 422 - guards an arithmetic bug rather than trusting the maths |
| Mark collected | `PAY_NOW` booking | 422 `NOT_PAY_AFTER` |
| Mark collected | Balance already zero | 200, idempotent, no new ledger row |
| Mark collected | Booking `PENDING` | 422 |
| Any | A float appears in a money field | Impossible - columns are `Int` and DTOs validate `z.number().int()` |

## Security

| Threat | Mitigation |
| --- | --- |
| **Amount from the client.** | `Payment.amountMinor` is copied from `Booking.priceMinor`, which was copied from `Offering.priceMinor`. No amount field exists on any payment DTO. |
| Forged webhook marking a payment successful | HMAC over the raw body with `MOCK_WEBHOOK_SECRET` from the environment. Unsigned calls are 401. The endpoint being manually callable does not mean it is unauthenticated. |
| Webhook replay | `WebhookEvent.eventId` unique index. |
| Duplicate charge on client retry | Idempotency key, unique per `(userId, scope, key)`. |
| Cross-user payment read | `assertOwnership` through the booking. |
| Refund to the wrong party | Refunds are computed from the booking, never parameterised by a recipient. |
| Real network egress | The mock makes no outbound calls. A test asserts no gateway SDK is in `package.json` and greps the source for provider names - the brief's "nothing talks to a real payment network" DONE WHEN, enforced rather than promised. |
| Secret in the repo | `MOCK_WEBHOOK_SECRET` is in `.env.example` as a placeholder only. |

## Implementation order

- `common/idempotency.interceptor.ts` first - M6's booking creation needs it, and building
  it once is the whole point.
- The port and the mock adapter, with unit tests over the token table. No database involved.
- `Payment` + `LedgerEntry` schema, and the `INITIATED` payment inside M6's create
  transaction.
- `confirm` with `applyOutcome`, including the failure-releases-cells path. Prove the DONE
  WHEN by curl before moving on.
- The webhook, reusing `applyOutcome` - if it needs its own logic, `applyOutcome` was
  factored wrong.
- Refund on cancel, then `mark-collected`.
- Client payment step with the token selector.

## Risks and edge cases

- **The provider call must sit outside the transaction.** Easy to get wrong, invisible
  when the mock is instant, and fatal with a real provider. The structure is the graded
  artefact here, so this is not a premature optimisation.
- **A crash between the provider call and the transaction** leaves a real-world charge with
  no local record. With the mock it is harmless. The honest fix is a pre-recorded intent
  plus reconciliation, which is out of scope - stated in DECISIONS.md as a known gap, since
  the walkthrough asks what changes with a real provider and this is the truthful answer.
- **`tok_delay` bookings hold their slot indefinitely.** No expiry sweeper, so a pending
  payment blocks a seat forever. Accepted and documented; the manual webhook is the release
  mechanism. If time allows, the cheap mitigation is treating `INITIATED` payments older
  than 15 minutes as failed at read time in the slot generator - noted, not planned.
- **Raw body for HMAC versus Nest's global JSON parser.** The webhook route needs
  `rawBody: true` in the Nest app options and its own body handling; the global parser
  otherwise consumes the stream and the signature never verifies. This breaks silently -
  the route works, verification just always fails.
- **Ledger rows must balance.** `CHARGE = REFUND + CANCELLATION_FEE` for a
  refunded-late-cancellation. A rounding error in the fee makes them disagree by a paisa.
  `Math.round` once, in one place, and an integration test asserting the sum.
- **Refund of a partially collected `PAY_AFTER`.** Cash collected then a cancellation is an
  edge the brief does not describe. Decision: refund the collected amount minus the fee, via
  the same path. Documented.
- **Concurrent confirm and webhook for the same payment.** Both call `applyOutcome`; the
  first to commit wins and the second sees a terminal payment and no-ops. Safe because both
  re-read the payment inside their transaction - a cached read would double-apply.

## Test strategy

- Integration: `tok_fail` on a capacity-1 slot -> booking cancelled, then a **different**
  customer books the same slot successfully. The brief's DONE WHEN, and it proves the seat
  was genuinely released rather than just marked.
- Integration: `POST /bookings` then `POST /payments/:id/confirm` twice with the same
  `Idempotency-Key` -> assert exactly one `Booking` row and one `Payment` row in the
  database. The brief's DONE WHEN.
- Integration: deliver an identical webhook twice -> assert one `WebhookEvent`, one
  `LedgerEntry`, and unchanged booking status after the second.
- Integration: `tok_delay` -> payment `INITIATED`, booking not confirmable (422
  `PAYMENT_REQUIRED`); webhook `SUCCESS` -> confirmable.
- Integration: cancel a paid booking late -> `REFUND` + `CANCELLATION_FEE` rows summing to
  the charge.
- Unit: the mock's token table, and `computeOutstanding` across charge / collect / refund
  combinations.
- Static: assert no gateway package in `package.json` and no gateway name in `src/`.
