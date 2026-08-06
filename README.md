# Services Marketplace

A three-sided booking marketplace: customers browse and book, vendors list services and manage
their calendar, admins approve vendors and police the catalogue. Real authentication, real
data-driven permissions, real booking rules, mocked money.

> **Scope, stated plainly.** The API implements all of this and is covered by 404 assertions.
> The **web app covers the customer journey end to end** - browse, filter, pick a slot, book,
> pay, view the status timeline, cancel - plus the vendor booking queue and the admin vendor
> approval queue. What it does **not** have a screen for yet: vendor service and availability
> editing, category management, and the roles-and-permissions console. Those are fully
> implemented and tested in the API; they are simply driven by curl rather than by a form.
> Nothing described below is a screen that does not exist.

| | |
| --- | --- |
| **Web app** | <https://services-marketplace-server.vercel.app> |
| **API** | <https://services-marketplace-bdf2.onrender.com> |
| **API health** | <https://services-marketplace-bdf2.onrender.com/health> |

> The API is on Render's free tier and sleeps after inactivity. The first request can take
> **30-50 seconds** to wake it. `/health` is the cheapest way to wake it before a walkthrough.

## What to look at first

1. **<https://services-marketplace-server.vercel.app/services>** - the catalogue. Search, filter by
   category, set a price ceiling, page through. All server-side.
2. Open a service, pick a slot, and book as `customer1@marketplace.test`. Choose **Pay now**
   and the *card that is declined* to watch the booking cancel and its slot come back.
3. Sign in as `vendor@marketplace.test` and confirm or decline it from the booking queue.
4. Sign in as `moderator@marketplace.test` and go to `/admin/vendors`. The link is not in the
   navigation, and typing the URL is refused by the server - that is the permission model, not
   a client-side check.

## Seeded accounts

Every seeded account uses the same password: **`TestPass!2026`**

| Email | Role | What it demonstrates |
| --- | --- | --- |
| `super@marketplace.test` | Super admin | Bypasses every permission check by role slug, holding zero permission rows |
| `moderator@marketplace.test` | Catalogue moderator | A restricted sub-admin: no `role.*`, no `vendor.approve`, no `booking.read_all` |
| `vendor@marketplace.test` | Approved vendor | Two published services, a week of availability, bookings in five states |
| `pending@marketplace.test` | Pending vendor | Refused by every vendor write route with `VENDOR_PENDING_APPROVAL` |
| `customer1@marketplace.test` | Customer | Has a pending and a completed booking |
| `customer2@marketplace.test` | Customer | Has a confirmed, a cancelled and a no-show booking |

Override the password by setting `SEED_PASSWORD` before seeding.

## Running from a cold clone

### Prerequisites

- **Node 22.18** or newer (`.node-version` pins it)
- A **PostgreSQL 14+** database. Neon works and is what the deployment uses.

### 1. Install

```bash
git clone <this repo>
cd project
npm install          # npm workspaces installs both server/ and client/
```

`.npmrc` sets `include=dev`. Without it a production install skips the Nest CLI and the build
fails with `sh: 1: nest: not found`.

### 2. Configure the server

```bash
cp server/.env.example server/.env
```

Then edit `server/.env`:

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Use the **pooled** Neon endpoint. Keep `connection_limit=25&pool_timeout=20` - see the note below |
| `JWT_ACCESS_SECRET` | yes | Any long random string |
| `JWT_REFRESH_SECRET` | yes | A **different** long random string |
| `CLIENT_ORIGIN` | yes | `http://localhost:5173` locally; comma-separated list in production |
| `PORT` | no | Defaults to 3000 |
| `UPLOAD_DIR` | no | Defaults to `uploads/vendor-documents` |
| `SEED_PASSWORD` | no | Defaults to `TestPass!2026` |

> **`connection_limit` is load-bearing.** Every booking transaction holds a connection while it
> queues for a row lock, so a limit of 10 makes `scripts/race.ts` fail with Prisma `P2024`
> (pool timeout) instead of the clean 409 the concurrency test expects.

### 3. Migrate and seed

```bash
cd server
npx prisma migrate deploy    # or `migrate dev` if you intend to add migrations
npx prisma db seed
```

> **Run migrations against the DIRECT (unpooled) Neon endpoint** - the host *without*
> `-pooler`. `prisma migrate` takes a session-scoped Postgres advisory lock, and Neon's pooled
> endpoint is PgBouncer in transaction mode, where that lock is unreliable. Against the pooled
> host it fails with `P1002: Timed out trying to acquire a postgres advisory lock`.
>
> Migrating is a **deploy step, not a boot step**. The server's `start` script deliberately does
> not migrate: several instances booting at once would all race for the same advisory lock, and
> the losers would crash-loop on a database that is already up to date.

The seed is **idempotent** - every write is an upsert and role permission sets are reconciled
rather than appended, so it is safe to run repeatedly and on every deploy. It creates the
permission catalogue, four system roles, a two-level category tree, the six accounts above,
two published services with availability, and five bookings spanning `PENDING`, `CONFIRMED`,
`COMPLETED`, `CANCELLED` and `NO_SHOW`.

### 4. Configure the client

```bash
cp client/.env.example client/.env    # set VITE_API_URL=http://localhost:3000
```

### 5. Run

```bash
npm run dev --workspace=server    # API on http://localhost:3000
npm run dev --workspace=client    # web app on http://localhost:5173
```

