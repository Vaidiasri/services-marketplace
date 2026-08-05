TAKE-HOME ASSIGNMENT - FULL-STACK

## Build a services marketplace

A working slice of a three-sided marketplace: customers book services, vendors sell and fulfil them, admins govern the whole thing. Real auth, real permissions, real booking rules — mocked money.

Tue 4 Aug

Wed 5 Aug, 18:00

00

## Read this before start you

This document describes more than you can finish by Tuesday. That is deliberate.

Everything below is tagged not against total surface area.

## HOW WE SCORE A PARTIAL SUBMISSION

A submission with every Must working correctly and nothing else scores higher than one that touches all eight modules and breaks under a second concurrent user. Cut scope openly — record what you skipped in DECISIONS.md , and why. Undocumented read as defects; documented ones read as judgement. gaps

stretch and we grade against that ordering,

01

## The product, in one paragraph


A vendor — a salon, a home-cleaning company, a repair shop — lists a service. Each service carries one or more offerings (a name, a duration, a price: “Haircut, 45 min, 3400”). The vendor declares when they are open, and the system turns that into bookable slots. A customer finds a service, picks a slot, and books — paying up front or after the appointment. The vendor confirms, delivers, and marks it complete. An admin sits above all of it: approving vendors, policing the catalogue, and holding the permissions that decide who may do what.

## The three actors

| ACTOR CAN DO MUST NEVER BE ABLE TO |   |
| --- | --- |
| Customer Sign up, browse published services, view See another customer's booking; slots, book, pay, reschedule, cancel, see see any vendor or admin screen |   |
| their own bookings |   |
| Vendor Apply for an account, manage own services Touch another vendor's services and offerings, set availability, or bookings; publish before |   |
| confirm/reject/complete bookings, mark being approved cash collected Admin Approve or reject vendors, manage Exceed the permissions granted categories, suspend a service, view all to their role — only a super bookings, force-cancel with a reason, create admin bypasses checks |   |
| sub-admins |   |

Mi

## Accounts & authentication

- Sign up and log in for all three roles. A customer self-registers; a vendor self- registers into a pending state; an admin is created only by another admin or by the seed.

- « Passwords hashed with bcrypt or argon2 — never stored or logged in the clear.

- « Short-lived access token plus a refresh token, with a working refresh endpoint and a logout that actually invalidates the refresh token server-side.


- A GET /me that returns the caller's identity, role, and effective permission slugs. The frontend builds its navigation from this response.

- stretch Forgot-password flow with a single-use, expiring token. Print the reset link to the console instead of sending mail.

## DONE WHEN

- \+ An expired access token is rejected with 401 , and the client transparently refreshes once before giving up.

- Registering an already-used email returns a clean 409 , not a database constraint error.

- After logout, the old refresh token no longer mints access tokens.

## Roles & permissions

This module is reviewed first. Role strings alone are insufficient; we expect a permission layer beneath them.

- Permissions are granular slugs in the shape resource.action: service.create, booking.cancel, vendor.approve, role.update , and so on. Seed the full catalogue.

- code — an admin can create a Catalogue Moderator role holding only category.* and service.suspend , assign it to a sub-admin, and that sub-admin's UI and API surface shrink to match. is a named bundle of permission slugs. Roles are data, not an enum in the

- SUPER_ADMIN bypasses every check. Everyone else is checked.

- Enforcement lives on the server, in a guard or middleware, on every protected route. The frontend hides what the caller cannot do — but hiding is cosmetic and never the enforcement.

- Ownership is checked separately from permission: holding service.update lets a vendor edit their own service, not anyone's.

## DONE WHEN


- \+ A privileged endpoint called directly with a lower-privileged token returns 403 . This is tested against the deployed API.

- \+ Revoking a permission from a role changes what that user can do on their next request, with no redeploy and no code change.

- \+ Vendor A requesting Vendor B's booking by id gets 463 or 404 , never the record.

## n3

## Vendor onboarding

- « A vendor signs up and submits a business profile: name, contact, address, and one or more documents. File storage can be local disk or a stored filename; object storage is not required.

- The account sits in PENDING . An admin with vendor.approve moves it to APPROVED or REJECTED, and a rejection carries a reason the vendor can read.

- A pending or rejected vendor can sign in and see their status, and can do nothing else.

## DONE WHEN

- \+ A pending vendor cannot publish a service — blocked at the API, not just missing a button.

- \+ Approval is visible to the vendor without them logging out and back in.

## ny

## Service catalogue

- \+ Admin manages categories — two levels of nesting is enough.

- « A vendor creates a service under a category: title, description, category, images (filenames are fine), and a status of DRAFT, PUBLISHED , or SUSPENDED .

- « A service has one or more offerings. Each offering has a name, a duration in minutes, a price, and an active flag. Duration matters — it drives slot length in M5.


- Only PUBLISHED services belonging to an APPROVED vendor appear in the public catalogue.

