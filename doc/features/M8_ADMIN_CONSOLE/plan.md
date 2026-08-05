# M8 - Admin Console (Plan)

Brief module 08. Scores under UI (10 marks) and is the surface that makes the Permissions
area (20 marks) visible to a reviewer.

## Key decisions

- **The console is routes in the same React app**, not a separate build. One auth flow, one
  API client, one deployment. A second app doubles the delivery risk for no marks.
- **Navigation is generated from `GET /me` permissions**, not from a hardcoded admin menu.
  This is what makes the shrinking-UI demo work without a code change, and it means a new
  role invented at runtime gets a sensible nav for free.
- **Dashboard counts are four separate indexed queries in one `$transaction`**, not one
  clever join. Each is trivially explainable in the walkthrough, and they can be
  independently cached later.
- **"Revenue collected" counts only `SUCCESS` charges plus `CASH_COLLECTED` ledger rows,
  minus refunds.** Reading it off `Booking.priceMinor` would count money that never arrived.
- **Force-cancel reuses M6's cancel path** with `bypassWindow: true` and a mandatory
  reason. A separate implementation would drift from the state machine.
- **The role editor sends the complete permission set**, not a delta. The checkbox state
  *is* the desired state.
- **The audit log is cut.** Brief-tagged stretch, item 2 on the cut list in
  [00_MASTER_PLAN.md](../../00_MASTER_PLAN.md). `BookingStatusHistory` already records
  actor, action, target, and timestamp for the interventions that matter.

## API contract

| Method | Endpoint | Requires | Notes |
| --- | --- | --- | --- |
| GET | `/admin/dashboard` | `admin.dashboard.read` | The four counts, plus the vendor timezone used for "today" |
| GET | `/admin/bookings` | `booking.read_all` | Paginated. `status`, `vendorId`, `customerId`, `from`, `to`, `q` (booking reference). All server-side |
| PATCH | `/admin/bookings/:id/force-cancel` | `booking.force_cancel` | `{ reason }` required, min 10 chars |
| GET | `/admin/vendors` | `vendor.read_all` | From [M3](../M3_VENDOR_ONBOARDING/plan.md) |
| PATCH | `/admin/vendors/:id/approve` \| `/reject` | `vendor.approve` \| `vendor.reject` | From M3 |
| GET | `/admin/services` | `service.read_all` | From [M4](../M4_CATALOGUE/plan.md) |
| POST | `/admin/services/:id/suspend` | `service.suspend` | From M4. STRETCH |
| GET | `/permissions` | `permission.read` | Grouped by resource for the checkbox tree |
| GET/POST/PATCH/DELETE | `/roles*` | `role.*` | From [M2](../M2_PERMISSIONS/plan.md) |
| GET | `/admin/users` | `user.read_all` | Paginated, `?roleId=`, `?q=` on email and name |
| POST | `/admin/users` | `user.create` + `role.assign` | Creates a sub-admin. `{ email, fullName, roleId, password }`. The only way an admin comes into existence besides the seed |
| PUT | `/admin/users/:id/role` | `role.assign` | Subject to the subset rule |
| PATCH | `/admin/users/:id/status` | `user.update` | `{ isActive }`. Suspends a user |

Dashboard response:

```ts
type Dashboard = {
  pendingVendorApplications: number
  bookingsToday: number
  revenueCollectedMinor: number
  paymentsFailed: number
  currency: string
  asOfUtc: string
}
```

## Impact map

- `server/src/admin/admin.module.ts` - add
- `server/src/admin/dashboard.controller.ts` / `dashboard.service.ts` - `getCounts()` - add
- `server/src/admin/admin-bookings.controller.ts` - list + force-cancel - add
- `server/src/admin/admin-users.controller.ts` / `admin-users.service.ts` - add
- `server/src/bookings/bookings.service.ts` - `cancel` - modify - accept
  `{ bypassWindow, forcedBy }` so force-cancel is the same code path
- `server/src/rbac/roles.service.ts` - `assertSubsetOfCaller` - modify - also applied on
  user creation, not just role assignment
