import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Check, X } from 'lucide-react';
import { DataState } from '@/components/DataState';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { http, type ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Paginated } from '@/lib/catalogue';

type VendorRow = {
  id: string;
  businessName: string;
  city: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  timezone: string;
  createdAt: string;
  user: { id: string; email: string; fullName: string };
  _count: { documents: number };
};

/**
 * The vendor approval queue - the screen the permission model is most visible on.
 *
 * The seeded catalogue moderator holds no `vendor.read_all`, so two things happen and both
 * are correct: the navigation omits this link entirely (buildNav filters on permissions),
 * and typing the URL anyway renders "You do not have access to this" rather than redirecting
 * to login. Hiding is cosmetic; the 403 is the actual enforcement, and DataState renders it
 * as a refusal rather than treating a signed-in user as signed out.
 *
 * Approve and reject are separate permissions again - a role could be given `vendor.read_all`
 * to triage the queue without `vendor.approve` to decide it.
 */
export function AdminVendors() {
  const [status, setStatus] = useState('PENDING');
  const qc = useQueryClient();
  // See useMyBookings: an authenticated query must wait for the boot refresh to settle.
  const { booted } = useAuth();

  const vendors = useQuery({
    queryKey: ['admin-vendors', status],
    queryFn: async () =>
      (
        await http.get<Paginated<VendorRow>>('/admin/vendors', {
          params: { pageSize: 50, ...(status ? { status } : {}) },
        })
      ).data,
    enabled: booted,
  });

  const [rejecting, setRejecting] = useState<string>();
  const [reason, setReason] = useState('');

  const decide = useMutation({
    mutationFn: async ({
      id,
      decision,
      body,
    }: {
      id: string;
      decision: 'approve' | 'reject';
      body?: Record<string, unknown>;
    }) => (await http.patch(`/admin/vendors/${id}/${decision}`, body ?? {})).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-vendors'] });
      setRejecting(undefined);
    },
  });

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Vendor applications</h1>
          <p className="text-sm text-muted-foreground">
            An approved vendor may publish services. A pending one is refused by every vendor
            write route.
          </p>
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 rounded-md border border-input bg-background/70 px-3 text-sm"
        >
          <option value="PENDING">Pending</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
          <option value="">All</option>
        </select>
      </header>

      {decide.isError && (
        <Alert variant="destructive">
          <AlertTitle>
            {(decide.error as ApiError).code === 'FORBIDDEN'
              ? 'Your role cannot decide vendor applications'
              : 'That action was refused'}
          </AlertTitle>
          <AlertDescription>{(decide.error as ApiError).message}</AlertDescription>
        </Alert>
      )}

      <DataState
        isLoading={vendors.isLoading}
        isError={vendors.isError}
        error={vendors.error as ApiError}
        isEmpty={vendors.data?.data.length === 0}
        emptyTitle="Nothing in this queue"
        emptyHint="Vendor applications with this status will appear here."
        onRetry={() => void vendors.refetch()}
      >
        <ul className="space-y-3">
          {vendors.data?.data.map((v) => (
            <li key={v.id} className="glass rounded-xl p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium">
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                    {v.businessName}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {v.user.fullName} · {v.user.email}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {v.city} · {v.timezone} · {v._count.documents}{' '}
                    {v._count.documents === 1 ? 'document' : 'documents'}
                  </p>
                </div>

                {v.status === 'PENDING' ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ id: v.id, decision: 'approve' })}
                    >
                      <Check className="h-3.5 w-3.5" />
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setRejecting(rejecting === v.id ? undefined : v.id);
                        setReason('');
                      }}
                    >
                      <X className="h-3.5 w-3.5" />
                      Reject
                    </Button>
                  </div>
                ) : (
                  <span className="rounded-full bg-slate-500/15 px-2.5 py-0.5 text-xs font-medium">
                    {v.status.toLowerCase()}
                  </span>
                )}
              </div>

              {rejecting === v.id && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Reason — the vendor sees this, so it must be useful (10+ characters)"
                    className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background/70 px-3 text-sm"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={reason.trim().length < 10 || decide.isPending}
                    onClick={() =>
                      decide.mutate({ id: v.id, decision: 'reject', body: { reason: reason.trim() } })
                    }
                  >
                    Send rejection
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
