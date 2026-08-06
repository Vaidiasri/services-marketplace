import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/**
 * Every server type the booking journey needs, in one place.
 *
 * Deliberately hand-written rather than generated: the shapes are small, and writing them
 * out is what caught that the public service payload has no `status` field - the server
 * strips it for anonymous callers, so a component reading it would have rendered undefined.
 */

export type Paginated<T> = {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
};

export type Category = {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  children?: Category[];
};

export type Offering = {
  id: string;
  name: string;
  durationMinutes: number;
  priceMinor: number;
  currency: string;
  isActive?: boolean;
};

export type Service = {
  id: string;
  title: string;
  description: string;
  slotGranularityMinutes: number;
  freeCancellationHours: number;
  cancellationFeePercent: number;
  category: { id: string; name: string; slug: string };
  vendorProfile: { id: string; businessName: string; city: string; state: string };
  offerings: Offering[];
  /** Present only for the owner or an admin - the public payload omits it. */
  status?: string;
  suspensionReason?: string | null;
};

export type Slot = {
  startUtc: string;
  endUtc: string;
  capacity: number;
  remainingCapacity: number;
};

export type SlotsResponse = {
  timezone: string;
  offeringId: string;
  durationMinutes: number;
  from: string;
  to: string;
  slots: Slot[];
};

export type BookingStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'COMPLETED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'NO_SHOW';

export type Booking = {
  id: string;
  reference: string;
  serviceId: string;
  offeringId: string;
  customerUserId: string;
  vendorProfileId: string;
  startUtc: string;
  endUtc: string;
  status: BookingStatus;
  priceMinor: number;
  currency: string;
  paymentMode: 'PAY_NOW' | 'PAY_AFTER';
  cancellationFeeMinor: number;
  cancelReason: string | null;
  createdAt: string;
  service: { id: string; title: string };
  offering: { id: string; name: string; durationMinutes: number };
  history?: {
    id: string;
    fromStatus: BookingStatus | null;
    toStatus: BookingStatus;
    reason: string | null;
    createdAt: string;
  }[];
  payments?: {
    id: string;
    amountMinor: number;
    status: string;
    mode: string;
    failureReason: string | null;
  }[];
};

export type CatalogueFilters = {
  page: number;
  q: string;
  categoryId: string;
  maxPriceMinor: string;
};

// ---------------------------------------------------------------- reads

export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: async () => (await http.get<Category[]>('/categories')).data,
    // Categories are admin-owned and change rarely; refetching them on every catalogue
    // keystroke would be pure noise.
    staleTime: 5 * 60_000,
  });
}

export function useCatalogue(filters: CatalogueFilters) {
  const params: Record<string, string | number> = { page: filters.page, pageSize: 9 };
  // Empty strings are omitted rather than sent: the query schema is `.strict()` with
  // `.min(1)`, so `?q=` would be a 422 rather than "no filter".
  if (filters.q.trim()) params.q = filters.q.trim();
  if (filters.categoryId) params.categoryId = filters.categoryId;
  if (filters.maxPriceMinor) params.maxPriceMinor = Number(filters.maxPriceMinor) * 100;

  return useQuery({
    queryKey: ['services', params],
    queryFn: async () => (await http.get<Paginated<Service>>('/services', { params })).data,
    // Keeps the previous page on screen while the next one loads, so the grid does not
    // collapse to skeletons on every pagination click.
    placeholderData: (prev) => prev,
  });
}

/**
 * Gated on `booted` even though the endpoint is public, because the response is not the
 * same for everyone: a DRAFT service is 404 to a stranger and visible to its owner. Firing
 * before the boot refresh lands means an owner opening their own draft by URL gets a 404
 * that then sits in the cache - which is exactly what the availability editor did.
 */
export function useService(id: string | undefined) {
  const { booted } = useAuth();
  return useQuery({
    queryKey: ['service', id],
    queryFn: async () => (await http.get<Service>(`/services/${id}`)).data,
    enabled: !!id && booted,
  });
}

