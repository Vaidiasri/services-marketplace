# M10 - Delivery: Deploy, Seed, Docs (Plan)

Brief module 10 (Delivery, 10 marks) plus the submission requirements. A missing live link
or seed script blocks the review, so this module is started in Phase 0 and closed in Phase 9.

## Key decisions

- **Deploy in Phase 0, against an empty app.** The brief's explicit instruction. The
  pipeline exists before the product.
- **Vercel + Render + Neon.** All named as acceptable in the brief; Neon's free tier gives one
  Postgres reachable from both a laptop and Render, so the same seed script genuinely
  populates both.
- **One seed script, two targets.** `prisma/seed.ts` reads `DATABASE_URL`. Nothing about it is
  environment-specific, so `DATABASE_URL=<neon> npx prisma db seed` is the deployed path.
- **The seed is idempotent, via `upsert` on natural keys** (email, role slug, permission slug,
  category slug, service title + vendor). Render runs it on every deploy; a non-idempotent
  seed would either duplicate or crash the release.
- **Seed passwords come from `SEED_DEFAULT_PASSWORD`**, defaulted to a documented value. No
  password literal is committed anywhere except the README, where a reviewer needs it.
- **Migrations are applied with `prisma migrate deploy`, never `migrate dev`.** `dev` can
  prompt and can reset - one of those is fatal in a release command.
- **A monorepo with npm workspaces**, not two repositories. One commit history for the
  reviewer to read, and shared TypeScript types between `server` and `client` if they earn
  their keep.
- **Postman collection over OpenAPI.** The brief accepts either. A collection with a login
  request that captures the token into an environment variable is clickable in a way a raw
  spec is not, and clickable is what a reviewer with 45 minutes wants.
- **A GitHub Actions workflow runs typecheck and tests on push.** Not deployment - Vercel and
  Render have their own hooks - just proof the suite is green on the commits being reviewed.

## Deliverables checklist

Directly from the brief's submission section. All five are required.

| # | Deliverable | Where |
| --- | --- | --- |
| 1 | Two live URLs, no VPN or invite | Top of `README.md` |
| 2 | GitHub repository, incremental commits, access granted to `hr@bingosg.com` | Repository settings |
| 3 | `README.md` - URLs, seeded credentials, cold-clone setup | Repository root |
| 4 | Seed script populating local **and** deployed | `server/prisma/seed.ts` |
| 5 | `DECISIONS.md` - data model, race prevention, cuts, next week | Repository root |
| 6 | API reference pointed at the deployed API | `docs/postman_collection.json` + `postman_environment.json` |

## Impact map

- `package.json` (root) - npm workspaces, `dev`, `build`, `test`, `seed` scripts - add
- `server/prisma/seed.ts` - the full dataset - add
- `server/prisma/seed/` - `permissions.ts`, `roles.ts`, `users.ts`, `catalog.ts`,
  `availability.ts`, `bookings.ts`, `payments.ts` - add - split so a broken section is
  isolated and re-runnable
- `server/prisma/seed/assets/` - two sample PDFs for vendor documents, copied to
  `UPLOAD_DIR` on every seed run - add - the ephemeral-disk mitigation
- `server/src/health.controller.ts` - `GET /health` returning status and a database ping - add
- `server/render.yaml` - build and start commands, health check path - add
- `client/vercel.json` - SPA rewrite so deep links do not 404 - add
- `.env.example` (root, `server/`, `client/`) - every variable with a placeholder - add
- `.github/workflows/ci.yml` - typecheck + test on push - add
- `README.md` - add
- `DECISIONS.md` - add
- `docs/postman_collection.json` / `postman_environment.json` - add
- `server/scripts/race.ts` + `race-output.txt` - from [M6](../M6_BOOKING_LIFECYCLE/plan.md) - committed

## The seed dataset

Exactly what the brief asks for, plus enough state variety that every screen has content.

**Roles and permissions:** all 52 slugs, four roles per
[02_PERMISSION_CATALOGUE.md](../../02_PERMISSION_CATALOGUE.md).

**Users** (password from `SEED_DEFAULT_PASSWORD`):

| Email | Role | Purpose |
| --- | --- | --- |
| `super@marketplace.test` | `SUPER_ADMIN` | Bypasses everything |
| `moderator@marketplace.test` | `CATALOGUE_MODERATOR` | The restricted sub-admin. Eight permissions. Demonstrates the shrinking UI and the 403s |
| `vendor.approved@marketplace.test` | `VENDOR` | `APPROVED`, `Asia/Kolkata`, full catalogue and availability |
| `vendor.pending@marketplace.test` | `VENDOR` | `PENDING`, sits in the approval queue with two documents |
| `customer1@marketplace.test` | `CUSTOMER` | Bookings across every state |
| `customer2@marketplace.test` | `CUSTOMER` | One booking, used for the "someone else books the released slot" demo |

