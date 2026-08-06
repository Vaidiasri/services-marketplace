import { useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DataState } from '@/components/DataState';
import { StatusBadge } from '@/routes/MyBookings';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { http, type ApiError } from '@/lib/api';
import { money, useBookingAction, useMyBookings, whenInZone, type Booking } from '@/lib/catalogue';

/**
 * The vendor's side of the booking lifecycle.
 *
 * `GET /bookings` is the SAME endpoint the customer screen uses - the server scopes it by the
 * caller's relationship, returning their own bookings to a customer and their profile's to a
 * vendor. One endpoint, one scoping rule, no `?asVendor=true` for a client to lie about.
 */
export function VendorQueue() {
  const bookings = useMyBookings();
  const action = useBookingAction();
  const [rejecting, setRejecting] = useState<string>();
  const [reason, setReason] = useState('');

  const rows = bookings.data?.data ?? [];
  const pending = rows.filter((b) => b.status === 'PENDING');
  const upcoming = rows.filter((b) => b.status === 'CONFIRMED');
  const past = rows.filter((b) => !['PENDING', 'CONFIRMED'].includes(b.status));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Booking queue</h1>
        <p className="text-sm text-muted-foreground">
          Confirm or decline requests, then mark them complete after the appointment.
        </p>
      </header>

      {action.isError && (
        <Alert variant="destructive">
          <AlertTitle>That action was refused</AlertTitle>
          <AlertDescription>
            {(action.error as ApiError).message}
            {(action.error as ApiError).code === 'TOO_EARLY_TO_COMPLETE' &&
              ' The appointment has not finished yet.'}
          </AlertDescription>
        </Alert>
      )}

      <DataState
        isLoading={bookings.isLoading}
        isError={bookings.isError}
        error={bookings.error as ApiError}
        isEmpty={rows.length === 0}
        emptyTitle="No bookings yet"
        emptyHint="Bookings from customers will appear here."
        onRetry={() => void bookings.refetch()}
      >
        <Group title="Awaiting your decision" count={pending.length}>
          {pending.map((b) => (
            <Row key={b.id} booking={b}>
              <Button
                size="sm"
                disabled={action.isPending}
                onClick={() => action.mutate({ id: b.id, action: 'confirm' })}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Confirm
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setRejecting(rejecting === b.id ? undefined : b.id);
                  setReason('');
                }}
              >
                <XCircle className="h-3.5 w-3.5" />
                Decline
              </Button>
              {rejecting === b.id && (
                <div className="mt-2 flex w-full flex-wrap gap-2">
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why are you declining? (at least 10 characters)"
                    className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background/70 px-3 text-sm"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={reason.trim().length < 10 || action.isPending}
                    onClick={() =>
                      action.mutate(
                        { id: b.id, action: 'reject', body: { reason: reason.trim() } },
                        { onSuccess: () => setRejecting(undefined) },
                      )
                    }
                  >
                    Send decline
                  </Button>
                </div>
              )}
            </Row>
          ))}
        </Group>

        <Group title="Confirmed" count={upcoming.length}>
          {upcoming.map((b) => (
            <Row key={b.id} booking={b}>
              {/* The server refuses this until the appointment has ended, so a vendor cannot
                  farm completions. The button is shown regardless and the refusal explained,
                  rather than hidden on a clock the browser cannot be trusted about. */}
              <Button
                size="sm"
                disabled={action.isPending}
                onClick={() => action.mutate({ id: b.id, action: 'complete' })}
              >
                Mark complete
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={action.isPending}
                onClick={() =>
                  action.mutate({
                    id: b.id,
                    action: 'no-show',
                    body: { reason: 'Customer did not arrive for the appointment' },
                  })
                }
              >
                No-show
              </Button>
              {b.paymentMode === 'PAY_AFTER' && <MarkCollected bookingId={b.id} />}
            </Row>
          ))}
        </Group>

        <Group title="Past" count={past.length}>
          {past.map((b) => (
            <Row key={b.id} booking={b} />
          ))}
        </Group>
      </DataState>
    </div>
  );
}

/** PAY_AFTER settlement. Writes a CASH_COLLECTED ledger row; there is no Payment row at all. */
function MarkCollected({ bookingId }: { bookingId: string }) {
  const qc = useQueryClient();
  const collect = useMutation({
    mutationFn: async () => (await http.patch(`/bookings/${bookingId}/mark-collected`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['bookings'] }),
  });
  return (
    <Button size="sm" variant="outline" disabled={collect.isPending} onClick={() => collect.mutate()}>
      {collect.isSuccess ? 'Cash recorded' : 'Record cash collected'}
    </Button>
  );
}

function Group({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">
        {title} ({count})
      </h2>
      <ul className="space-y-3">{children}</ul>
    </section>
  );
}

function Row({ booking, children }: { booking: Booking; children?: React.ReactNode }) {
  return (
    <li className="glass flex flex-wrap items-center justify-between gap-3 rounded-xl p-4">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          <span className="truncate">{booking.service.title}</span>
          <StatusBadge status={booking.status} />
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {booking.offering.name} · {whenInZone(booking.startUtc, 'Asia/Kolkata')} ·{' '}
          {money(booking.priceMinor, booking.currency)}
        </p>
        <p className="font-mono text-xs text-muted-foreground">{booking.reference}</p>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </li>
  );
}