- « Listing endpoints paginate, search, and filter server-side. Fetching every row and filtering in the client does not satisfy this requirement.

- « stretch Admin suspends a live service with a reason; existing confirmed bookings survive, new bookings stop.

## DONE WHEN

- « service is unreachable by direct URL for a signed-out visitor.

- « Page 2 of a filtered search returns the correct rows and a total count.

## ns

## Availability & slots

Slots must be derived, not stored by hand. A table of manually entered slot rows does not satisfy this module.

- A vendor sets weekly rules per service: for each weekday, zero or more open windows (Tue 09:00-13:00 and 16:00-20:00), plus a capacity — how many bookings may share one slot.

- A vendor adds date exceptions: a closure for a public holiday, or a one-off window on a normally-closed day. An exception can be removed and normal hours resume.

- Given a service and a date range, the API returns bookable slots derived from rules minus exceptions minus what is already booked. Each slot reports its remaining capacity.

- Slots in the past are never offered. A booking cannot be created for a start time that has passed — check on the server, in the vendor's timezone, not the browser's.

- . A next available endpoint returning the soonest bookable slot for a service.

## DONE WHEN

- \+ Closing a date makes its slots disappear; reopening it brings them back.


- \+ A slot with capacity 2 shows remaining: 1 after one booking and stops being offered at Zero.

- \+ Changing an offering's duration from 30 to 60 minutes changes the generated slots.

ne

## The booking lifecycle sr

The heart of the assignment. A booking moves through states, and illegal transitions must be refused by the server.

| STATE | ENTERED WHEN |   | LEGAL NEXT STATES |   |
| --- | --- | --- | --- | --- |
| PENDING | Customer books |   | CONFIRMED, REJECTED, |   |
|   |   |   | CANCELLED |   |
| CONFIRMED | Vendor | accepts | COMPLETED, CANCELLED, |   |
|   |   |   | NO_SHOW |   |
| COMPLETED |   | Vendor marks delivered | — terminal |   |
| REJECTED CANCELLED NO_SHOW | Vendor declines Either arrive | party cancels, or admin forces Vendor reports the customer did not | — terminal — terminal — terminal |   |

- Booking captures the service, the offering, the slot, the customer, the price at time of booking, and the payment mode.

- Two bookings must never exceed a slot's capacity. Two concurrent requests for the last remaining seat — one wins, one gets a clean 409 . Solve this at the database level with a transaction, a row lock, or a unique constraint. Reading-then-writing in application code is the failure we are testing for.

- Reschedule: a customer moves a PENDING or CONFIRMED booking to another slot; the old slot's capacity is released atomically as the new one is taken.


- « Cancellation policy: each service declares a free-cancellation window (say 24 hours before start). Cancelling inside the window is either refused or incurs a fee. Either behaviour is acceptable; document the rule and enforce it server-side.

- Every state change writes a history row: who, from, to, when, and an optional reason. The booking detail page shows this timeline.

- stretch Vendor assigns a staff member to a confirmed booking, and staff capacity constrains slots.

## DONE WHEN

- « Firing 20 simultaneous bookings at a slot with capacity 3 yields exactly 3 bookings. Include the script and its output in the repository.

- \+ A customer calling PATCH /bookings/:id/complete gets 403. A vendor calling it on a PENDING booking gets 422.

- \+ The timeline on a rescheduled, then cancelled, booking reads correctly start to finish.

n7

## Payments — mocked "vst

## NO REAL GATEWAY

Do not integrate Razorpay, Stripe, or any sandbox account. Write your own mock provider behind an interface. What is assessed is the structure of the payment flow — state transitions, idempotency, failure handling — since that is what survives when a real provider replaces the mock.

- Two modes, chosen per booking: PAY_NOW collects before the booking is confirmed; PAY_AFTER lets the customer book free and settle at or after service.

- A payment record carries an amount, a currency, a provider reference, and a status of INITIATED, SUCCESS, FAILED, or REFUNDED .

- The mock's outcome must be deterministic and triggerable, so both paths can be exercised on the deployed instance: a token of tok_fail fails, tok_delay stays pending, or any equivalent scheme. Document the triggers in the README.


- « The confirm endpoint is idempotent. The same Idempotency-Key replayed returns the original result and does not create a second payment or a second booking.

- Simulate the asynchronous path: a POST /payments/webhook that can be called manually to move a pending payment to success or failure, with the booking responding accordingly. The same webhook delivered twice must have no additional effect.

- A failed PAY_NOW payment must not leave a confirmed booking or a permanently held slot.

- Cancelling a paid booking inside the free window issues a refund — a status change plus a ledger row is enough.

- For PAY_AFTER, the vendor marks payment collected; the booking shows an outstanding balance until they do.

## DONE WHEN

- « A forced payment failure leaves the slot bookable by someone else.

- \+ Replaying the same confirm request twice produces one booking and one payment.

- \+ Nothing in the codebase talks to a real payment network.

## Lik]

## Admin console

