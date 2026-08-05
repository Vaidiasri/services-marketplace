# M6 - The Booking Lifecycle (Overview)

## What this feature does

This is the heart of the assignment - the brief's own words.

A booking is not a row that gets edited. It is something that moves through a sequence
of states, where each move is either legal or refused, and every move leaves a
permanent record of who made it and why.

## The states

| State | How you get here | Where you can go next |
| --- | --- | --- |
| `PENDING` | The customer books | `CONFIRMED`, `REJECTED`, `CANCELLED` |
| `CONFIRMED` | The vendor accepts | `COMPLETED`, `CANCELLED`, `NO_SHOW` |
| `COMPLETED` | The vendor marks it delivered | nowhere - it is finished |
| `REJECTED` | The vendor declines | nowhere |
| `CANCELLED` | Either party cancels, or an admin forces it | nowhere |
| `NO_SHOW` | The vendor reports the customer never arrived | nowhere |

Four of the six are terminal. Once a booking is completed or cancelled, it is
historical - nothing reopens it.

Anything not in that table is refused by the server. A vendor cannot complete a booking
the customer only just requested, because `PENDING -> COMPLETED` is not a legal move -
they have to confirm it first. That refusal is a deliberate, specific error, not a crash.

And it is refused on the **server**. Not by hiding the button. The brief's check is a
vendor calling complete on a pending booking directly and getting a 422.

## What a booking remembers

The service, the specific offering, the slot, the customer, **the price at the time of
booking**, and whether they are paying now or later.

That price detail matters. If the vendor raises the price of a haircut next week, your
existing booking does not change. The number was copied onto the booking when you made
it. Nothing recalculates it from the current price list.

## The hard part: two people, one seat

This is the single most-tested thing in the whole assignment, and it is where naive
implementations fail.

A slot has two seats. Two people tap "book" at the same instant. What must happen: one
gets a booking, the other gets a clean "sorry, that filled up" - and never, under any
timing, do three bookings exist in a two-seat slot.

The tempting approach is to check how many bookings exist, see there is room, and
insert. That works perfectly until two requests check at the same moment, both see
room, and both insert. The brief names this exact pattern as "the failure we are testing
for."

So the check and the write happen as one indivisible operation, with the database
holding a lock on the seat count while it happens. The second request waits, then looks
again, sees zero seats, and is refused. There is no window between looking and writing
for the other request to slip through.

The proof is a script committed to the repository: fire twenty simultaneous booking
requests at a three-seat slot. Exactly three bookings exist afterwards. Seventeen clean
refusals. Its output is committed alongside it.

## Moving a booking

A customer can reschedule a pending or confirmed booking to a different time. The old
seat is released and the new one taken **together** - so there is no moment where the
customer holds two seats, and no moment where they hold none and someone else takes the
one they were moving to. If the new slot turns out to be full, the whole move is
abandoned and the original booking is untouched.

## Cancelling, and the cost of it

Each service declares a free-cancellation window - say 24 hours before the start.

Cancel earlier than that and it is free. Cancel inside that window - closer to the
appointment than the vendor's notice period - and a fee applies, a percentage the
service sets. The booking still cancels; the customer just does not get all their money
back. If they had paid, the refund is the price minus the fee.

The brief allows either refusing late cancellations or charging for them. This charges,
because refusing leaves a customer stuck with an appointment they cannot attend, and the
fee models what real businesses do.

Admins can force-cancel anything, at any time, ignoring the window - but they must give
a reason, and that reason becomes part of the booking's permanent record.

## The timeline

Every single state change writes a row: who did it, what it moved from, what it moved
to, when, and optionally why. The booking detail page shows these in order.

So a booking that was made, confirmed, rescheduled, then force-cancelled by an admin
reads as a five-line story with names and timestamps and the admin's reason at the
bottom. Nothing is inferred or reconstructed - it was recorded as it happened.

## How you will know it works

- Run the concurrency script. Twenty requests, three seats, three bookings.
- As a customer, call the complete endpoint. 403 - you do not have that permission.
- As the vendor, call complete on a booking still pending. 422 - illegal move.
- Reschedule a booking, then cancel it, then read the timeline. It reads correctly from
  start to finish.
- Cancel two hours before a booking whose service allows 24 hours' free notice. It
  cancels, with the fee recorded.

## Related

- Technical spec: [plan.md](plan.md)
- Where the seats come from: [M5](../M5_AVAILABILITY_SLOTS/overview.md)
- What happens to the money: [M7](../M7_PAYMENTS_MOCK/overview.md)
- Force-cancel's screen: [M8](../M8_ADMIN_CONSOLE/overview.md)