- `client/src/routes/admin/_layout.tsx` - add - permission-driven nav
- `client/src/routes/admin/Dashboard.tsx` - add - four stat cards, each a link
- `client/src/routes/admin/Bookings.tsx` - add - filter bar + table + pager + force-cancel modal
- `client/src/routes/admin/Roles.tsx` + `RoleEditor.tsx` - add - permission checkbox tree
- `client/src/routes/admin/Users.tsx` - add - list, create sub-admin, assign role
- `client/src/routes/admin/Categories.tsx` - from M4
- `client/src/routes/admin/VendorApplications.tsx` - from M3
- `client/src/lib/nav.ts` - `buildNav(permissions)` - add - the permission-to-nav map

## Algorithms

### Dashboard counts

One `$transaction`, four queries:

1. `pendingVendorApplications` - `count VendorProfile where status = PENDING`.
2. `bookingsToday` - `count Booking where startUtc between [todayStart, todayEnd]` and
   status not in `(CANCELLED, REJECTED)`. **"Today" is ambiguous across timezones** - the
   window is computed in a configured `ADMIN_DISPLAY_TIMEZONE` (default `Asia/Kolkata`),
   and the response echoes it so the number is never unexplained. Reusing M5's
   `common/time.ts` rather than a second date implementation.
3. `revenueCollectedMinor` - `sum LedgerEntry.amountMinor where type in (CHARGE, CASH_COLLECTED)`
   minus `sum where type = REFUND`. Ledger, not bookings.
4. `paymentsFailed` - `count Payment where status = FAILED`.

### Permission-driven navigation

`buildNav(permissions)` maps a nav section to the permission that unlocks it:

| Section | Shown when the caller holds |
| --- | --- |
| Dashboard | `admin.dashboard.read` |
| Vendor applications | `vendor.read_all` |
| Categories | `category.read` |
| Services | `service.read_all` |
| Bookings | `booking.read_all` |
| Roles & permissions | `role.read` |
| Users | `user.read_all` |

`SUPER_ADMIN` sees everything. The map is data, so adding a section is one entry. Route
components additionally check with `useCan`, so a pasted URL does not render a shell that
then 403s on every request - it renders a proper "you do not have access" page.

**This is cosmetic.** Every one of those endpoints is guarded server-side, and the plan says
so out loud because the brief's deduction list leads with client-only enforcement.

### Force-cancel

1. `booking.force_cancel` guard - admin-only, not held by `VENDOR` or `CUSTOMER`.
2. Reason required, min 10 characters, validated at the boundary.
3. Calls M6's `cancel` with `bypassWindow: true`: fee is 0, full refund via
   [M7](../M7_PAYMENTS_MOCK/plan.md), cells released, history row written with the admin's
   user id, role slug, and the reason.
4. The reason appears verbatim in the timeline both parties can read.

## Error handling

| Operation | Failure | Behaviour |
| --- | --- | --- |
| Dashboard | Ledger empty | Zeroes, not an error. Empty state rendered in the UI |
| Dashboard | Caller lacks `admin.dashboard.read` | 403; the client renders an access page instead of an empty dashboard |
| `GET /admin/bookings` | `from` after `to` | 422 `INVALID_DATE_RANGE` |
| `GET /admin/bookings` | Unknown `vendorId` | 200 with an empty page - filtering by a non-existent id is not an error |
| Force-cancel | Reason under 10 chars | 422 |
| Force-cancel | Booking already terminal | 422 `ILLEGAL_TRANSITION` |
| Force-cancel | Refund fails at the provider | Booking still cancels; flagged for manual refund per M7 |
| `POST /admin/users` | Role contains a permission the caller lacks | 403 `ESCALATION_BLOCKED` |
| `POST /admin/users` | Email exists | 409 `EMAIL_TAKEN` |
| `PUT /users/:id/role` | Target is the last active `SUPER_ADMIN` | 409 `LAST_SUPER_ADMIN` |
| `PATCH /users/:id/status` | Deactivating the last super admin | 409 `LAST_SUPER_ADMIN` |
| Role editor | Save with zero permissions ticked | 200, allowed - a role with no permissions is valid and useful for the revocation demo |
| Any admin list | `pageSize` over 100 | Clamped |