## Tests

```bash
cd server
npm test
```

Runs route coverage, four unit suites and seven integration suites against a live API -
**404 assertions**. The integration suites need the server running and the database seeded.

| Command | What it covers |
| --- | --- |
| `npm run test:routes` | Enumerates every route Nest registered and fails if one carries no permission decorator |
| `npm run test:time` | IANA conversion and both DST transitions |
| `npm run test:slots` | The slot generator against fixtures, no database |
| `npm run test:bookings` | The state machine over all 108 `(from, to, actor)` triples, and the cancellation policy |
| `npm run race` | **The concurrency proof.** 20 simultaneous bookings at a capacity-3 slot |

### Payments are mocked, and every outcome is triggerable

There is no real or sandbox gateway. `POST /payments/:id/confirm` takes a token that decides
the outcome deterministically, so a reviewer can trigger a decline on demand rather than wait
for a random one:

| Token | Result | What it demonstrates |
| --- | --- | --- |
| `tok_success` | Payment `SUCCESS` | The default when no token is sent |
| `tok_fail` | Payment `FAILED`, reason `card_declined` | Booking is cancelled and **its slot becomes bookable again**, in the same transaction |
| `tok_delay` | Stays `INITIATED` | Resolve it by posting a signed webhook |
| `tok_refund_fail` | Charges, but the refund is rejected | The refund-failure path is recorded, not swallowed |

`POST /payments/webhook` is public but HMAC-verified over the raw body with
`MOCK_WEBHOOK_SECRET` - the signature *is* the authentication, and an unsigned delivery is a
401. Redelivery is deduplicated by a unique index on `eventId`, not by reading the payment's
status, because two simultaneous deliveries would both read `INITIATED` and both apply.

### The concurrency proof

`server/scripts/race.ts`, with its committed output in `server/scripts/race-output.txt`:

```text
created=3 conflicted=17 other=0
   3 x 201 CREATED
  17 x 409 SLOT_FULL

SlotCell: capacity=3 bookedCount=3
Booking rows for that slot: 3
```

Capacity is enforced by `SELECT ... FOR UPDATE` on a counter row inside one transaction, never
by counting bookings. `server/src/bookings/capacity.repository.ts` is the only file in the
project containing raw SQL.

## How it is built

```text
server/          NestJS 10, Prisma 6, PostgreSQL
  src/auth/          argon2id, access + rotating refresh tokens
  src/rbac/          permission resolution, ownership helpers
  src/vendors/       onboarding, documents, the approved-vendor gate
  src/catalog/       categories, services, offerings, full-text search
  src/availability/  rules, exceptions, the pure slot generator
  src/bookings/      state machine, capacity locking, cancellation policy
client/          React 18, Vite, Tailwind, shadcn/ui, TanStack Query, axios
  src/routes/        catalogue, service detail + slot picker, bookings,
                     vendor queue, admin approvals - see the scope note at the top
doc/             The plan this was built from, module by module
```

### Decisions worth knowing

- **Permissions are rows, not enums.** A role's permissions are resolved per request, so
  revoking one takes effect on the caller's next request with no redeploy. `SUPER_ADMIN` holds
  **zero** permission rows and bypasses by role-slug short-circuit - "holds every permission"
  stops being true the moment a permission is added.
- **Three independent gates**, in order: permission → ownership → vendor status. Holding
  `service.publish` lets a vendor publish *their own* service *if approved*. Each gate answers a
  different question and each has its own failure code.
- **Access tokens carry no permissions**, only `{ sub, roleSlug, jti }`. A token minted before an
  approval keeps working after it, because status is read per request.
- **Slots are derived on every read.** Weekly rules minus date exceptions minus consumption.
  There is no slot table; `SlotCell` is a consumption counter created lazily on first booking.
- **A per-service grid, not one row per bookable start.** A 60-minute booking at 09:00 and a
  30-minute booking at 09:30 collide on shared cells. Without the grid the 09:30 start looks free
  while the vendor is mid-appointment.
- **Money is integer minor units everywhere.** No floats. `priceMinor` is snapshotted onto the
  booking from the offering row inside the transaction, and no DTO has a price field, so a price
  cannot arrive from a request body.
- **Timestamps are `timestamptz`, stored UTC.** Availability is stored as local weekday plus
  minutes-from-midnight so a vendor's opening hours survive DST unchanged.
- **404, not 403, for hidden resources.** A draft service or another tenant's booking answers
  404, because confirming that an id exists is itself a leak.
- **Validation is Zod `.strict()` at the boundary** - an unexpected key is a 422, never ignored.
  Every error shares one envelope: `{ error: { code, message, details?, requestId } }`.

Trade-offs and the reasoning behind them are in [`doc/`](doc/), one document per module, written
before the code. Divergences found while implementing are recorded in the commit that made them.

### Known limits

- **Offset pagination**, not keyset. What the brief asks for, and fine at seed scale; it would
  need revisiting for a large catalogue.
- **Sorting by price is not offered.** Prisma cannot order by an aggregate over a relation, and
  doing it by hand would mean a second query path around the single visibility rule that keeps
  drafts out of the catalogue. Price *filtering* works.
- **Render's disk is ephemeral**, so vendor documents uploaded before a redeploy answer 410
  `FILE_GONE` afterwards. Service image upload is deliberately not built for the same reason.
- **Staff assignment** and a few other brief-tagged stretch items are not built.
