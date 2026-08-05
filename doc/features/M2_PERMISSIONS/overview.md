# M2 - Roles & Permissions (Overview)

## What this feature does

It decides who may do what, and it decides it on the server, every time.

The brief says this module is reviewed first, and it carries the single largest block
of marks. It is also the one where the difference between a real implementation and a
convincing-looking one is easiest for a reviewer to expose with one curl command.

## The idea in three layers

**Permissions** are the atoms. Each one is a small string like `service.create` or
`booking.cancel` or `vendor.approve`. There are 52 of them, seeded into the database.
A permission is not a concept in the code - it is a row.

**Roles** are named bundles of those atoms. `VENDOR` is a bundle. `CUSTOMER` is a
bundle. `CATALOGUE_MODERATOR` is a bundle holding only the category permissions plus
the ability to suspend a service. Crucially, roles are **rows too**, not an enum in
the source. An admin can invent a new role at runtime, tick the permissions it should
carry, assign it to someone, and that person's world changes - no deployment, no code
edit, no restart.

**The guard** is the enforcement. It sits in front of every protected route. It looks
at who is calling, loads that person's role's permissions from the database, and
compares them against what the route declares it requires. No match, no entry.

## Two gates, not one

Holding a permission is not the same as being allowed to use it on a particular
record. `service.update` lets a vendor edit *their own* service. It does not let them
edit a competitor's.

So there are two independent checks, in order:

1. **Do you hold the permission at all?** If not, 403, and nothing else runs.
2. **Do you own this specific record?** If not, refused - and for records where even
   knowing they exist is a leak, like another vendor's booking, the answer is 404
   rather than 403.

A vendor with every vendor permission still cannot touch another vendor's data,
because the second gate has nothing to do with permissions. This separation is
explicitly what the brief asks for.

## The one bypass

`SUPER_ADMIN` skips both gates. That is a deliberate short-circuit on the role, not a
role that happens to hold all 52 permissions - because the "holds everything" version
silently breaks the day someone adds permission number 53. Nobody else has a bypass.

## The client's role in this: none

The frontend reads the caller's permissions from `GET /me` and hides the buttons and
menu items they cannot use. That is a courtesy to the user, and the brief is blunt
that it is cosmetic. Every one of those hidden actions is also refused by the server
if called directly. The test the graders run is exactly that: take a low-privilege
token, curl the privileged endpoint, expect 403.

## What you can demonstrate

- Sign in as the seeded catalogue moderator. The sidebar has two sections. It cannot
  see vendor approvals or the cross-vendor booking list, and calling those endpoints
  directly returns 403.
- As super admin, create a brand new role in the UI, tick three permissions, assign
  it to a sub-admin. That sub-admin's next page load reflects it.
- Strip `category.create` from the moderator's role. Their very next request to create
  a category is refused. Nothing was redeployed.
- As one vendor, request another vendor's booking by id. You get 404 and never see the
  record.

## Related

- Technical spec: [plan.md](plan.md)
- The full slug list and seeded roles: [02_PERMISSION_CATALOGUE.md](../../02_PERMISSION_CATALOGUE.md)
- Where sessions come from: [M1](../M1_AUTH/overview.md)
- The management screens for this: [M8](../M8_ADMIN_CONSOLE/overview.md)
