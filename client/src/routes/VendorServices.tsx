import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, Eye, EyeOff, Pencil, Plus, Trash2 } from 'lucide-react';
import { DataState } from '@/components/DataState';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ApiError } from '@/lib/api';
import { money, useCategories, type Category } from '@/lib/catalogue';
import {
  toMinor,
  useDeleteOffering,
  useMyServices,
  useSaveOffering,
  useSaveService,
  useServiceAction,
  type OwnedService,
  type ServiceInput,
} from '@/lib/manage';

/**
 * The vendor's own catalogue: create a service, give it offerings, publish it.
 *
 * Publishing is gated three deep on the server and the screen does not try to predict any
 * of it. A pending vendor is refused with VENDOR_PENDING_APPROVAL, a service with no active
 * offering is refused with NO_ACTIVE_OFFERING, and a service holding a live booking cannot
 * be deleted. Each refusal is rendered as the server's own message rather than disabling
 * the button on a rule the client would then own a stale copy of.
 */
export function VendorServices() {
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState<OwnedService | 'new'>();
  const services = useMyServices(status || undefined);
  const action = useServiceAction();

  const rows = services.data?.data ?? [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My services</h1>
          <p className="text-sm text-muted-foreground">
            A service needs at least one active offering before it can be published.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="h-3.5 w-3.5" />
            New service
          </Button>
        </div>
      </header>

      {action.isError && <Refusal error={action.error as ApiError} />}

      {editing && (
        <ServiceForm
          service={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
        />
      )}

      <DataState
        isLoading={services.isLoading}
        isError={services.isError}
        error={services.error as ApiError}
        isEmpty={rows.length === 0}
        emptyTitle="No services yet"
        emptyHint="Create one, add an offering, then publish it to appear in the catalogue."
        onRetry={() => void services.refetch()}
      >
        <ul className="space-y-3">
          {rows.map((s) => (
            <li key={s.id} className="glass space-y-3 rounded-xl p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <span className="truncate">{s.title}</span>
                    <ServiceStatusBadge status={s.status} />
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {s.category?.name} · {s.slotGranularityMinutes}-minute grid · free
                    cancellation up to {s.freeCancellationHours}h, then{' '}
                    {s.cancellationFeePercent}%
                  </p>
                  {s.suspensionReason && (
                    <p className="mt-1 text-sm text-amber-600 dark:text-amber-400">
                      Suspended by an admin: {s.suspensionReason}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setEditing(s)}>
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </Button>
                  <Button size="sm" variant="outline" asChild>
                    <Link to={`/vendor/services/${s.id}/availability`}>
                      <CalendarClock className="h-3.5 w-3.5" />
                      Availability
                    </Link>
                  </Button>
                  {s.status === 'PUBLISHED' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={action.isPending}
                      onClick={() => action.mutate({ id: s.id, action: 'unpublish' })}
                    >
                      <EyeOff className="h-3.5 w-3.5" />
                      Unpublish
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={action.isPending || s.status === 'SUSPENDED'}
                      onClick={() => action.mutate({ id: s.id, action: 'publish' })}
                    >
                      <Eye className="h-3.5 w-3.5" />
                      Publish
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={action.isPending}
                    onClick={() => action.mutate({ id: s.id, action: 'delete' })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <Offerings service={s} />
            </li>
          ))}
        </ul>
      </DataState>
    </div>
  );
}

/**
 * Names the three refusals a vendor actually hits, and falls back to the server's message
 * for everything else. Inventing friendlier copy for an unknown code is how a screen ends
 * up hiding the one detail that explains the failure.
 */
function Refusal({ error }: { error: ApiError }) {
  const known: Record<string, string> = {
    VENDOR_PENDING_APPROVAL: 'Your vendor application has not been approved yet',
    VENDOR_REJECTED: 'Your vendor application was rejected',
    NO_ACTIVE_OFFERING: 'Add an active offering before publishing',
    // Publishing has four preconditions and the server owns all of them. Discovered by
    // clicking Publish on a service that had an offering but no hours - which is exactly
    // the order a vendor works in, so it needs to name the next step rather than just refuse.
    NO_AVAILABILITY: 'Set weekly hours before publishing - use the Availability button',
    SERVICE_IN_USE: 'This service has bookings, so it cannot be deleted',
    OFFERING_IN_USE: 'This offering has bookings, so it cannot be deleted',
  };
  return (
    <Alert variant="destructive">
      <AlertTitle>{known[error.code] ?? 'That action was refused'}</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}

export function ServiceStatusBadge({ status }: { status: string }) {
  const tone =
    status === 'PUBLISHED'
      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      : status === 'SUSPENDED'
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
        : 'bg-slate-500/15 text-slate-700 dark:text-slate-300';
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>
      {status.toLowerCase()}
    </span>
  );
}

// ---------------------------------------------------------------- the service form

const DEFAULTS: ServiceInput = {
  title: '',
  description: '',
  categoryId: '',
  slotGranularityMinutes: 30,
  freeCancellationHours: 24,
  cancellationFeePercent: 20,
};

function ServiceForm({ service, onClose }: { service?: OwnedService; onClose: () => void }) {
  const categories = useCategories();
  const save = useSaveService();
  const [form, setForm] = useState<ServiceInput>(
    service
      ? {
          title: service.title,
          description: service.description,
          categoryId: service.category?.id ?? '',
          slotGranularityMinutes: service.slotGranularityMinutes,
          freeCancellationHours: service.freeCancellationHours,
          cancellationFeePercent: service.cancellationFeePercent,
        }
      : DEFAULTS,
  );

  const set = <K extends keyof ServiceInput>(key: K, value: ServiceInput[K]): void =>
    setForm((f) => ({ ...f, [key]: value }));

  // Only leaves are offered. A service hangs off a child category, so allowing a parent
  // would produce a catalogue whose filters cannot reach the service again.
  const leaves = flattenLeaves(categories.data ?? []);

  return (
    <form
      className="glass space-y-4 rounded-xl p-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(
          { id: service?.id, body: form },
          { onSuccess: onClose },
        );
      }}
    >
      <div className="flex items-center justify-between">
        <h2 className="font-medium">{service ? 'Edit service' : 'New service'}</h2>
        <Button type="button" size="sm" variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </div>

      {save.isError && <Refusal error={save.error as ApiError} />}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="title">Title</Label>
          <Input
            id="title"
            required
            minLength={3}
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
          />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="description">Description</Label>
          <textarea
            id="description"
            required
            minLength={20}
            rows={3}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            className="w-full rounded-md border border-input bg-background/70 px-3 py-2 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Searchable: the title and description feed the catalogue's full-text index.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="category">Category</Label>
          <select
            id="category"
            required
            value={form.categoryId}
            onChange={(e) => set('categoryId', e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background/70 px-3 text-sm"
          >
            <option value="">Choose a category</option>
            {leaves.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="granularity">Slot grid (minutes)</Label>
          <select
            id="granularity"
            value={form.slotGranularityMinutes}
            onChange={(e) => set('slotGranularityMinutes', Number(e.target.value))}
            className="h-9 w-full rounded-md border border-input bg-background/70 px-3 text-sm"
          >
            {[15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Every offering's duration must be a multiple of this.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="freeHours">Free cancellation (hours before)</Label>
          <Input
            id="freeHours"
            type="number"
            min={0}
            max={720}
            value={form.freeCancellationHours}
            onChange={(e) => set('freeCancellationHours', Number(e.target.value))}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="feePercent">Cancellation fee after that (%)</Label>
          <Input
            id="feePercent"
            type="number"
            min={0}
            max={100}
            value={form.cancellationFeePercent}
            onChange={(e) => set('cancellationFeePercent', Number(e.target.value))}
          />
        </div>
      </div>

      <Button type="submit" disabled={save.isPending}>
        {save.isPending ? 'Saving...' : service ? 'Save changes' : 'Create service'}
      </Button>
    </form>
  );
}

/** Two-level tree to a flat list of leaves, labelled `Parent / Child`. */
function flattenLeaves(categories: Category[]): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const parent of categories) {
    const children = parent.children ?? [];
    if (children.length === 0) out.push({ id: parent.id, label: parent.name });
    for (const child of children) out.push({ id: child.id, label: `${parent.name} / ${child.name}` });
  }
  return out;
}

// ---------------------------------------------------------------- offerings

function Offerings({ service }: { service: OwnedService }) {
  const [adding, setAdding] = useState(false);
  const save = useSaveOffering();
  const remove = useDeleteOffering();
  const [draft, setDraft] = useState({ name: '', durationMinutes: '60', price: '500' });

  const mismatch = (minutes: number): boolean => minutes % service.slotGranularityMinutes !== 0;

  return (
    <div className="space-y-2 border-t border-white/40 pt-3 dark:border-white/10">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">
          Offerings ({service.offerings?.length ?? 0})
        </h3>
        <Button size="sm" variant="outline" onClick={() => setAdding(!adding)}>
          <Plus className="h-3.5 w-3.5" />
          Add offering
        </Button>
      </div>

      {(save.isError || remove.isError) && (
        <Refusal error={(save.error ?? remove.error) as ApiError} />
      )}

      {(service.offerings ?? []).length > 0 && (
        <ul className="space-y-1.5">
          {service.offerings.map((o) => (
            <li
              key={o.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/40 px-3 py-2 text-sm dark:bg-white/5"
            >
              <span className="min-w-0 truncate">
                {o.name} · {o.durationMinutes} min · {money(o.priceMinor, o.currency)}
                {o.isActive === false && ' · inactive'}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={remove.isPending}
                onClick={() => remove.mutate({ id: o.id })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(
              {
                serviceId: service.id,
                body: {
                  name: draft.name,
                  durationMinutes: Number(draft.durationMinutes),
                  priceMinor: toMinor(draft.price),
                },
              },
              {
                onSuccess: () => {
                  setAdding(false);
                  setDraft({ name: '', durationMinutes: '60', price: '500' });
                },
              },
            );
          }}
        >
          <div className="min-w-[10rem] flex-1 space-y-1.5">
            <Label htmlFor={`o-name-${service.id}`}>Name</Label>
            <Input
              id={`o-name-${service.id}`}
              required
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="w-28 space-y-1.5">
            <Label htmlFor={`o-dur-${service.id}`}>Minutes</Label>
            <Input
              id={`o-dur-${service.id}`}
              type="number"
              required
              min={service.slotGranularityMinutes}
              step={service.slotGranularityMinutes}
              value={draft.durationMinutes}
              onChange={(e) => setDraft({ ...draft, durationMinutes: e.target.value })}
            />
          </div>
          <div className="w-28 space-y-1.5">
            <Label htmlFor={`o-price-${service.id}`}>Price (INR)</Label>
            <Input
              id={`o-price-${service.id}`}
              type="number"
              required
              min={0}
              step="0.01"
              value={draft.price}
              onChange={(e) => setDraft({ ...draft, price: e.target.value })}
            />
          </div>
          <Button type="submit" size="sm" disabled={save.isPending}>
            Add
          </Button>
        </form>
      )}

      {adding && mismatch(Number(draft.durationMinutes)) && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {draft.durationMinutes} minutes is not a multiple of this service's{' '}
          {service.slotGranularityMinutes}-minute grid, so the server will refuse it - a
          duration that does not fit the grid would offer start times that overlap
          themselves.
        </p>
      )}
    </div>
  );
}