export function useSlots(serviceId: string | undefined, offeringId: string | undefined) {
  return useQuery({
    queryKey: ['slots', serviceId, offeringId],
    queryFn: async () =>
      (await http.get<SlotsResponse>(`/services/${serviceId}/slots`, { params: { offeringId } }))
        .data,
    enabled: !!serviceId && !!offeringId,
    // Slots are consumed by other customers in real time, so a cached list goes stale
    // fast. Short window rather than none, so switching offerings back and forth is free.
    staleTime: 15_000,
  });
}

/**
 * Gated on `booted`, like every authenticated query here.
 *
 * The access token is held in memory only, so a hard load or a pasted URL begins with none
 * and the session is restored from the httpOnly refresh cookie a moment later. A query that
 * fires before that lands gets a 401 and renders "Authentication required" for a user who is
 * perfectly signed in - which is what /vendor/bookings did until this gate existed.
 */
export function useMyBookings(status?: string) {
  const { booted } = useAuth();
  return useQuery({
    queryKey: ['bookings', status ?? 'all'],
    queryFn: async () =>
      (await http.get<Paginated<Booking>>('/bookings', {
        params: { pageSize: 50, ...(status ? { status } : {}) },
      })).data,
    enabled: booted,
  });
}

export function useBooking(id: string | undefined) {
  const { booted } = useAuth();
  return useQuery({
    queryKey: ['booking', id],
    queryFn: async () => (await http.get<Booking>(`/bookings/${id}`)).data,
    enabled: !!id && booted,
  });
}

// ---------------------------------------------------------------- writes

/** A fresh key per attempt: a retry of a FAILED booking is a new request, not a replay. */
const newIdempotencyKey = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function useCreateBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      serviceId: string;
      offeringId: string;
      startUtc: string;
      paymentMode: 'PAY_NOW' | 'PAY_AFTER';
    }) => {
      const res = await http.post<{ booking: Booking; payment: { id: string } | null }>(
        '/bookings',
        input,
        // Required by the server. Generated here rather than server-side precisely so a
        // network retry of the SAME attempt replays instead of booking twice.
        { headers: { 'idempotency-key': newIdempotencyKey() } },
      );
      return res.data;
    },
    onSuccess: (_data, input) => {
      // The slot list must refetch: the seat this booking just took is gone.
      void qc.invalidateQueries({ queryKey: ['slots', input.serviceId] });
      void qc.invalidateQueries({ queryKey: ['bookings'] });
    },
  });
}

export function useConfirmPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ paymentId, token }: { paymentId: string; token: string }) =>
      (
        await http.post(
          `/payments/${paymentId}/confirm`,
          { token },
          { headers: { 'idempotency-key': newIdempotencyKey() } },
        )
      ).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bookings'] });
      void qc.invalidateQueries({ queryKey: ['booking'] });
    },
  });
}

/** One hook for every booking transition - they differ only in path and body. */
export function useBookingAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      action,
      body,
    }: {
      id: string;
      action: 'cancel' | 'confirm' | 'reject' | 'complete' | 'no-show' | 'reschedule';
      body?: Record<string, unknown>;
    }) => (await http.patch<Booking>(`/bookings/${id}/${action}`, body ?? {})).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bookings'] });
      void qc.invalidateQueries({ queryKey: ['booking'] });
      void qc.invalidateQueries({ queryKey: ['slots'] });
    },
  });
}

// ---------------------------------------------------------------- formatting

/**
 * Money is integer minor units everywhere on the server, so it is divided by 100 exactly
 * once, here, at the point of display. Nothing upstream ever handles a float.
 */
export function money(minor: number, currency = 'INR'): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

/** Always rendered in the VENDOR's timezone, and always labelled with it. */
export function whenInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function timeOnly(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function dayLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(iso));
}