- A dashboard with counts that matter: pending vendor applications, bookings today, revenue collected, payments failed.

- A cross-vendor booking list with filters for status, vendor, and date range — filtered server-side.

- Force-cancel a booking with a mandatory reason, which appears in the booking's timeline.

- Role and permission management screens: create a role, tick its permissions, assign it to a sub-admin.

- « stretch An audit log of admin actions — actor, action, target, timestamp.


## 09

## Applies to everything

- Validate request body at the boundary with a schema library. Never trust a every price, a role, or an id that arrived from the client.

- One consistent error envelope across the API, with meaningful status codes. 500 for a validation failure is a fail.

- Money in integer minor units. No floats.

- Timestamps stored in UTC; the timezone question in M5 answered explicitly in your notes.

- No secrets in the repo. Ship a .env.example .

- Tests where they carry weight. Six tests covering the booking state machine, the capacity race and the permission guard are worth more than sixty covering trivial accessors.

## Stack

Use the stack you are fastest in. For reference, ours is NestJS, Prisma and PostgreSQL on the server and React, Vite, Tailwind and TanStack Query on the client. Matching it makes the walkthrough more productive; diverging carries no penalty on the rubric. Choose a database your host supports on a free tier, since the submission must be

deployed.

The interface should be clean, consistent and usable. It does not need to be distinctive — visual polish carries 5 of the 100 available marks.

## 10

## Submission

Submit a single email containing the five items below. All of them are required; a missing live link or seed script blocks the review.

Alive, Two URLs — the frontend and the API — both reachable by us without deployed a VPN, an invite, or a local build. Free tiers are expected and entirely


|   | application. acceptable: Vercel or Netlify for the client, Render or Railway for the |
| --- | --- |
|   | API, Neon or Supabase for the database. The deployed instance must run your seed data, so we can sign in as each role the moment we open it. |
|   | A GitHub Public, or private with access granted to the address at the foot of this repository. page. Commit incrementally as you work. The commit history is reviewed, and a single end-of-assignment commit provides nothing to review. README.md . Both live URLs at the top, then the credentials for every seeded role, then setup from a cold clone: prerequisites, environment variables, migrate, seed, run. A reviewer who cannot start the project locally scores only what is deployed. A seed It creates a super admin, a restricted sub-admin, an approved vendor, a script. pending vendor, and two customers, together with services, availability, and bookings in assorted states. The same script populates both your local database and the deployed one. |
|   | DECISIONS.md . Your data model as a diagram or a plain list of tables and relations; how prevented the capacity race; what you deliberately left out; you and what would build next given another week. you An API A Postman collection or an OpenAPI specification covering the endpoints reference. built, with the base URL pointed at your deployed API. you |

Deploy early — tonight, against a nearly empty project. Leaving it until Tuesday afternoon is the most common way this assignment is submitted late.

TUESDAY, ON RECEIPT

Confirm by reply that you have the brief and can meet Wednesday evening. If the deadline is

TUESDAY TO WEDNESDAY

WEDNESDAY, 18:00


THURSDAY, AFTERNOON

11

## How we score it

| AREA | WEIGHT WHAT EARNS THE MARKS |   |
| --- | --- | --- |
| Permissions | 20 | Server-side enforcement, data-driven roles, ownership checks, no privilege escalation by curl |
| Booking integrity | 20 | State machine refuses illegal moves; capacity holds under |
| Payment flow | 15 consistent state | concurrency; slot maths is correct Both modes work, idempotency, failure and refund paths leave |
| Data & API design | 15 | Sane schema and relations, honest status codes, server-side pagination and filtering |
| Code quality | 15 meaningful tests | Clear structure, sensible boundaries, readable naming, |
| Delivery ul | 10 | Deployed and reachable; cold clone runs; seed works; decisions and trade-offs documented Usable, consistent, handles loading, empty, and error states |

## Serious deductions

- Permissions enforced only in the client, with the API left open.

- A slot bookable beyond its capacity under concurrent requests.

- Plaintext passwords, or an access token that never expires.

- x Prices, discounts or roles trusted from the request body.

- x Committed .env files or live credentials of any kind.


- x A deployed application that errors on load, or seeded credentials that do not work against it.

- x A README that does not get the project running locally.

## 12

## The walkthrough

Forty-five minutes on Wednesday afternoon, screen shared: a short demo of the deployed application, then questions on the code behind it. Expect to be asked to:

- Trace what happens between the customer confirming a booking and the row appearing in the database.

- Identify your transaction boundary, and explain the outcome if the process fails inside it.

- Show the code that decides which of two simultaneous requests wins the last available seat.

- Describe what changes, and what does not, when the mock payment provider is replaced with a real one.

- Explain how the system behaves when the vendor and the customer are in different timezones.

- Justify what you cut, and set out what you would build first given another week.

Have the project running locally as well as deployed. You may be asked to make a small change during the call.

Send submission, and any questions on scope or ambiguity, to hr@bingosg.com. your