**A second approved vendor** in `Europe/London` with one service, purely so the
different-timezone walkthrough question can be demonstrated rather than described.

**Catalogue:** two top-level categories with two children each. Three services on the
approved vendor - one `PUBLISHED` with three offerings of different durations (30 / 45 / 60
minutes, so the granularity grid is visible), one `DRAFT` (for the signed-out-404 check), one
`SUSPENDED` with a reason.

**Availability:** weekly rules Mon-Sat with two windows on weekdays and one on Saturday,
capacity 2 on most and **capacity 3 on one specific slot the race script targets**. One
future closure and one future one-off open window on a normally-closed Sunday.

**Bookings:** at least one in each of `PENDING`, `CONFIRMED`, `COMPLETED`, `CANCELLED`,
`REJECTED`, `NO_SHOW`. The completed and no-show ones are in the past, since M6 refuses to
complete a future booking - so the seed writes those with backdated slots directly. One
booking carries a reschedule plus a cancellation in its history so the timeline DONE WHEN is
visible on arrival.

**Payments:** one `PAY_NOW` `SUCCESS` with a `CHARGE` ledger row, one `FAILED` with its
booking cancelled and cells released, one `PAY_AFTER` with an outstanding balance, one
`REFUNDED` with `REFUND` + `CANCELLATION_FEE` rows. This makes all four dashboard numbers
non-zero.

**Documents:** the two sample PDFs written to `UPLOAD_DIR` on every run.

Backdated data is computed relative to `now` at seed time, not hardcoded - so the dataset is
still sensible whenever a reviewer opens it.

## Deployment configuration

