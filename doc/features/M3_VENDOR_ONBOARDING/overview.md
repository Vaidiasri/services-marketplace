# M3 - Vendor Onboarding (Overview)

## What this feature does

It is the gate between "someone signed up claiming to be a business" and "a business
whose services the public can see and book."

A vendor cannot let themselves through it. Only an admin can.

## The journey

**Apply.** A vendor signs up and submits a business profile: business name, a contact
name and phone, a full address, the timezone they operate in, and one or more
supporting documents - a licence, a registration certificate, whatever they have. The
documents land on the server's disk; the database records only the filename. There is
no cloud object storage involved and the brief says there does not need to be.

**Wait.** The account is created and it is real - they can sign in - but it sits in
`PENDING`. Signing in shows them a single screen: your application is under review,
here is what you submitted. There is no service editor, no availability calendar, no
booking list, because they have nothing yet and are not allowed to.

**Be judged.** An admin holding `vendor.approve` reviews the profile and the documents
and either approves or rejects.

**Approved** flips the profile to `APPROVED`, and the vendor's next page load has the
full vendor workspace in it. They do not need to log out and back in - their session is
untouched, and the status comes from the server on refetch, not from something baked
into their token at login.

**Rejected** flips to `REJECTED` and carries a reason, written by the admin, which the
vendor can read on their status screen. A rejection is not a silent dead end.

## The rule that matters

A pending or rejected vendor can sign in and see their status. That is the entire list
of what they can do.

The brief is specific about how this is enforced: a pending vendor cannot publish a
service, **blocked at the API, not just missing a button**. So it is not that the
publish button is hidden - it is that if you take that vendor's token and curl the
publish endpoint yourself, the server refuses. The hidden button is a nicety on top.

This is a third gate, independent of the other two. A vendor holds
`service.publish` from the moment they register, and they own their own service, so
both the permission gate and the ownership gate pass. The vendor-status gate is what
stops them, and it exists precisely because the other two are not enough.

## What the admin sees

A queue of pending applications with the count on their dashboard, each expanding to
the submitted profile and downloadable documents, with approve and reject actions.
Reject demands a reason before it will submit.

## How you will know it works

- Register a vendor, sign in as them. One status screen, nothing else in the nav.
- Take that vendor's access token and curl `POST /services/:id/publish`. 403, with a
  code saying the vendor is not approved.
- Approve them from the admin console. Without logging out, the vendor's browser tab
  gains the full workspace on its next refetch.
- Reject a different vendor with the reason "documents illegible". The vendor reads
  exactly that sentence on their status screen.

## Related

- Technical spec: [plan.md](plan.md)
- Where the pending profile is created: [M1](../M1_AUTH/overview.md)
- What approval unlocks: [M4](../M4_CATALOGUE/overview.md)
- The admin queue's screen: [M8](../M8_ADMIN_CONSOLE/overview.md)
