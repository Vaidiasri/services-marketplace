import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { http } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Booking, Offering, Paginated, Service } from '@/lib/catalogue';

/**
 * The management side: everything a vendor does to their own catalogue and calendar, and
 * everything an admin does to categories, roles, services and bookings.
 *
 * Split from `catalogue.ts` rather than added to it because that file is the customer
 * journey - a customer's bundle has no reason to carry role-console mutations.
 *
 * Every query here is gated on `booted`. The access token lives in memory only, so a hard
 * load or a pasted URL starts with none and the session is restored from the refresh cookie
 * a moment later; a query that fires before that lands renders "Authentication required" to
 * a user who is signed in perfectly well.
 */

export type ServiceStatus = 'DRAFT' | 'PUBLISHED' | 'SUSPENDED';

/** The owner's view of a service, which carries the fields the public payload strips. */
export type OwnedService = Service & { status: ServiceStatus; suspensionReason?: string | null };

export type AvailabilityRule = {
  id?: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  capacity: number;
};

export type AvailabilityException = {
  id: string;
  date: string;
  type: 'CLOSED' | 'OPEN_OVERRIDE';
  startMinute: number | null;
  endMinute: number | null;
  capacity: number | null;
  reason: string | null;
};

export type Role = {
  id: string;
  slug: string;
  name: string;
  isSystem: boolean;
  /** Slugs, not objects - the role payload carries exactly what the guard compares. */
  permissions: string[];
  userCount: number;
};

/**
 * `GET /permissions` returns the catalogue already grouped by resource -
 * `{ booking: ['booking.cancel', ...], ... }` - so the checkbox grid renders the server's
 * own grouping instead of regrouping a flat list on every render.
 */
export type PermissionCatalogue = Record<string, string[]>;

export type AdminService = OwnedService & {
  vendorProfile: { id: string; businessName: string; city: string; state: string };
};

// ---------------------------------------------------------------- plumbing

/**
 * One mutation helper for all of it. Every write on these screens is the same shape - call
 * an endpoint, then invalidate the lists that could now be stale - and writing that out
 * fourteen times is fourteen chances to forget the invalidation.
 */
function useWrite<TInput>(
  request: (input: TInput) => Promise<unknown>,
  invalidate: QueryKey[],
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: () => {
      for (const key of invalidate) void qc.invalidateQueries({ queryKey: key });
    },
  });
}

/**
 * `booted && me` - both halves are load-bearing.
 *
 * `booted` alone only says the boot refresh finished, not that it succeeded. When it fails
 * (no cookie, or an expired one) the query fired anyway and every management screen rendered
 * "Authentication required" over an otherwise working page. Waiting for `me` means these
 * queries run only for a caller the server has actually identified.
 */
function useGated<T>(key: QueryKey, path: string, enabled = true) {
  const { booted, me } = useAuth();
  return useQuery({
    queryKey: key,
    queryFn: async () => (await http.get<T>(path)).data,
    enabled: booted && !!me && enabled,
  });
}

// ---------------------------------------------------------------- vendor: services

export function useMyServices(status?: string) {
  const qs = new URLSearchParams({ pageSize: '50', ...(status ? { status } : {}) });
  return useGated<Paginated<OwnedService>>(['my-services', status ?? 'all'], `/vendors/me/services?${qs}`);
}

export type ServiceInput = {
  title: string;
  description: string;
  categoryId: string;
  slotGranularityMinutes: number;
  freeCancellationHours: number;
  cancellationFeePercent: number;
};

export function useSaveService() {
  return useWrite<{ id?: string; body: Partial<ServiceInput> }>(
    ({ id, body }) =>
      id ? http.patch(`/services/${id}`, body) : http.post('/services', body),
    // The public catalogue too: editing a published service changes what customers see.
    [['my-services'], ['services'], ['service']],
  );
}

/**
 * Publish, unpublish and delete in one hook. They are all "act on a service by id" and the
 * server decides whether the move is legal - a service with a live booking cannot be
 * deleted, and the refusal is a 409 the screen renders rather than a state it predicts.
 */
export function useServiceAction() {
  return useWrite<{ id: string; action: 'publish' | 'unpublish' | 'delete' }>(
    ({ id, action }) =>
      action === 'delete'
        ? http.delete(`/services/${id}`)
        : http.post(`/services/${id}/${action}`),
    [['my-services'], ['services'], ['service']],
  );
}

// ---------------------------------------------------------------- vendor: offerings

export type OfferingInput = { name: string; durationMinutes: number; priceMinor: number };

export function useSaveOffering() {
  return useWrite<{ serviceId: string; id?: string; body: Partial<OfferingInput> }>(
    ({ serviceId, id, body }) =>
      id
        ? http.patch(`/offerings/${id}`, body)
        : http.post(`/services/${serviceId}/offerings`, body),
    [['my-services'], ['service'], ['slots']],
  );
}

export function useDeleteOffering() {
  return useWrite<{ id: string }>(({ id }) => http.delete(`/offerings/${id}`), [
    ['my-services'],
    ['service'],
    ['slots'],
  ]);
}

// ---------------------------------------------------------------- vendor: availability

/**
 * The endpoint answers `{ timezone, weekdays: { 0: [...], ... } }` - grouped by weekday,
 * because that is how a vendor thinks about a week. The editor wants one flat list of rows,
 * so `flattenRules` below does that conversion in one place rather than in the component.
 */
