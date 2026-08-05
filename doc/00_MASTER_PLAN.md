# Master Plan

## The brief in one line

Three-sided services marketplace: customers book slots, vendors sell and fulfil,
admins govern. Real auth, real data-driven permissions, real booking rules, mocked money.

## What the graders actually weight

| Area | Marks | Where it lands |
| --- | --- | --- |
| Permissions | 20 | M1 + M2 |
| Booking integrity | 20 | M5 + M6 |
| Payment flow | 15 | M7 |
| Data & API design | 15 | M3 + M4 + [03_API_CONVENTIONS.md](03_API_CONVENTIONS.md) |
| Code quality | 15 | Module structure + the six tests that carry weight |
| Delivery | 10 | M10 |
| UI | 10 | M8 + M9 |

Two numbers drive the whole plan: 40 of 100 marks sit in permissions and booking
integrity, and the brief says the permissions module is **reviewed first**. So M1/M2
get built before anything customer-facing exists, and M6's capacity race gets a
committed script with its output.

## Three things that lose marks fastest

The brief's "serious deductions" list. Each one is designed into the plan, not
bolted on:

1. **Permissions only in the client.** Every protected route carries a server guard.
   The client reads `GET /me` and hides what the caller cannot do, and the plan says
   out loud that hiding is cosmetic. See [M2](features/M2_PERMISSIONS/plan.md).
2. **A slot bookable beyond capacity under concurrency.** Solved with row locks on
   materialised slot-cell counters inside one transaction, plus a committed 20-request
   script and its output. See [M6](features/M6_BOOKING_LIFECYCLE/plan.md).
3. **Prices or roles trusted from the request body.** Price is read from the
   `Offering` row at booking time and snapshotted onto the booking. Role and
   permission fields are stripped from every inbound DTO. See
   [03_API_CONVENTIONS.md](03_API_CONVENTIONS.md).

## Repository shape

```
server/                 NestJS
  prisma/               schema.prisma, migrations/, seed.ts
  src/
    common/             error filter, pagination, idempotency, money
    auth/               register, login, refresh, logout, me
    rbac/               roles, permissions, guards, ownership
    vendors/            profile, documents, approve/reject
    catalog/            categories, services, offerings
    availability/       rules, exceptions, slot generation
    bookings/           state machine, capacity, reschedule, history
    payments/           mock provider behind an interface, webhook, ledger
    admin/              dashboard counts, cross-vendor lists, force-cancel
  test/                 booking state machine, capacity race, permission guard
  scripts/race.ts       the 20-concurrent-bookings script
client/                 React + Vite
  src/lib/              api client, auth store, permission helper
  src/routes/           customer / vendor / admin route trees
doc/                    these documents
```

## Phase order

Each phase has one command that proves it. A phase is not done because it
typecheckes; it is done because the command below it printed the expected result.

### Phase 0 - Deploy an empty app (do this first, before any feature)

The brief calls leaving deployment until the end "the most common way this
assignment is submitted late." So the pipeline exists before the product does.

- **Git repo and GitHub remote first.** `git init`, `.gitignore`, initial commit, public
  GitHub repo. Nothing else in this phase can happen without it - Vercel and Render both
  deploy *from* the repo - and the brief reviews the commit history, so the incremental
  record has to start here rather than at Phase 2.
- Monorepo skeleton, `.env.example`, Neon project, Render service, Vercel project.
- API exposes only `GET /health`, which runs `SELECT 1` and reports `db: "up" | "down"`.
  A health check that does not touch the database lets a wrong `DATABASE_URL` pass this
  phase and resurface in Phase 1 disguised as a migration failure.
- Client renders a title **and calls `GET /health` cross-origin with credentials**, showing
  the result. This is the only cheap moment to catch a CORS or cookie-domain mistake.
- Render build runs `npm ci && npm run build` only. `prisma migrate deploy && prisma db seed`
  is added to the build command in **Phase 1**, once a schema and a seed exist - at Phase 0
  it exits non-zero and reds the first deploy, which is the exact failure this phase exists
  to prevent.

> **Verify:** the deployed **client** page shows `api: ok, db: up` - which proves the URLs
> resolve, CORS allows a credentialed cross-origin request, and Neon is reachable, in one
> check. `curl <api>/health` alone does not, because curl sends no `Origin` header.

### Phase 1 - Data layer

Full `schema.prisma` for every table in [01_DATA_MODEL.md](01_DATA_MODEL.md), one
initial migration, and a seed that inserts the permission catalogue and four roles.
Nothing else in the seed yet.

`prisma migrate deploy` runs from the server's **start** script, not from Render's build
command. Two reasons: the service was configured manually rather than from `render.yaml`,
so the dashboard build field is the real one and every edit there is a chance for the two
to drift - which already cost two failed deploys in Phase 0 - and `migrate deploy` is
idempotent, so running it on every boot is harmless. Deferred from Phase 0 deliberately.

