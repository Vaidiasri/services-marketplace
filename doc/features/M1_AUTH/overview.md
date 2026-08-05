# M1 - Accounts & Authentication (Overview)

## What this feature does

It is the front door. Someone arrives with no account and leaves with a session that
the rest of the system can trust, and that session can be ended for real.

Three kinds of people sign up in three different ways:

- A **customer** registers and is immediately usable. They fill in email, password,
  name, and they can browse and book straight away.
- A **vendor** registers and is immediately *un*usable. The account exists, they can
  sign in, but it sits in a pending state and every door is closed until an admin
  opens it. They see their status and nothing else.
- An **admin** cannot register at all. There is no public route that creates one. An
  admin exists only because the seed created it, or because another admin with the
  right permission created it.

## What a session looks like

Two tokens, on purpose.

The **access token** is short-lived - fifteen minutes - and is what every API call
carries. Because it expires quickly, a stolen one is worth very little. Because it
expires quickly, the app would be unusable if the user had to keep logging in, which
is what the second token is for.

The **refresh token** lives seven days in a cookie the JavaScript cannot read. When
the access token expires, the client quietly exchanges the refresh token for a new
access token, one time, and retries the request that failed. The user sees nothing.
If that one retry also fails, the user is sent to the login screen rather than being
left in a loop.

**Logging out actually logs you out.** This is the part most implementations get
wrong. The refresh token is not just deleted from the browser - it is marked revoked
in the database, so presenting it again mints nothing. Every refresh also rotates the
token, so a refresh token can be used exactly once. If an old one shows up after
rotation, that is a signal something is wrong and the whole chain for that user is
revoked.

## Who am I, and what may I do

One endpoint, `GET /me`, answers both. It returns the caller's identity, their role,
and the flat list of permission slugs they effectively hold.

The client builds its entire navigation from that response. It does not contain a
hardcoded list of admin menu items - it renders what the permissions say. The
consequence is the one the brief asks for: when an admin strips a permission from a
role, the affected user's menu shrinks on their next refetch, with nobody deploying
anything.

The list of permissions is deliberately **not** baked into the access token. If it
were, revoking a permission would not take effect until the token expired. So `/me`
and the server-side guard both read permissions from the database on each request.

## What it refuses to do

- Store or log a password in the clear, ever. Passwords are hashed with Argon2id, and
  the hash never leaves the database row.
- Return a database constraint error when someone registers with an email already in
  use. That is a clean 409 with a readable message.
- Accept an expired access token. That is a 401, always, with no grace period.
- Let a request body decide a role. Someone posting `"role": "SUPER_ADMIN"` to the
  register endpoint gets a validation error, not an admin account.
- Reveal whether an email exists on a failed login. Wrong password and unknown email
  return the same response.

## How you will know it works

- Sign in, wait for the access token to expire, click something. It works, and the
  network tab shows one refresh call slipped in between.
- Register with an email that already exists. Clean 409.
- Log out, then replay the old refresh token with curl. It mints nothing.
- Look at the users table. Every `passwordHash` is an Argon2 string, no plaintext anywhere.

## Related

- Technical spec: [plan.md](plan.md)
- The permission layer this hands off to: [M2](../M2_PERMISSIONS/overview.md)
- The pending-vendor state this creates: [M3](../M3_VENDOR_ONBOARDING/overview.md)