## Security

| Threat | Mitigation |
| --- | --- |
| **Privilege escalation via the role editor.** A sub-admin with `role.update` adds `role.assign` and `booking.read_all` to their own role. | `assertSubsetOfCaller` on create, update, and assign: a non-super-admin can only grant permissions they personally hold. Without this, `role.update` is equivalent to super admin, and the 20-mark permission area collapses. |
| Escalation via user creation | Same subset rule applied to `POST /admin/users`. |
| Self-elevation | A caller cannot assign a role to themselves that they could not otherwise grant - the subset rule covers it, since the check is against the caller's own permissions, not the target's. |
| Locking out the deployed instance | `LAST_SUPER_ADMIN` guard on role change and deactivation. Directly protects against the brief's "a deployed application that errors on load" deduction. |
| Admin console reachable by a vendor | Route-level `useCan` plus server guards on every endpoint. A vendor pasting `/admin` sees an access page and their API calls 403. |
| Untraceable administrative action | Force-cancel and vendor rejection both require a reason and both stamp the actor. |
| Reading another admin's password | Passwords are never returned; sub-admin creation takes a password and returns only the user. |

## Implementation order

- Permission-driven nav and the admin layout shell first - every subsequent screen hangs
  off it, and it is what makes the restricted-sub-admin demo visible.
- Roles + permissions screens next. They are the highest-value screens in the module and
  the ones the brief describes in most detail.
- The cross-vendor booking list, reusing `common/pagination.ts`.
- Force-cancel, wired through M6's cancel.
- Dashboard last. It is the easiest to build and the least graded, and its numbers only
  become meaningful once the seed has bookings and payments in assorted states.

## Risks and edge cases

- **The subset rule is the single most important line in this module.** Omitting it makes
  every other permission control cosmetic, and it is exactly the hole a reviewer probes
  with curl. Written in M2, applied here on three routes.
- **"Bookings today" across timezones** will be questioned in the walkthrough. Answer
  chosen and echoed in the response: a single configured admin display timezone. Alternative
  - counting in each vendor's own zone - is more correct and unexplainable in a stat card.
  Goes in DECISIONS.md.
- **Revenue from the ledger, not from bookings.** Easy to get wrong and produce a number
  that includes uncollected `PAY_AFTER` balances, which is a plausible-looking lie. The
  integration test asserts a scenario with one collected and one outstanding booking.
- **A role editor that saves a partial checkbox state wipes permissions.** The client must
  send the full set; the single-slug revoke route from M2 exists so the live demo never
  goes through the editor.
- **Deactivating a user does not invalidate their existing access token** - it lives up to
  15 minutes. Acceptable and documented; the alternative is a token denylist, which is real
  work for no marks. Their refresh will fail, so the session dies within 15 minutes.
- **Free-tier cold start on the dashboard.** Four queries on a sleeping Render instance make
  the admin's first load slow. The dashboard renders skeletons rather than a blank page, and
  M10's plan covers a keep-warm ping.

## Test strategy

- Integration: the seeded catalogue moderator's token against `GET /admin/bookings`,
  `POST /roles`, `PATCH /admin/vendors/:id/approve` -> all 403. Against `GET /categories` and
  `POST /admin/services/:id/suspend` -> 2xx. This one test proves the restricted sub-admin is
  genuinely restricted.
- Integration: a sub-admin with `role.update` but not `booking.read_all` attempts to add
  `booking.read_all` to a role -> 403 `ESCALATION_BLOCKED`.
- Integration: force-cancel, then read the booking as the customer and assert the reason and
  the admin's identity are in the timeline.
- Integration: dashboard revenue with one `PAY_NOW` success, one `PAY_AFTER` outstanding,
  and one refund -> assert the exact minor-unit figure.
- Integration: attempt to demote the only super admin -> 409.
- Manual in a browser at 1280x720 and 1024x768: the force-cancel modal's submit button is
  reachable without the modal scrolling as one block.
