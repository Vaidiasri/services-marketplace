import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarClock, Receipt } from 'lucide-react';
import { DataState } from '@/components/DataState';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { ApiError } from '@/lib/api';
import {
  money,
  useBooking,
  useBookingAction,
  useMyBookings,
  whenInZone,
  type Booking,
  type BookingStatus,
} from '@/lib/catalogue';

const STATUS_STYLES: Record<BookingStatus, string> = {
  PENDING: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  CONFIRMED: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  COMPLETED: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  REJECTED: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  CANCELLED: 'bg-slate-500/15 text-slate-600 dark:text-slate-300',
  NO_SHOW: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
};

export function StatusBadge({ status }: { status: BookingStatus }) {
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>
      {status.replace('_', ' ').toLowerCase()}
    </span>
  );
}

/**
 * The customer's own bookings. The server scopes this to the caller - there is no client-side
 * filter here, and passing someone else's id would not help, because the list is built from
 * the authenticated user rather than from anything in the request.
 */
export function MyBookings() {
  const [status, setStatus] = useState('');
  const bookings = useMyBookings(status || undefined);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My bookings</h1>
          <p className="text-sm text-muted-foreground">Everything you have booked, newest first.</p>
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 rounded-md border border-input bg-background/70 px-3 text-sm"
        >
          <option value="">All statuses</option>
          {(['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW'] as const).map(
            (s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ').toLowerCase()}
              </option>
            ),
          )}
        </select>
      </header>

      <DataState
        isLoading={bookings.isLoading}
        isError={bookings.isError}
        error={bookings.error as ApiError}
        isEmpty={bookings.data?.data.length === 0}
        emptyTitle="No bookings yet"
        emptyHint="Browse services and pick a time to make your first booking."
        onRetry={() => void bookings.refetch()}
      >
        <ul className="space-y-3">
          {bookings.data?.data.map((b) => (
            <li key={b.id}>
              <Link
                to={`/my/bookings/${b.id}`}
                className="glass glass-hover flex flex-wrap items-center justify-between gap-3 rounded-xl p-4"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium">
                    <span className="truncate">{b.service.title}</span>
                    <StatusBadge status={b.status} />
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {b.offering.name} · {whenInZone(b.startUtc, 'Asia/Kolkata')}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-semibold">{money(b.priceMinor, b.currency)}</p>
                  <p className="font-mono text-xs text-muted-foreground">{b.reference}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </DataState>
    </div>
  );
}

/**
 * One booking, with its full status history.
 *
 * The timeline is the server's `BookingStatusHistory`, written in the same transaction as
 * every status change - so what is rendered here is the actual audit trail, not a
 * reconstruction from the current status.
 */
export function BookingDetail() {
  const { id } = useParams<{ id: string }>();
  const booking = useBooking(id);
  const action = useBookingAction();
  const [reason, setReason] = useState('');

  const b = booking.data;
  const canCancel = b && (b.status === 'PENDING' || b.status === 'CONFIRMED');

  return (
    <div className="space-y-5">
      <Link
        to="/my/bookings"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to my bookings
      </Link>

      <DataState
        isLoading={booking.isLoading}
        isError={booking.isError}
        error={booking.error as ApiError}
        onRetry={() => void booking.refetch()}
      >
        {b && (
          <>
            <header className="glass rounded-xl p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h1 className="text-xl font-semibold tracking-tight">{b.service.title}</h1>
                  <p className="mt-1 text-sm text-muted-foreground">{b.offering.name}</p>
                </div>
                <StatusBadge status={b.status} />
              </div>

              <dl className="mt-5 grid gap-4 sm:grid-cols-2">
                <Field label="When">
                  <span className="flex items-center gap-1.5">
                    <CalendarClock className="h-4 w-4 text-muted-foreground" />
                    {whenInZone(b.startUtc, 'Asia/Kolkata')}
                  </span>
                </Field>
                <Field label="Reference">
                  <span className="font-mono">{b.reference}</span>
                </Field>
                <Field label="Price">{money(b.priceMinor, b.currency)}</Field>
                <Field label="Payment">
                  {b.paymentMode === 'PAY_NOW' ? 'Paid online' : 'Pay after the appointment'}
                </Field>
                {b.cancellationFeeMinor > 0 && (
                  <Field label="Cancellation fee charged">
                    <span className="text-rose-600 dark:text-rose-400">
                      {money(b.cancellationFeeMinor, b.currency)}
                    </span>
                  </Field>
                )}
              </dl>

              {b.cancelReason && (
                <p className="mt-4 text-sm text-muted-foreground">{b.cancelReason}</p>
              )}
            </header>

            {b.payments && b.payments.length > 0 && (
              <section className="glass rounded-xl p-5">
                <h2 className="flex items-center gap-2 font-semibold tracking-tight">
                  <Receipt className="h-4 w-4" />
                  Payments
                </h2>
                <ul className="mt-3 space-y-2 text-sm">
                  {b.payments.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3">
                      <span>
                        {money(p.amountMinor, b.currency)} · {p.mode.replace('_', ' ').toLowerCase()}
                      </span>
                      <span className="text-muted-foreground">
                        {p.status.toLowerCase()}
                        {p.failureReason && ` — ${p.failureReason}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {b.history && b.history.length > 0 && <Timeline booking={b} />}

            {canCancel && (
              <section className="glass space-y-3 rounded-xl p-5">
                <h2 className="font-semibold tracking-tight">Cancel this booking</h2>
                <p className="text-sm text-muted-foreground">
                  A cancellation close to the appointment may incur a fee, which the server
                  calculates from the service&apos;s policy.
                </p>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason (optional)"
                  className="h-9 w-full rounded-md border border-input bg-background/70 px-3 text-sm"
                />
                {action.isError && (
                  <Alert variant="destructive">
                    <AlertTitle>Could not cancel</AlertTitle>
                    <AlertDescription>{(action.error as ApiError).message}</AlertDescription>
                  </Alert>
                )}
                <Button
                  variant="outline"
                  className="border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({
                      id: b.id,
                      action: 'cancel',
                      body: reason.trim() ? { reason: reason.trim() } : {},
                    })
                  }
                >
                  {action.isPending ? 'Cancelling…' : 'Cancel booking'}
                </Button>
              </section>
            )}
          </>
        )}
      </DataState>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{children}</dd>
    </div>
  );
}

function Timeline({ booking }: { booking: Booking }) {
  return (
    <section className="glass rounded-xl p-5">
      <h2 className="font-semibold tracking-tight">History</h2>
      <ol className="mt-4 space-y-4">
        {booking.history?.map((h, i) => (
          <li key={h.id} className="relative pl-6">
            <span className="absolute left-0 top-1.5 h-2 w-2 rounded-full bg-indigo-500" />
            {/* Rendered per-entry rather than with `last:hidden`, which styles the span on
                whether IT is a last child - it always is - so the connector trailed below a
                single-entry timeline into nothing. */}
            {i < (booking.history?.length ?? 0) - 1 && (
              <span className="absolute left-[3.5px] top-4 h-[calc(100%+0.5rem)] w-px bg-border" />
            )}
            <p className="text-sm font-medium">
              {h.fromStatus === null
                ? 'Booking created'
                : h.fromStatus === h.toStatus
                  ? 'Rescheduled'
                  : `${h.fromStatus.toLowerCase()} → ${h.toStatus.toLowerCase()}`}
            </p>
            {h.reason && <p className="text-sm text-muted-foreground">{h.reason}</p>}
            <p className="mt-0.5 text-xs text-muted-foreground">
              {whenInZone(h.createdAt, 'Asia/Kolkata')}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
