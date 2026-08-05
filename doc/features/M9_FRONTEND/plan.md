# M9 - Frontend Shell & Screens (Plan)

Brief module 09 (UI, 10 marks). Visual polish is only 5 of 100, so the effort goes into
loading / empty / error states, permission-driven navigation, and the booking flow.

## Key decisions

- **React 18 + Vite + Tailwind + TanStack Query**, per the brief's reference stack.
  TanStack Router for typed file-based routing, or React Router if setup friction appears -
  routing choice is not graded.
- **One app, three route trees**, split by layout and permission rather than by build.
- **TanStack Query owns all server state. No Redux, no Zustand for API data.** The only
  client state that exists outside Query is the in-memory access token.
- **The access token lives in a module-scoped variable, never `localStorage`.** XSS cannot
  read it, and it dies with the tab. The refresh cookie is what survives a reload.
- **One `apiFetch` wrapper is the only thing that talks to the network.** Refresh, error
  envelope parsing, and the idempotency header all live there, so no screen implements them.
- **Every list screen uses one `<DataState>` wrapper** taking `isLoading`, `isError`,
  `isEmpty` and rendering skeleton / error / empty / children. Uniform states become
  structural rather than a per-screen discipline that decays.
- **Money is formatted in exactly one helper.** `formatMinor(340000, 'INR')` -> `3,400.00`.
  No component divides by 100 on its own.
- **Times are formatted in exactly one helper**, which always appends the vendor's timezone
  label.
- **A visible payment-token selector in the booking flow** when
  `VITE_SHOW_PAYMENT_TOKENS` is on - so a reviewer can trigger `tok_fail` from the UI
  without curl. Enabled on the deployed instance deliberately, and mentioned in the README.

## Route map

| Route | Audience | Screens |
| --- | --- | --- |
| `/` `/services` `/services/:id` | public | Catalogue with search, filters, pager; service detail with offerings and slot picker |
| `/login` `/register` `/register/vendor` | public | Forms |
| `/book/:serviceId` | `booking.create` | The 4-step booking flow |
| `/my/bookings` `/my/bookings/:id` | `booking.read` | List with status filter; detail with timeline, reschedule, cancel |
| `/vendor/pending` | vendor, not approved | The only screen a pending or rejected vendor gets |
| `/vendor/services` `/vendor/services/:id` | `service.create` + approved | List, editor, offerings |
| `/vendor/services/:id/availability` | `availability.manage` | Weekly rule grid, exception calendar, generated-slot preview |
| `/vendor/bookings` | `booking.confirm` | Queue with confirm / reject / complete / no-show |
| `/admin/*` | permission-driven | See [M8](../M8_ADMIN_CONSOLE/plan.md) |

## Impact map

- `client/src/lib/api.ts` - `apiFetch`, `refreshOnce` - add - **the** network boundary
- `client/src/lib/auth.tsx` - `AuthProvider`, `useMe`, `useLogin`, `useLogout` - add
- `client/src/lib/permissions.ts` - `useCan(slug)`, `<Can slug>` - add
- `client/src/lib/nav.ts` - `buildNav(permissions)` - add - shared with M8
- `client/src/lib/money.ts` - `formatMinor` - add
- `client/src/lib/time.ts` - `formatSlot(startUtc, tz)`, `formatRelative` - add
- `client/src/components/DataState.tsx` - add - the loading/empty/error wrapper
- `client/src/components/Skeleton.tsx`, `EmptyState.tsx`, `ErrorState.tsx` - add
- `client/src/components/Pager.tsx` - add - bound to the shared `meta` envelope
- `client/src/components/SlotPicker.tsx` - add - from [M5](../M5_AVAILABILITY_SLOTS/plan.md)
- `client/src/components/BookingTimeline.tsx` - add - from [M6](../M6_BOOKING_LIFECYCLE/plan.md)
- `client/src/components/Modal.tsx` - add - **scrollable body, fixed footer** (see Risks)
- `client/src/routes/**` - all screens above - add
- `client/vite.config.ts`, `tailwind.config.js`, `.env.example` (`VITE_API_URL`, `VITE_SHOW_PAYMENT_TOKENS`) - add

## Algorithms

### `apiFetch`

1. Attach `Authorization: Bearer <in-memory token>` and `credentials: 'include'`.
2. Attach `Idempotency-Key: crypto.randomUUID()` on `POST /bookings` and
   `POST /payments/*/confirm`, generated **once per user intent** and reused across retries -
   a key regenerated on retry defeats the entire mechanism.
