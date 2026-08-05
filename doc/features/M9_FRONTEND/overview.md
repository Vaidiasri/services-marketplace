# M9 - Frontend Shell & Screens (Overview)

## What this feature does

It is the part a reviewer actually opens.

Visual polish is worth 5 of the 100 marks, so this is deliberately not a design
exercise. What the remaining UI marks reward is different and much more achievable:
every screen handles **loading**, **empty**, and **error** states properly, and the
navigation reflects what the signed-in person is allowed to do.

A clean, consistent, slightly plain interface that never shows a blank white flash and
never leaves you staring at a spinner that will never resolve beats a beautiful one that
breaks when a list comes back empty.

## One app, three worlds

There is one React application. Which world you see depends on who you are, and that is
decided by the server's answer to "who am I".

**A customer** gets the catalogue, a service page with a slot picker, a booking flow, and
their own bookings with timelines.

**A vendor** gets - once approved - their services, their offerings, an availability
editor, and a queue of bookings to confirm, complete, or reject. Before approval, they get
exactly one screen telling them they are pending.

**An admin** gets the console: dashboard, vendor applications, categories, all bookings,
roles, users. And a restricted sub-admin gets a visibly smaller version of it.

Nobody's navigation is hardcoded. It is built from the permission list the server returns,
which is why stripping a permission makes a menu item disappear.

## The three states every screen owes you

**Loading.** Skeletons that match the shape of the content, not a centred spinner. This
matters more than it sounds on a free hosting tier, where the API can take several seconds
to wake up - the difference between "this is loading" and "this is broken" is entirely in
what you render during those seconds.

**Empty.** A vendor with no services yet, a customer with no bookings, a search with no
matches, a day with no available slots. Each gets a sentence explaining why it is empty and,
where it makes sense, the button that fixes it. Not a bare zero.

**Error.** A message a human can read, and a retry button that actually retries. Never a
raw status code, never a stack trace, and never a screen that silently shows nothing because
a request failed.

## The invisible session

The access token expires every fifteen minutes. The user must never notice.

The API client handles it: a request comes back unauthorised, it quietly gets a fresh token,
retries once, and the user's click just works. If several requests fail at the same moment,
only one refresh happens and the rest wait for it - which sounds like a detail but is
actually the difference between a working session and being randomly logged out mid-task.

If the refresh itself fails, the user goes to the login screen, once, cleanly.

## Booking, as a flow

The one journey that gets real attention, because it is the product:

Pick a service. Pick an offering - and notice the available times change, because duration
drives the calendar. Pick a slot, seeing how many places are left. Choose to pay now or
later. Confirm. Land on a booking with a live timeline.

If the slot filled up while you were deciding, you get told clearly and shown the refreshed
times, not a generic error.

## Timezones, shown honestly

Every time is displayed with the vendor's timezone labelled, because a customer in London
booking a Mumbai salon needs to know which 6pm is meant. The client formats; the server
decides.

## How you will know it works

- Throttle the network and load any list. Skeletons, then content. Never a blank frame.
- Point the app at a stopped API. Readable error, working retry.
- Sign in as a fresh vendor. One pending screen. As the catalogue moderator, two admin
  sections.
- Sit idle past the token expiry, then click something. It works, with one refresh in the
  network tab.
- Open every dialog at 1024x768 and confirm the primary button is reachable.

## Related

- Technical spec: [plan.md](plan.md)
- Where the permission list comes from: [M1](../M1_AUTH/overview.md) and [M2](../M2_PERMISSIONS/overview.md)
- The admin screens in detail: [M8](../M8_ADMIN_CONSOLE/overview.md)
