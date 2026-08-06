import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DataState } from '@/components/DataState';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { ApiError } from '@/lib/api';
import { money } from '@/lib/catalogue';
import { useAdminServices, useServiceModeration } from '@/lib/manage';
import { ServiceStatusBadge } from '@/routes/VendorServices';

/**
 * Catalogue moderation: the admin view of every vendor's services, published or not.
 *
 * Suspending is not the same as unpublishing. Unpublish is the vendor's own action and can be
 * reversed by them; suspension is an admin intervention the vendor cannot lift, and it
 * deliberately leaves existing CONFIRMED bookings intact - cancelling a customer's booking
 * because their vendor was suspended would punish the wrong person.
 */
export function AdminCatalogue() {
  const [status, setStatus] = useState('');
  const services = useAdminServices(status || undefined);
  const moderate = useServiceModeration();
  const [suspending, setSuspending] = useState<string>();
  const [reason, setReason] = useState('');

  const rows = services.data?.data ?? [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">All services</h1>
          <p className="text-sm text-muted-foreground">
            Every vendor's catalogue, including drafts. Suspension hides a service from
            customers but preserves its confirmed bookings.
          </p>
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 rounded-md border border-input bg-background/70 px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="PUBLISHED">Published</option>
          <option value="SUSPENDED">Suspended</option>
        </select>
      </header>

      {moderate.isError && (
        <Alert variant="destructive">
          <AlertTitle>
            {(moderate.error as ApiError).code === 'FORBIDDEN'
              ? 'Your role cannot moderate the catalogue'
              : 'That action was refused'}
          </AlertTitle>
          <AlertDescription>{(moderate.error as ApiError).message}</AlertDescription>
        </Alert>
      )}

      <DataState
        isLoading={services.isLoading}
        isError={services.isError}
        error={services.error as ApiError}
        isEmpty={rows.length === 0}
        emptyTitle="No services with this status"
        onRetry={() => void services.refetch()}
      >
        <ul className="space-y-3">
          {rows.map((s) => (
            <li key={s.id} className="glass space-y-2 rounded-xl p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <Link to={`/services/${s.id}`} className="truncate hover:underline">
                      {s.title}
                    </Link>
                    <ServiceStatusBadge status={s.status} />
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {s.vendorProfile?.businessName} · {s.vendorProfile?.city} ·{' '}
                    {s.category?.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {(s.offerings ?? []).length} offering(s)
                    {s.offerings?.[0] && ` from ${money(s.offerings[0].priceMinor, s.offerings[0].currency)}`}
                  </p>
                  {s.suspensionReason && (
                    <p className="mt-1 text-sm text-amber-600 dark:text-amber-400">
                      Suspended: {s.suspensionReason}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  {s.status === 'SUSPENDED' ? (
                    <Button
                      size="sm"
                      disabled={moderate.isPending}
                      onClick={() => moderate.mutate({ id: s.id, action: 'unsuspend' })}
                    >
                      Lift suspension
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setSuspending(suspending === s.id ? undefined : s.id);
                        setReason('');
                      }}
                    >
                      Suspend
                    </Button>
                  )}
                </div>
              </div>

              {suspending === s.id && (
                <div className="flex flex-wrap gap-2">
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Reason — the vendor sees this (10+ characters)"
                    className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background/70 px-3 text-sm"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={reason.trim().length < 10 || moderate.isPending}
                    onClick={() =>
                      moderate.mutate(
                        { id: s.id, action: 'suspend', reason: reason.trim() },
                        { onSuccess: () => setSuspending(undefined) },
                      )
                    }
                  >
                    Suspend service
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