3. Non-2xx -> parse the `{ error: { code, message } }` envelope into a typed `ApiError`. A
   non-JSON body (a proxy's HTML 502) becomes a generic `ApiError` rather than a parse crash.
4. `401` + code `TOKEN_EXPIRED` -> `refreshOnce()`, then replay the original request exactly
   once. Any other 401 -> clear auth, redirect to login, no retry.
5. `refreshOnce` holds a module-level promise; concurrent callers await the same one. This is
   the refresh-stampede fix from [M1](../M1_AUTH/plan.md) and it is not optional.

### Booking flow

Four steps, URL-driven so a refresh does not lose progress:

1. **Offering** - selecting one refetches slots, because duration changes the grid.
2. **Slot** - calendar of derived slots with `remainingCapacity`. Query key includes
   `offeringId` and the date range; `staleTime: 0` so slots are never served from cache -
   a cached slot list is how a customer picks a seat that went hours ago.
3. **Payment mode** - `PAY_NOW` or `PAY_AFTER`, plus the token selector when enabled.
4. **Confirm** - `POST /bookings` with the idempotency key, then `POST /payments/:id/confirm`
   for `PAY_NOW`.

On `409 SLOT_FULL`: invalidate the slots query, return to step 2, and show "that time just
filled up - here are the current times". On `422 SLOT_IN_PAST`: same, with a different
message. Both are expected outcomes, not error screens.

### Permission-driven nav and route protection

`buildNav(permissions)` renders the sections. Each protected route additionally calls
`useCan`; a caller without the permission gets a "no access" page rather than a shell that
403s on every child request. `SUPER_ADMIN` short-circuits both.

The vendor layout branches on `me.vendorProfile.status`: anything other than `APPROVED`
redirects to `/vendor/pending`, which renders the submitted profile and, if `REJECTED`, the
admin's reason.

## Error handling

| Component / operation | Failure | Behaviour |
| --- | --- | --- |
| Any query | Network down / API asleep | `ErrorState` with the envelope's `message` and a working retry that refetches |
| Any query | 403 | "You do not have access to this" - not a login redirect. A 403 means signed in and refused |
| Any query | 401 non-expiry | Clear auth, redirect to login once |
| Any list | Empty result | `EmptyState` with a cause-specific sentence and, where useful, the action that fixes it |
| Catalogue search | No matches | "No services match 'x'" plus a clear-filters button - distinct from "no services exist yet" |
| Slot picker | No slots in range | "No availability in this week" plus jump-to-next-available using `next-available` |
| Booking submit | 409 `SLOT_FULL` | Refetch slots, back to step 2, specific message |
| Booking submit | 422 validation | Field errors mapped from `error.details` onto the form inputs |
| Booking submit | Request times out, outcome unknown | Retry with the **same** idempotency key. At most one booking exists either way |
| Payment | `tok_fail` | "Payment failed - the booking was cancelled and the slot released", with a re-book link |
| Payment | `tok_delay` | "Payment pending" state with a manual refresh, matching the async path |
| Vendor action | 422 `ILLEGAL_TRANSITION` | Disable the impossible action in the UI **and** show the server's message if it is somehow clicked |
| Vendor screens | Vendor pending | Redirected to `/vendor/pending`; no half-rendered workspace |
| Mutations | Any failure | Optimistic updates are **not** used on booking mutations. A rolled-back optimistic confirm on a state machine is more confusing than a brief spinner |
| Whole app | Uncaught render error | Error boundary per route tree, so one broken screen does not white-screen the app - which the brief scores as "errors on load" |

## Security

| Threat | Mitigation |
| --- | --- |
| Token theft via XSS | Access token in memory only; refresh token `httpOnly`. |
| Believing the client's permission checks are enforcement | They are not, and every screen's actions map to a server-guarded endpoint. Stated in DECISIONS.md. |
| Rendering another user's data from a stale cache | Query cache is cleared on logout and on user change, keyed by user id. |
| Secrets in the bundle | Only `VITE_`-prefixed public config. No API secret is ever referenced in client code. |
| CORS | Exact `CLIENT_ORIGIN` allowlist on the API with credentials; not `*`, which cannot carry cookies anyway. |

## Implementation order

Interleaved with the backend phases, not built at the end.

- With Phase 2 (auth + permissions): `apiFetch`, `AuthProvider`, login/register, the app
  shell, `DataState`, and `buildNav`. Everything else depends on these five.
- With Phase 3: vendor pending screen, admin vendor applications.
- With Phase 4: catalogue list + detail, vendor services + offerings, admin categories.
- With Phase 5: availability editor and slot picker.
- With Phase 6: booking flow, my-bookings, timeline, vendor queue.
- With Phase 7: payment step, outstanding balance badge, cash collection.
- With Phase 8: dashboard, admin bookings, roles, users.

## Risks and edge cases

- **Modals that scroll as one block hide their primary button** at 1024x768. Every dialog
  uses a fixed header, a `overflow-y: auto` body, and a fixed footer holding the action. This
  is verified by actually rendering at 1280x720 and 1024x768, not by reading the CSS.
- **The refresh stampede** is the highest-risk bug in the client. Six parallel queries on a
  dashboard, all 401, six refreshes, five treated as token reuse by the server, user logged
  out. The single in-flight promise in `refreshOnce` is the fix and it needs a test.
- **Cached slots.** TanStack Query's default `staleTime` would happily serve a slot list from
  a minute ago. Slots are `staleTime: 0` with a refetch on window focus.
- **Regenerating the idempotency key on retry** silently breaks the guarantee the backend
  works hard for. The key is generated when the user commits to the action and stored with
  the mutation, not inside the fetch.
- **Free-tier cold start** means the first request after idle can take 30+ seconds. Skeletons
  plus a "still waking up" message after 5 seconds; a spinner alone reads as broken, and the
  brief's deduction list includes an app that appears to error on load.
- **Vendor timezone versus browser timezone** must never be silently mixed. `formatSlot` takes
  the timezone explicitly - there is no default-to-local overload to reach for by accident.
- **Empty states that are actually errors.** A failed query must never fall through to
  `EmptyState`; `DataState` checks `isError` before `isEmpty` so a broken API cannot read as
  "no bookings yet".

## Test strategy

Automated frontend tests are not where the marks are, so this is deliberately thin and the
verification is largely manual and honest about it.

- Unit: `refreshOnce` dedupe - five concurrent 401s produce exactly one refresh call.
- Unit: `formatMinor` and `formatSlot`, including a non-local timezone.
- Manual, recorded in the PR description: each of the three actors' full journeys with the
  network throttled, confirming loading, empty, and error states on every list.
- Manual at 1280x720 and 1024x768: every dialog's primary action is reachable and clickable.
- Manual against the **deployed** URLs, not just localhost - the brief grades the deployed
  instance.
