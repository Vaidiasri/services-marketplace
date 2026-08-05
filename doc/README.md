# Services Marketplace - Documentation Index

Planning docs for the take-home assignment in [TASK_4_updated_final.md](../TASK_4_updated_final.md).

**Nothing here is code.** Every feature has two docs:

- `overview.md` - what the feature does, in plain language. Read this to check the
  behaviour matches what you want.
- `plan.md` - the technical spec: schema, endpoints, guards, edge cases, and the
  build steps with a verification for each one.

## Decisions already locked

| Decision | Choice |
| --- | --- |
| Server | NestJS 10 + Prisma + PostgreSQL |
| Client | React 18 + Vite + Tailwind + TanStack Query |
| Hosting | Vercel (client) + Render (API) + Neon (database) |
| Scope policy | Every `Must` planned in full; stretch items marked `STRETCH` and droppable |
| Money | Integer minor units (paise), currency `INR` |
| Timestamps | Stored UTC; slot maths done in the vendor's IANA timezone |

## Read in this order

| # | Doc | What it settles |
| --- | --- | --- |
| 0 | [00_MASTER_PLAN.md](00_MASTER_PLAN.md) | Phase order, what gets cut, the one command that proves each phase |
| 1 | [01_DATA_MODEL.md](01_DATA_MODEL.md) | Every table and relation. All feature docs point here |
| 2 | [02_PERMISSION_CATALOGUE.md](02_PERMISSION_CATALOGUE.md) | The full permission slug list and the four seeded roles |
| 3 | [03_API_CONVENTIONS.md](03_API_CONVENTIONS.md) | Error envelope, pagination, validation, idempotency header |

## Features

Ordered by build sequence, not by the brief's module numbers. The rubric weight is
shown so you can see where the marks are.

| Module | Feature | Marks area | Docs |
| --- | --- | --- | --- |
| M1 | Accounts & authentication | Permissions (20) | [overview](features/M1_AUTH/overview.md) - [plan](features/M1_AUTH/plan.md) |
| M2 | Roles & permissions | Permissions (20) | [overview](features/M2_PERMISSIONS/overview.md) - [plan](features/M2_PERMISSIONS/plan.md) |
| M3 | Vendor onboarding | Data & API (15) | [overview](features/M3_VENDOR_ONBOARDING/overview.md) - [plan](features/M3_VENDOR_ONBOARDING/plan.md) |
| M4 | Service catalogue | Data & API (15) | [overview](features/M4_CATALOGUE/overview.md) - [plan](features/M4_CATALOGUE/plan.md) |
| M5 | Availability & slots | Booking integrity (20) | [overview](features/M5_AVAILABILITY_SLOTS/overview.md) - [plan](features/M5_AVAILABILITY_SLOTS/plan.md) |
| M6 | Booking lifecycle | Booking integrity (20) | [overview](features/M6_BOOKING_LIFECYCLE/overview.md) - [plan](features/M6_BOOKING_LIFECYCLE/plan.md) |
| M7 | Payments (mocked) | Payment flow (15) | [overview](features/M7_PAYMENTS_MOCK/overview.md) - [plan](features/M7_PAYMENTS_MOCK/plan.md) |
| M8 | Admin console | UI (10) | [overview](features/M8_ADMIN_CONSOLE/overview.md) - [plan](features/M8_ADMIN_CONSOLE/plan.md) |
| M9 | Frontend shell & screens | UI (10) | [overview](features/M9_FRONTEND/overview.md) - [plan](features/M9_FRONTEND/plan.md) |
| M10 | Delivery: deploy, seed, docs | Delivery (10) | [overview](features/M10_DELIVERY/overview.md) - [plan](features/M10_DELIVERY/plan.md) |

## Review status

Tick a row once the plan matches what you want. I do not start a module until its
row is ticked.

| Module | Overview approved | Plan approved | Implemented |
| --- | --- | --- | --- |
| M1 Auth | [ ] | [ ] | [ ] |
| M2 Permissions | [ ] | [ ] | [ ] |
| M3 Vendor onboarding | [ ] | [ ] | [ ] |
| M4 Catalogue | [ ] | [ ] | [ ] |
| M5 Availability & slots | [ ] | [ ] | [ ] |
| M6 Booking lifecycle | [ ] | [ ] | [ ] |
| M7 Payments | [ ] | [ ] | [ ] |
| M8 Admin console | [ ] | [ ] | [ ] |
| M9 Frontend | [ ] | [ ] | [ ] |
| M10 Delivery | [ ] | [ ] | [ ] |