**Render (API).** Build: `npm ci && npm run -w server build`. Start:
`npx -w server prisma migrate deploy && npx -w server prisma db seed && npm run -w server start:prod`.
Health check path `/health`. Environment: `DATABASE_URL` (Neon **pooled** endpoint),
`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `MOCK_WEBHOOK_SECRET`, `CLIENT_ORIGIN`,
`UPLOAD_DIR`, `SEED_DEFAULT_PASSWORD`, `ADMIN_DISPLAY_TIMEZONE`, `NODE_ENV=production`.

**Vercel (client).** Build `npm run -w client build`, output `client/dist`, SPA rewrite to
`/index.html`. Environment: `VITE_API_URL`, `VITE_SHOW_PAYMENT_TOKENS=true`.

**Neon.** One project, one branch. The pooled connection string with an explicit
`connection_limit` in the URL - the M6 race script opens 20 concurrent transactions and the
default pool will not carry it.

**Cookies by environment:** `sameSite=none; secure` in production, `sameSite=lax;
secure=false` locally. A single boolean off `NODE_ENV`, and it must be verified in both -
this is the failure that works locally and breaks deployed.

## README structure

Order is deliberate: what a reviewer needs first comes first.

1. Both live URLs.
2. Seeded credentials table - all six accounts with role and what each demonstrates.
3. What to look at first: a three-line tour (sign in as the moderator, see the shrunken
   console; book a slot; force-cancel as super admin).
4. Mock payment tokens table, verbatim from [M7](../M7_PAYMENTS_MOCK/plan.md).
5. Cold-clone setup: prerequisites (Node version, Docker or a Postgres URL), `npm ci`,
   copy `.env.example`, `prisma migrate deploy`, `prisma db seed`, `npm run dev`.
6. Running the tests and the race script, with expected output.
7. Timezone behaviour, in two sentences, answering M5's question explicitly as the brief
   requires.
8. Architecture in one paragraph plus the module tree.

## DECISIONS.md structure

1. **Data model** - the table-and-relation list from
   [01_DATA_MODEL.md](../../01_DATA_MODEL.md), plus a Mermaid ER diagram.
2. **How the capacity race is prevented** - the `SlotCell` grid, `ensureCells` then
   `lockCells ... FOR UPDATE ORDER BY startUtc`, the re-read after the lock, and the file and
   line where it lives. Includes why read-then-write fails and why lock ordering is mandatory.
3. **The transaction boundary** - what is inside, what is deliberately outside (the provider
   call), and what happens on a crash mid-transaction.
4. **Timezones** - vendor zone is authoritative, rules stored as local weekday plus minutes,
   conversion at generation, browser never trusted for a decision.
5. **What was deliberately left out** - the cut list, each with a one-line reason: staff
   assignment, audit log, forgot-password, no payment-expiry sweeper, offset instead of keyset
   pagination, no token denylist on user deactivation.
6. **Judgement calls that could reasonably go the other way** - fee instead of refusal on late
   cancellation; a failed refund not reinstating a booking; a revoked vendor keeping fulfilment
   routes; a single admin display timezone; `READ COMMITTED` plus row locks instead of
   `SERIALIZABLE`.
7. **What I would build next given another week**, ordered: staff and resource capacity,
   an admin audit log, a payment expiry sweeper, keyset pagination with a proper search index,
   notification emails, and a real provider adapter behind the existing port.

## Error handling

| Operation | Failure | Behaviour |
| --- | --- | --- |
| Render release | `migrate deploy` fails | Release aborts, previous version stays live. Never auto-reset a database in a release command |
| Render release | Seed fails midway | Idempotent upserts mean a re-run completes it. Each seed section is independently re-runnable |
| Render | Instance asleep | `/health` keep-warm ping every 10 minutes from a free cron; the client also renders a waking state |
| Neon | Connection limit reached | Pooled endpoint plus explicit `connection_limit`. The race script is the real test of this |
| Deployed app | Missing environment variable | The API validates its full environment at boot with a Zod schema and fails loudly with the variable name, rather than 500ing on first use |
| Uploads | Disk wiped by redeploy | Seed rewrites sample assets each run; a missing file returns 410 and the UI degrades |
| CORS | Origin mismatch after a Vercel preview deploy | `CLIENT_ORIGIN` accepts a comma-separated list so preview URLs can be added |
| Cold clone | Wrong Node version | `engines` in `package.json` and `.nvmrc`; documented as a prerequisite |
| Postman | Token expired mid-session | The collection has a `POST /auth/refresh` request and a pre-request script that logs in when the token variable is empty |

## Security

| Threat | Mitigation |
| --- | --- |
| Committed `.env` or live credentials | `.gitignore` covers `.env`, `.env.local`, `.env.*.local`, `uploads/`. Only `.env.example` with placeholders is committed. Verified with `git check-ignore -v` before the first push and with a secret scan before submission |
| Real secrets in the README | Only seeded **test** credentials against a throwaway database. Production JWT secrets exist solely in Render's environment |
| Weak seed password on a public URL | Documented as a deliberate assignment trade-off in DECISIONS.md. The instance holds no real data |
| Uploads served as static files | `UPLOAD_DIR` is outside any static mount; documents go through an authenticated route |
| Webhook endpoint public on the internet | HMAC-verified with `MOCK_WEBHOOK_SECRET` from the environment |

## Implementation order

- Phase 0: monorepo, `/health`, `.env.example`, Neon, Render, Vercel, first deploy. Nothing
  else until both URLs answer.
- Phase 1: seed sections for permissions and roles. Everything downstream needs them.
- After each backend phase: extend the seed with that module's data, so the seed grows with
  the app instead of being written from nothing on the last day.
- Phase 9: the two documents, the Postman collection, the final seed pass, and a full verify
  against the deployed URLs.
- Commit at each verified step, per the brief's commit-history review.

## Risks and edge cases

- **Backdated seed data versus M6's guards.** The seed cannot go through the API to create a
  `COMPLETED` booking in the past, because `complete` refuses future bookings and the API
  refuses past slots. The seed writes directly through Prisma, bypassing the state machine -
  correct for a fixture, but it means the seed must construct `SlotCell` and
  `BookingSlotCell` rows itself, or capacity accounting will disagree with the bookings that
  exist. This is the most likely seed bug and it surfaces as slots that look free but are not.
- **The seed running on every Render deploy** must never destroy an admin's runtime edits. All
  writes are `upsert` on natural keys, and `Role` permission sets for **non-system** roles are
  created-if-absent, never overwritten.
- **`prisma db seed` needs the `prisma` block in `package.json`** and `ts-node` available in
  production dependencies, or the release command fails only on Render and works locally.
- **Vercel SPA rewrite.** Without it, a reviewer refreshing on `/admin/bookings` gets a 404,
  which reads as a broken deployment.
- **A cold clone on a different OS.** These docs were written on Windows; the README's commands
  must work in PowerShell and bash. No `&&` chains that assume one shell, and no Unix-only
  paths in scripts.
- **The race script against the deployed API** may hit Render's request concurrency limits
  rather than the database lock, producing a misleading result. Run it both ways - directly
  against the Neon database and through the deployed HTTP API - and commit both outputs with
  a note on what each proves.
- **Access for `hr@bingosg.com`** must be granted before submission if the repository is
  private. Easy to forget and it blocks the entire review.

## Test strategy

- Cold-clone rehearsal: clone into a fresh directory, follow the README literally with
  nothing cached, and reach a running app. Do this once before submission and fix whatever the
  README omitted. The brief scores a README that fails this.
- Deployed credential check: sign in as all six seeded accounts against the **deployed** API,
  scripted so it is repeatable after every release.
- `GET /health` asserted to include a real database round trip, so a green health check cannot
  hide a dead database.
- The M6 race script run against the deployed API, output committed.
- Environment schema test: boot with a variable missing and assert a clear failure naming it.
- `git check-ignore -v` on `.env` and `uploads/`, plus a secret scan, before the final push.
