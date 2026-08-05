# M4 - Service Catalogue (Overview)

## What this feature does

It is the shop window and the stockroom behind it.

A vendor describes what they sell. An admin organises how it is filed and can pull
something off the shelf. A customer searches, filters, and pages through only the
things that are genuinely for sale.

## The three pieces

**Categories** are the filing system, run by admins. Two levels is enough: `Beauty`
with `Salon` and `Spa` underneath it, `Home` with `Cleaning` and `Repairs`. A
sub-category cannot have its own children - the nesting stops at two on purpose,
because a tree of arbitrary depth costs real work and earns no marks here.

**Services** are what a vendor lists. A title, a description, a category, some images,
and a status. The status is the important part:

- `DRAFT` - the vendor is still writing it. Invisible to everyone else.
- `PUBLISHED` - live, bookable, in the public catalogue.
- `SUSPENDED` - an admin pulled it, with a reason. Off the shelf.

**Offerings** are the things you actually buy. A service is "Sharp Cuts Salon"; its
offerings are "Haircut, 45 minutes, 3400" and "Beard trim, 20 minutes, 900". Each has
a name, a duration, a price, and an active flag.

The duration is not decoration. It is what decides how long a booking blocks the
vendor's calendar, so changing an offering from 30 minutes to 60 changes the slots
customers are offered. That link is built in [M5](../M5_AVAILABILITY_SLOTS/overview.md).

## What the public can see

One rule, and it has two halves: a service appears in the public catalogue only if it
is `PUBLISHED` **and** its vendor is `APPROVED`.

Both halves are always checked together. A published service belonging to a vendor who
was later suspended disappears. A draft belonging to a fully approved vendor stays
hidden. And the check is not just on the list - a signed-out visitor who guesses the
URL of a draft service gets a 404, not a preview. The brief tests exactly that.

## Searching properly

The catalogue paginates, searches, and filters, and all of it happens in the database.

The brief is blunt about this: fetching every row and filtering in the browser does not
count. So the search text goes into the SQL, the category filter goes into the SQL, the
price range goes into the SQL, and the total count is computed over the same conditions
as the page you are looking at. Page 2 of a filtered search returns the correct rows
and a total you can trust.

## Suspension

An admin with the right permission can pull a live service down and must say why.

The delicate part is what happens to bookings that already exist. They survive. A
customer who booked a haircut for Thursday still has that appointment, and the vendor
can still confirm and complete it. What stops is *new* bookings - the service is gone
from the catalogue and its slot endpoint refuses. Suspension is a forward-looking
action, not a retroactive cancellation.

## How you will know it works

- Sign out entirely and open a draft service's URL directly. 404.
- Search the catalogue for "hair", filter to one category, go to page 2. The rows are
  right and the total matches.
- Change an offering's duration from 30 to 60 and watch the available slots change.
- Suspend a live service with a reason. It vanishes from the catalogue, its existing
  confirmed booking is still there, and a new booking attempt is refused.

## Related

- Technical spec: [plan.md](plan.md)
- What approval unlocks this: [M3](../M3_VENDOR_ONBOARDING/overview.md)
- Where duration becomes slots: [M5](../M5_AVAILABILITY_SLOTS/overview.md)
- Pagination contract shared with every list: [03_API_CONVENTIONS.md](../../03_API_CONVENTIONS.md)
