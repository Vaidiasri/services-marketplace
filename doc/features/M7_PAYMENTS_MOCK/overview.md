# M7 - Payments, Mocked (Overview)

## What this feature does

It handles money without touching any.

The brief is emphatic: **no real gateway.** No Razorpay, no Stripe, not even a sandbox
account. What is being assessed is the *shape* of the payment flow - the state
transitions, the idempotency, the failure handling - because that shape is what survives
when a real provider eventually replaces the mock.

So there is a `PaymentProvider` interface with a mock implementation behind it. Swapping
in a real provider later means writing a second implementation and changing one line of
wiring. Nothing else in the codebase knows a provider exists.

## Two ways to pay

**Pay now.** The customer settles up front. The booking is created but the vendor cannot
confirm it until the payment succeeds. Money first, appointment second.

**Pay after.** The customer books for free and settles at or after the appointment. The
booking works normally; it just carries an outstanding balance the whole time. When the
customer hands over cash, the vendor marks it collected and the balance clears.

The mode is chosen per booking, by the customer, at the moment they book.

## What a payment is

A record with an amount, a currency, a reference from the provider, and a status:

- `INITIATED` - started, outcome unknown
- `SUCCESS` - money captured
- `FAILED` - it did not work
- `REFUNDED` - it worked, then was given back

## Making failure happen on demand

A reviewer needs to exercise both the happy path and the sad path on the deployed site,
and they cannot do that if the mock always succeeds.

So the mock is **deterministic and triggerable**. The token you pass decides what
happens:

| Token | What the mock does |
| --- | --- |
| `tok_success` | Succeeds immediately |
| `tok_fail` | Fails immediately, with a reason |
| `tok_delay` | Stays pending - resolved later by the webhook |
| `tok_refund_fail` | Succeeds, but refusing to refund later |

These are documented in the README so a reviewer can reproduce every path by hand.

## The asynchronous path

Real payment providers do not always answer immediately. Sometimes they take the request,
say "we'll get back to you", and call your server later. That callback is a webhook, and
it is a notoriously easy thing to get wrong.

So there is a webhook endpoint that can be called by hand - `POST /payments/webhook` -
which moves a pending payment to success or failure, with the booking reacting
accordingly.

And **delivering the same webhook twice must do nothing the second time.** Real providers
retry. If a duplicate delivery double-refunds a customer or double-confirms a booking,
that is a real bug in a real system. Every event carries an id, ids are recorded, and a
repeat is acknowledged and ignored.

## Never charging twice

Related problem, different cause: the customer's connection drops mid-request and their
phone retries. Did the first request go through? Neither side knows.

The answer is an idempotency key - a unique string the client generates and sends with
the request. If the server has seen that key before, it returns the original answer
instead of doing the work again. The brief's check: replay the same confirm request twice
and there is one booking and one payment. Not two of either.

## Failure must not hold the seat

The most important consequence in the whole module.

If a pay-now payment fails, the booking cannot stay confirmed, and - critically - the
slot must not stay held. Someone else should be able to book that time. A failed payment
that leaves a permanently blocked seat is a slow leak that eventually empties a vendor's
calendar for no reason.

So a failed payment releases the seat, in the same operation that records the failure.
The brief tests exactly this: force a payment failure, then check the slot is bookable by
somebody else.

## Refunds

Cancel a paid booking early - inside the free window - and a refund is issued: the
payment's status changes and a ledger row records the movement. A late cancellation
refunds the price minus the fee described in
[M6](../M6_BOOKING_LIFECYCLE/overview.md). An admin's force-cancel always refunds in full.

The ledger is append-only. Nothing in it is ever edited, so the history of money moving
is always readable in order.

## How you will know it works

- Book with `tok_fail`. The booking does not confirm, and the slot is immediately
  available to another customer.
- Send the same confirm request twice with the same key. One booking, one payment.
- Deliver the same webhook event twice. The second delivery changes nothing.
- Book pay-after. The booking shows an outstanding balance until the vendor marks cash
  collected, then it does not.
- Search the codebase for any real gateway's name. Nothing.

## Related

- Technical spec: [plan.md](plan.md)
- The booking states this drives: [M6](../M6_BOOKING_LIFECYCLE/overview.md)
- The idempotency contract: [03_API_CONVENTIONS.md](../../03_API_CONVENTIONS.md)
