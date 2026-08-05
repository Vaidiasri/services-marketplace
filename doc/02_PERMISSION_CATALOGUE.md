# Permission Catalogue

The full seeded slug list and the four seeded roles. This file is the source of
truth for `prisma/seed.ts`.

## Slug shape

`resource.action`. Lowercase, dot-separated, no wildcards stored in the database -
`category.*` in the brief's example is shorthand for the three concrete category
slugs, and the seed inserts them individually. Wildcards are a UI grouping
convenience only; the guard always compares exact slugs.

## Catalogue

| Resource | Slugs |
| --- | --- |
| user | `user.read`, `user.read_all`, `user.update` |
| role | `role.read`, `role.create`, `role.update`, `role.delete`, `role.assign` |
| permission | `permission.read` |
| vendor | `vendor.read`, `vendor.read_all`, `vendor.update`, `vendor.approve`, `vendor.reject` |
| category | `category.read`, `category.create`, `category.update`, `category.delete` |
| service | `service.read`, `service.read_all`, `service.create`, `service.update`, `service.delete`, `service.publish`, `service.suspend` |
| offering | `offering.create`, `offering.update`, `offering.delete` |
| availability | `availability.read`, `availability.manage` |
| booking | `booking.read`, `booking.read_all`, `booking.create`, `booking.reschedule`, `booking.cancel`, `booking.force_cancel`, `booking.confirm`, `booking.reject`, `booking.complete`, `booking.no_show` |
| payment | `payment.read`, `payment.read_all`, `payment.initiate`, `payment.refund`, `payment.mark_collected` |
| admin | `admin.dashboard.read` |
| audit | `audit.read` (STRETCH) |

52 slugs. `admin.dashboard.read` and `audit.read` are the only three-segment slugs;
the guard splits on the last dot for the `resource`/`action` columns.

## Read vs read_all - the ownership boundary

This pair is the mechanism behind the brief's requirement that "Vendor A requesting
Vendor B's booking by id gets 403 or 404, never the record."

- `booking.read` grants access **subject to an ownership check**. A vendor with it
  sees bookings on their own services; a customer with it sees their own bookings.
- `booking.read_all` removes the ownership filter. Only admin roles hold it.

Same pattern for `service.read` / `service.read_all`, `vendor.read` /
`vendor.read_all`, `payment.read` / `payment.read_all`, `user.read` / `user.read_all`.
Permission and ownership are two separate gates, checked in that order. Details in
[M2's plan](features/M2_PERMISSIONS/plan.md).

## Seeded roles

Four rows in `Role`, all with `isSystem = true`.

### `SUPER_ADMIN`

Bypasses every permission check in the guard - not by holding all 52 slugs, but by a
short-circuit on the role slug. Holding-all-slugs would break the moment a new slug
is added, and the brief specifically says "SUPER_ADMIN bypasses every check."
Ownership checks are also bypassed. This is the only role with a bypass.

### `CUSTOMER`

Self-registers. Holds:

`service.read`, `availability.read`, `booking.read`, `booking.create`,
`booking.reschedule`, `booking.cancel`, `payment.read`, `payment.initiate`,
`user.read`, `user.update`

Notably absent: `booking.confirm`, `booking.complete`, `booking.reject`. A customer
calling `PATCH /bookings/:id/complete` fails at the permission gate with 403, which
is one of the brief's DONE WHEN checks.

### `VENDOR`

Self-registers into a `PENDING` vendor profile. Holds:

`service.read`, `service.create`, `service.update`, `service.delete`,
`service.publish`, `offering.create`, `offering.update`, `offering.delete`,
`availability.read`, `availability.manage`, `booking.read`, `booking.confirm`,
`booking.reject`, `booking.complete`, `booking.no_show`, `booking.cancel`,
`payment.read`, `payment.mark_collected`, `vendor.read`, `vendor.update`,
`user.read`, `user.update`

Holding `service.publish` is **not** sufficient to publish. A second gate checks the
vendor profile is `APPROVED`. Permission, ownership, and vendor status are three
independent gates.

### `CATALOGUE_MODERATOR`

The brief's worked example, seeded as the restricted sub-admin so reviewers can log
in as it immediately. Holds exactly:

`category.read`, `category.create`, `category.update`, `category.delete`,
`service.read`, `service.read_all`, `service.suspend`, `user.read`

This role proves the data-driven claim: it has no `role.*`, no `vendor.approve`, no
`booking.read_all`. Its `GET /me` returns eight slugs, its navigation renders two
sections, and `GET /admin/bookings` returns 403 for it.

## The revocation demo

The brief's DONE WHEN: "Revoking a permission from a role changes what that user can
do on their next request, with no redeploy and no code change."

Sequence to demonstrate on the deployed instance:

1. Sign in as the catalogue moderator, `POST /categories` succeeds.
2. As super admin, `DELETE /roles/:catalogueModeratorId/permissions/category.create`.
3. The moderator's **next** request to `POST /categories` returns 403.
4. `GET /me` for the moderator now returns seven slugs, and the client's category
   create button disappears on refetch.

This requires the guard to resolve permissions per request rather than reading them
from the access token. That constraint is why the access token carries only the user
id and role slug, never the permission list - see
[M1's plan](features/M1_AUTH/plan.md).
