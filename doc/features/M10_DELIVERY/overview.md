# M10 - Delivery: Deploy, Seed, Docs (Overview)

## What this feature does

It is the difference between work that scores and work that exists.

The brief is unusually direct about this: a missing live link or seed script **blocks the
review**. A README that does not get the project running locally means a reviewer scores
only what is deployed. Seeded credentials that do not work against the deployed site are on
the serious-deductions list.

Ten marks are allocated here, but the real number is higher, because most of the other
ninety are only reachable if a reviewer can open the thing and sign in.

## Deploy first, not last

The brief says to deploy on the first night, against a nearly empty project, and calls
leaving it until the end the most common way this assignment is submitted late.

So the very first phase of work stands up the whole pipeline - client on Vercel, API on
Render, database on Neon - with an API that only answers "I'm alive" and a client that only
renders a title. Every subsequent push flows through a pipeline that already works. Nobody
discovers a build failure or a CORS problem at 5pm on the deadline.

## The seed is a product feature

Not a test fixture. It is how a reviewer experiences the application in the first thirty
seconds, and the same script runs against the local database and the deployed one.

It creates:

- A **super admin** who can do everything.
- A **restricted sub-admin** - the catalogue moderator from the brief - who can manage
  categories and suspend services and nothing else. This account exists specifically so the
  permission architecture can be demonstrated by logging in, not by explaining.
- An **approved vendor** with real services, offerings, weekly availability, and a date
  closure.
- A **pending vendor** sitting in the approval queue, so the onboarding flow can be
  exercised on arrival.
- **Two customers**, one with bookings in several states.
- Bookings that are pending, confirmed, completed, cancelled, and no-show, plus payments
  that succeeded, failed, and are outstanding.

That last part matters. A dashboard showing four zeros and a booking list with three
identical pending rows demonstrates nothing. The seed is designed so that every screen has
something interesting on it and every state in the state machine is visible somewhere.

The script is also **idempotent** - running it twice does not create two of everything, so
Render can safely run it on every deploy.

## The four documents

**README.md** opens with both live URLs and the credentials for every seeded role, because
that is what a reviewer needs in the first ten seconds. Then everything needed to run from a
cold clone: prerequisites, environment variables, migrate, seed, run. Then the mock payment
tokens, so both the success and failure paths can be reproduced by hand.

**DECISIONS.md** is the honest one. The data model as a list of tables and relations. How
the capacity race was actually prevented, and where that code lives. What was deliberately
left out, and why. What would be built next given another week.

The brief's framing is worth repeating: undocumented gaps read as defects, documented ones
read as judgement. Every cut is listed.

**The API reference** is a Postman collection with the base URL pointed at the deployed API,
covering every endpoint, organised by module, with an environment that logs in and captures
the token so a reviewer can click through rather than assemble requests.

**The commit history** is itself reviewed. Small, incremental, honestly-named commits, one
roughly per verified step in the plan. A single end-of-assignment commit provides nothing to
review and the brief says so.

## The things that quietly go wrong

Free tiers have sharp edges, and each has been planned for rather than discovered:

- The API sleeps and takes half a minute to wake. The client shows a proper waking state
  instead of looking broken.
- Uploaded files vanish on redeploy, because Render's disk is ephemeral. The seed rewrites its
  sample documents on every run, and a missing file degrades gracefully instead of erroring.
- Cross-origin cookies need different settings locally than deployed. Configured by
  environment, and verified in both.
- Database connection limits are small, and the concurrency script opens twenty at once.
  Pooled connection string, explicit limit.

## How you will know it works

- Open both URLs in a fresh incognito window. Both load. Sign in as each of the six seeded
  accounts. All six work.
- Clone into an empty directory, follow only the README, and reach a running app.
- Run the concurrency script against the deployed API. Three bookings out of twenty
  attempts.
- Import the Postman collection, log in, and click through the booking lifecycle without
  editing a single URL.

## Related

- Technical spec: [plan.md](plan.md)
- The phase order this front-loads: [00_MASTER_PLAN.md](../../00_MASTER_PLAN.md)
- The mock tokens documented in the README: [M7](../M7_PAYMENTS_MOCK/overview.md)
