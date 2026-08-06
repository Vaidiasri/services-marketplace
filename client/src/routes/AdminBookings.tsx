import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DataState } from '@/components/DataState';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { ApiError } from '@/lib/api';
import { money, whenInZone } from '@/lib/catalogue';
import { StatusBadge } from '@/routes/MyBookings';
import { useAdminBookings, useForceCancel } from '@/lib/manage';

const CANCELLABLE = ['PENDING', 'CONFIRMED'];

/**
 * Every booking on the platform, and the one intervention an admin has: a force-cancel.
 *
 * It is a separate permission (`booking.force_cancel`) and a separate endpoint from the
 * customer's own cancel, because it bypasses the cancellation window rather than applying
 * it - an admin resolving a dispute should not be charged a late fee on the customer's
 * behalf. It still releases the slot and still writes a history row naming the admin who
 * did it, so the intervention is attributable.
 */
export function AdminBookings() {
  const [status, setStatus] = useState('');
  const bookings = useAdminBookings(status || undefined);
  const force = useForceCancel();
  const [cancelling, setCancelling] = useState<string>();
  const [reason, setReason] = useState('');

  const rows = bookings.data?.data ?? [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">All bookings</h1>
          <p className="text-sm text-muted-foreground">
            Force-cancelling ignores the cancellation window, releases the slot, and records
            which admin did it.
          </p>
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 rounded-md border border-input bg-background/70 px-3 text-sm"
        >
          <option value="">All statuses</option>
          {['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW'].map((s) => (
            <option key={s} value={s}>
              {s.toLowerCase().replace('_', ' ')}
            </option>
          ))}
        </select>
      </header>

      {force.isError && (
        <Alert variant="destructive">
          <AlertTitle>
            {(force.error as ApiError).code === 'ILLEGAL_TRANSITION'
              ? 'That booking cannot be cancelled from its current state'
              : 'That action was refused'}
          </AlertTitle>
          <AlertDescription>{(force.error as ApiError).message}</AlertDescription>
        </Alert>
      )}

      <DataState
        isLoading={bookings.isLoading}
        isError={bookings.isError}
        error={bookings.error as ApiError}
        isEmpty={rows.length === 0}
        emptyTitle="No bookings with this status"
        onRetry={() => void bookings.refetch()}
      >
        <ul className="space-y-3">
          {rows.map((b) => (
            <li key={b.id} className="glass space-y-2 rounded-xl p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <Link to={`/services/${b.serviceId}`} className="truncate hover:underline">
                      {b.service?.title}
                    </Link>
                    <StatusBadge status={b.status} />
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {b.offering?.name} · {whenInZone(b.startUtc, 'Asia/Kolkata')} ·{' '}
                    {money(b.priceMinor, b.currency)} · {b.paymentMode.replace('_', ' ').toLowerCase()}
                  </p>
                  {/* The reference, not the customer's email: this payload carries
                      `customerUserId` and no user relation, and an id on screen helps
                      nobody. The reference is what a support conversation quotes. */}
                  <p className="font-mono text-xs text-muted-foreground">{b.reference}</p>
                </div>

                {CANCELLABLE.includes(b.status) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setCancelling(cancelling === b.id ? undefined : b.id);
                      setReason('');
                    }}
                  >
                    Force-cancel
                  </Button>
                )}
              </div>

              {cancelling === b.id && (
                <div className="flex flex-wrap gap-2">
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Reason — recorded against the booking (10+ characters)"
                    className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background/70 px-3 text-sm"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={reason.trim().length < 10 || force.isPending}
                    onClick={() =>
                      force.mutate(
                        { id: b.id, reason: reason.trim() },
                        { onSuccess: () => setCancelling(undefined) },
                      )
                    }
                  >
                    Cancel this booking
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </DataState>
    </div>
  );
}
