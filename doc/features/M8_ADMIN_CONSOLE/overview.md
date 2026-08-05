# M8 - Admin Console (Overview)

## What this feature does

It is where the person who governs the marketplace does their governing.

An admin does not sell anything and does not book anything. They approve the vendors,
police the catalogue, look across every booking in the system, intervene when something
goes wrong, and - most importantly - decide what other admins are allowed to do.

## The dashboard

Four numbers, chosen because they are the ones an operator would actually look at first
thing in the morning:

- **Pending vendor applications** - work waiting for a human
- **Bookings today** - is the marketplace busy
- **Revenue collected** - money that actually arrived
- **Payments failed** - money that did not, and probably needs chasing

Each is a link to the filtered list behind it, so a number is never a dead end.

## Every booking, everywhere

Vendors see their own bookings. Customers see their own. An admin sees all of them, in one
list, filtered by status, by vendor, and by date range.

The filtering happens in the database, not in the browser. That distinction matters
because it is the difference between a list that works with ten bookings and one that
works with ten thousand, and the brief grades it explicitly.

## Force-cancel

Sometimes an admin has to kill a booking that neither party will kill themselves - a
fraudulent order, a vendor who has gone dark, a customer complaint.

They can, from anywhere in the lifecycle, and it ignores the cancellation window
entirely. But they **must** type a reason, and that reason is written into the booking's
permanent timeline where both the customer and the vendor will read it. There is no
anonymous administrative deletion.

## Roles and permissions - the interesting screen

This is the part the brief spends the most words on, and the screen that demonstrates the
whole permission architecture is real rather than decorative.

An admin can:

- See every permission the system has, grouped sensibly.
- Create a new role, give it a name, and tick the permissions it should carry.
- Assign that role to a sub-admin.

And then the thing the brief asks to be demonstrated: that sub-admin's world shrinks to
match. Their navigation has fewer items. Their API calls to anything outside the ticked
boxes are refused. Nobody deployed anything, nobody edited any code - a row changed in a
table.

The worked example from the brief is seeded so it can be shown immediately: a **Catalogue
Moderator** who can manage categories and suspend services, and can do nothing else at
all. Sign in as them and the console is two sections wide.

## The guard rails

An admin console is the most dangerous screen in any application, so a few things are
deliberately impossible:

- You cannot grant a permission you do not hold yourself. Otherwise anyone who can assign
  roles is effectively a super admin, which makes the whole permission layer theatre.
- You cannot delete or rename the four built-in roles, though you can absolutely edit
  what they can do - that is the demo.
- You cannot remove the last super admin. That would lock everyone out of a deployed
  instance permanently.

## What is deliberately left out

An audit log of every admin action is tagged stretch in the brief and is cut. The booking
timeline already records administrative interventions with actor, reason, and timestamp,
which covers the case that actually matters and demonstrates the same pattern.

## How you will know it works

- Log in as the seeded catalogue moderator. Two nav sections. No vendor approvals, no
  cross-vendor bookings, no roles screen.
- Curl the cross-vendor booking list with that moderator's token. 403.
- As super admin, create a role, tick three permissions, assign it. The assignee's next
  page load reflects it.
- Force-cancel a booking. Open it as the customer. The reason is there, with your name and
  the time.

## Related

- Technical spec: [plan.md](plan.md)
- The permission model behind it: [M2](../M2_PERMISSIONS/overview.md)
- The vendor queue it drives: [M3](../M3_VENDOR_ONBOARDING/overview.md)
- The transitions it can force: [M6](../M6_BOOKING_LIFECYCLE/overview.md)