> **Verify:** `npx prisma migrate reset` completes, then a query returns the seeded
> permission count and four role rows. Then the deployed `/health` still reports `db: "up"`
> after a redeploy, proving `migrate deploy` ran against Neon.

### Phase 2 - M1 Auth + M2 Permissions (build together, they are one surface)

Argon2 hashing, short access token, rotating refresh token with server-side
revocation, `GET /me` returning effective permission slugs, the permission guard,
and the ownership guard.

> **Verify:** the three "DONE WHEN" checks run as curl commands against the deployed
> API: expired access token gives 401 then the client refreshes once; duplicate email
> gives 409; a revoked refresh token mints nothing. Plus a low-privilege token on a
> privileged route gives 403.

### Phase 3 - M3 Vendor onboarding

Vendor self-register into `PENDING`, business profile with document upload to local
disk, admin approve/reject with a reason, status visible to the vendor without
re-login.

> **Verify:** a pending vendor's `POST /services/:id/publish` returns 403 with the
> pending reason in the envelope.

### Phase 4 - M4 Catalogue

Two-level categories, services with `DRAFT | PUBLISHED | SUSPENDED`, offerings with
duration and price, server-side pagination + search + filter, public catalogue
showing only published services of approved vendors.

> **Verify:** page 2 of a filtered search returns the right rows and a correct
> `total`; a signed-out `GET /services/:draftId` returns 404.

### Phase 5 - M5 Availability & slots

Weekly rules per service with capacity, date exceptions (closure and one-off
window), derived slot generation in the vendor's timezone, `next-available`.

> **Verify:** closing a date empties its slots and removing the exception restores
> them; changing an offering's duration 30 -> 60 changes the generated grid.

### Phase 6 - M6 Booking lifecycle

State machine with server-refused illegal transitions, capacity enforced by row
lock inside a transaction, atomic reschedule, cancellation policy, history rows.

> **Verify:** `npx ts-node scripts/race.ts` fires 20 concurrent bookings at a
> capacity-3 slot and prints `created=3 conflicted=17`. Output committed.

### Phase 7 - M7 Payments (mocked)

`PAY_NOW` and `PAY_AFTER`, payment records, deterministic mock tokens, idempotent
confirm, replayable webhook, refunds, cash-collected.

> **Verify:** replaying one `Idempotency-Key` twice yields one booking and one
> payment; a `tok_fail` payment leaves the slot bookable by someone else.

### Phase 8 - M8 Admin console + M9 Frontend

Dashboard counts, cross-vendor filtered booking list, force-cancel with mandatory
reason, role/permission management screens. Client screens for all three actors with
loading, empty, and error states.

> **Verify:** sign in as the restricted sub-admin in a browser; the nav shows only
> categories and service-suspend, and the roles screen is absent.

### Phase 9 - M10 Delivery

Full seed (super admin, restricted sub-admin, approved vendor, pending vendor, two
customers, services, availability, bookings in assorted states), `README.md`,
`DECISIONS.md`, Postman collection pointed at the deployed API.

> **Verify:** from a cold clone, following only the README, the app runs locally; and
> every seeded credential signs in against the **deployed** URL.

## Interleaving the client

The client is not one phase at the end. After each backend phase 2-7 lands, the
matching screens go in immediately, because the brief grades "handles loading, empty,
and error states" and those are impossible to retrofit convincingly. M9's plan lists
which screens attach to which phase.

## Cut list (goes into DECISIONS.md)

Ordered by what gets dropped first if time runs short. Every item here is tagged
stretch in the brief, so cutting all of them still leaves a full-Must submission.

| # | Item | Brief tag | Why it is safe to cut |
| --- | --- | --- | --- |
| 1 | Vendor assigns staff to a booking; staff capacity constrains slots | stretch | Second capacity dimension on top of an already-graded race. Highest cost, lowest marks. |
| 2 | Audit log of admin actions | stretch | Booking history rows already prove the pattern for the walkthrough. |
| 3 | Forgot-password flow | stretch | Auth is graded on tokens and revocation, not on reset. |
| 4 | Admin suspends a live service with a reason | stretch | Cheap; likely kept. Included in M4's plan and marked STRETCH. |

If a Must is at risk instead, the honest cut is **breadth of admin screens**, not
depth of permissions or booking integrity. A submission with every Must working
scores higher than one touching all eight modules that breaks under a second user.

## Open questions for you

1. **Cancellation policy.** The brief allows refuse-or-fee. Plan assumes: cancelling
   **inside** the free window is allowed but forfeits a service-declared fee
   percentage; outside it, full refund. Confirm or flip to refuse.
2. **Timezone source.** Plan puts the IANA timezone on the vendor profile, inherited
   by all their services. Alternative is per-service. Confirm.
3. **Slot grid granularity.** Plan uses a per-service `slotGranularityMinutes`
   (default 15) so variable offering durations share one capacity grid. See
   [M5](features/M5_AVAILABILITY_SLOTS/plan.md) for why this matters.