export type RulesResponse = {
  timezone: string;
  weekdays: Record<string, AvailabilityRule[]>;
};

export function useRules(serviceId: string | undefined) {
  return useGated<RulesResponse>(
    ['rules', serviceId],
    `/services/${serviceId}/availability/rules`,
    !!serviceId,
  );
}

export function flattenRules(data: RulesResponse | undefined): AvailabilityRule[] {
  if (!data?.weekdays) return [];
  return Object.values(data.weekdays)
    .flat()
    .sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
}

/**
 * A full replace, not a per-row edit, because that is what the endpoint is: PUT with the
 * complete week. Diffing rows client-side to send additions and removals separately would
 * invent a transaction boundary the server does not have.
 */
export function useSaveRules(serviceId: string) {
  return useWrite<AvailabilityRule[]>(
    (rules) =>
      http.put(`/services/${serviceId}/availability/rules`, {
        rules: rules.map(({ weekday, startMinute, endMinute, capacity }) => ({
          weekday,
          startMinute,
          endMinute,
          capacity,
        })),
      }),
    [['rules', serviceId], ['slots']],
  );
}

/** Wrapped like the rules endpoint: `{ timezone, exceptions }`, not a bare array. */
export function useExceptions(serviceId: string | undefined) {
  return useGated<{ timezone: string; exceptions: AvailabilityException[] }>(
    ['exceptions', serviceId],
    `/services/${serviceId}/availability/exceptions`,
    !!serviceId,
  );
}

export function useSaveException(serviceId: string) {
  return useWrite<Record<string, unknown>>(
    (body) => http.post(`/services/${serviceId}/availability/exceptions`, body),
    [['exceptions', serviceId], ['slots']],
  );
}

export function useDeleteException(serviceId: string) {
  return useWrite<{ id: string }>(
    ({ id }) => http.delete(`/services/${serviceId}/availability/exceptions/${id}`),
    [['exceptions', serviceId], ['slots']],
  );
}

// ---------------------------------------------------------------- admin: categories

export function useSaveCategory() {
  return useWrite<{ id?: string; body: Record<string, unknown> }>(
    ({ id, body }) => (id ? http.patch(`/categories/${id}`, body) : http.post('/categories', body)),
    [['categories'], ['services']],
  );
}

export function useDeleteCategory() {
  return useWrite<{ id: string }>(({ id }) => http.delete(`/categories/${id}`), [
    ['categories'],
  ]);
}

// ---------------------------------------------------------------- admin: roles

export function useRoles() {
  return useGated<Role[]>(['roles'], '/roles');
}

export function usePermissions() {
  return useGated<PermissionCatalogue>(['permissions'], '/permissions');
}

/**
 * Saves the whole permission set for a role.
 *
 * `PATCH /roles/:id` with `permissionSlugs` replaces the set, which is exactly what a
 * checkbox grid means. The server refuses to grant a permission the caller does not hold
 * itself - ESCALATION_BLOCKED - so this can be offered to a sub-admin safely.
 */
export function useSaveRolePermissions() {
  return useWrite<{ id: string; permissionSlugs: string[] }>(
    ({ id, permissionSlugs }) => http.patch(`/roles/${id}`, { permissionSlugs }),
    [['roles'], ['me']],
  );
}

export function useCreateRole() {
  return useWrite<{ slug: string; name: string; permissionSlugs: string[] }>(
    (body) => http.post('/roles', body),
    [['roles']],
  );
}

export function useDeleteRole() {
  return useWrite<{ id: string }>(({ id }) => http.delete(`/roles/${id}`), [['roles']]);
}

// ---------------------------------------------------------------- admin: catalogue policing

export function useAdminServices(status?: string) {
  const qs = new URLSearchParams({ pageSize: '50', ...(status ? { status } : {}) });
  return useGated<Paginated<AdminService>>(
    ['admin-services', status ?? 'all'],
    `/admin/services?${qs}`,
  );
}

export function useServiceModeration() {
  return useWrite<{ id: string; action: 'suspend' | 'unsuspend'; reason?: string }>(
    ({ id, action, reason }) =>
      http.post(`/admin/services/${id}/${action}`, action === 'suspend' ? { reason } : {}),
    [['admin-services'], ['services'], ['service']],
  );
}

// ---------------------------------------------------------------- admin: bookings

export function useAdminBookings(status?: string) {
  const qs = new URLSearchParams({ pageSize: '50', ...(status ? { status } : {}) });
  return useGated<Paginated<Booking>>(
    ['admin-bookings', status ?? 'all'],
    `/admin/bookings?${qs}`,
  );
}

export function useForceCancel() {
  return useWrite<{ id: string; reason: string }>(
    ({ id, reason }) => http.patch(`/admin/bookings/${id}/force-cancel`, { reason }),
    [['admin-bookings'], ['bookings'], ['slots']],
  );
}

// ---------------------------------------------------------------- shared formatting

/** Minutes from local midnight <-> `HH:MM`, which is what a time input speaks. */
export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return `${String(h).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function timeToMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Rupees in the form, minor units on the wire. The division happens once, at the edge. */
export const toMinor = (major: string): number => Math.round(Number(major) * 100);
export const toMajor = (minor: number): string => (minor / 100).toFixed(2);

export type { Offering };
