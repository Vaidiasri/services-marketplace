# M5 - Availability & Slots (Overview)

## What this feature does

It turns "we're open Tuesday mornings" into a list of specific times a customer can
tap.

The vendor never types out individual appointment times. They describe their week
once, note the days they are closed, and the system works out the rest - every time
anyone asks, freshly.

## The rule that shapes everything

**Slots are calculated, never stored by hand.**

The brief says this outright, and it rejects a table of manually entered slot rows.
So there is no "slots" table anyone fills in. A slot exists because the arithmetic
says it does, and it stops existing the moment the inputs change. Close a date and its
slots are gone on the next request - nothing needs deleting.

## The three inputs

**Weekly rules.** For each weekday, the vendor gives zero or more open windows and a
capacity. "Tuesdays 09:00-13:00 and 16:00-20:00, capacity 2" means two customers can
share any given time on a Tuesday within those hours. Two windows on one day is
normal - it is how a lunch break is expressed, by simply not being open across it.

**Date exceptions.** Two kinds. A **closure** blacks out a specific date - a public
holiday, a family emergency. A **one-off window** opens a date that would normally be
closed - a Sunday they decided to work. Remove the exception and normal hours come
straight back, because normal hours were never overwritten, only overridden.

**What is already booked.** Every existing booking consumes some of a slot's capacity.
A slot with capacity 2 that has one booking reports one seat remaining. When it hits
zero it stops being offered at all.

## Duration decides the shape

An offering's duration is what a slot is measured in. A 30-minute haircut and a
60-minute colour treatment produce different grids over the same open window, and the
60-minute one consumes twice as much of the vendor's day.

So slots are always requested for a specific offering, not just a service. Change that
offering from 30 minutes to 60 and the available times change immediately - which is
one of the checks the brief runs.

## Time zones, answered honestly

This is the question the walkthrough asks: what happens when the vendor is in Mumbai
and the customer is in London?

The answer here: **the vendor's timezone is the authority.** "Tuesday 09:00" means
09:00 where the vendor is standing. The server converts that to an exact moment in
universal time, and that moment is what everything downstream uses - storage,
comparisons, the "is this in the past" check.

The customer's browser is never trusted for any decision. It is trusted for exactly
one thing: displaying that moment in whatever way is convenient to the person reading
it. The response carries both the precise instant and the vendor's timezone label, so
a customer in London sees "13:30 your time (18:00 IST)" and there is no ambiguity
about which appointment they are booking.

The past-slot check follows the same logic. It compares the slot's real instant
against the server's real clock. Someone with a wrong laptop clock, or a customer in a
timezone where it is still yesterday, cannot book a time that has already happened.

## One convenience

A "next available" endpoint that answers "when is the soonest I could get in?" without
the customer paging through a calendar. It is one query the booking flow opens with.

## How you will know it works

- Close next Tuesday. Its slots disappear. Delete the closure. They are back, unchanged.
- Book one seat in a capacity-2 slot. It reports one remaining. Book the second. It
  stops appearing.
- Change an offering from 30 to 60 minutes. The grid over the same open window halves.
- Ask for slots covering yesterday. Nothing is returned, regardless of what timezone
  you ask from.

## Related

- Technical spec: [plan.md](plan.md)
- Where duration and capacity are configured: [M4](../M4_CATALOGUE/overview.md)
- What consumes these slots: [M6](../M6_BOOKING_LIFECYCLE/overview.md)
