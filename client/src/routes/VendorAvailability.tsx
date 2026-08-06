import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { DataState } from '@/components/DataState';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ApiError } from '@/lib/api';
import { useService } from '@/lib/catalogue';
import {
  flattenRules,
  minutesToTime,
  timeToMinutes,
  useDeleteException,
  useExceptions,
  useRules,
  useSaveException,
  useSaveRules,
  WEEKDAYS,
  type AvailabilityRule,
} from '@/lib/manage';

/**
 * The vendor's calendar, which is the screen that makes the slot model visible.
 *
 * There is no slot table. A weekly rule is a local weekday plus minutes from midnight -
 * never an instant - and openings are derived on every read as rules minus exceptions minus
 * what is already booked. So editing here changes what a customer sees immediately, with
 * nothing to regenerate, and a rule survives a DST transition unchanged because 09:00 stays
 * 09:00 rather than drifting to 08:00 twice a year.
 */
export function VendorAvailability() {
  const { id } = useParams<{ id: string }>();
  const service = useService(id);
  const rules = useRules(id);
  const saveRules = useSaveRules(id ?? '');

  // Local draft, because the whole week is submitted as one PUT. Seeded from the server
  // once it arrives, and not re-seeded afterwards or a save would fight the editor.
  const [draft, setDraft] = useState<AvailabilityRule[]>([]);
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!seeded && rules.data) {
      setDraft(flattenRules(rules.data));
      setSeeded(true);
    }
  }, [rules.data, seeded]);

  const addRow = (): void =>
    setDraft((d) => [...d, { weekday: 1, startMinute: 9 * 60, endMinute: 17 * 60, capacity: 1 }]);

  const update = (index: number, patch: Partial<AvailabilityRule>): void =>
    setDraft((d) => d.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const invalid = draft.some((r) => r.endMinute <= r.startMinute);

  return (
    <div className="space-y-6">
      <div>
        <Button variant="outline" size="sm" asChild>
          <Link to="/vendor/services">
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to my services
          </Link>
        </Button>
      </div>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Availability{service.data ? ` - ${service.data.title}` : ''}
        </h1>
        <p className="text-sm text-muted-foreground">
          Times are local to{' '}
          <span className="font-medium">{rules.data?.timezone ?? 'your timezone'}</span> and
          stored as a weekday plus a time, never as an instant - which is why these hours
          survive a daylight-saving change unaltered. Slots are derived from them on every
          read.
        </p>
      </header>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Weekly hours</h2>
          <Button size="sm" variant="outline" onClick={addRow}>
            <Plus className="h-3.5 w-3.5" />
            Add a window
          </Button>
        </div>

        {saveRules.isError && (
          <Alert variant="destructive">
            <AlertTitle>Those hours were refused</AlertTitle>
            <AlertDescription>{(saveRules.error as ApiError).message}</AlertDescription>
          </Alert>
        )}
        {saveRules.isSuccess && !saveRules.isPending && (
          <Alert>
            <AlertTitle>Saved</AlertTitle>
            <AlertDescription>
              The service's openings now follow these hours. Check the public page to see
              them.
            </AlertDescription>
          </Alert>
        )}

        <DataState
          isLoading={rules.isLoading}
          isError={rules.isError}
          error={rules.error as ApiError}
          onRetry={() => void rules.refetch()}
        >
          {draft.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No hours set, so this service offers no slots at all. Add a window to open it.
            </div>
          ) : (
            <ul className="space-y-2">
              {draft.map((rule, i) => (
                <li
                  key={i}
                  className="glass flex flex-wrap items-end gap-2 rounded-xl p-3"
                >
                  <div className="min-w-[8rem] flex-1 space-y-1.5">
                    <Label htmlFor={`day-${i}`}>Day</Label>
                    <select
                      id={`day-${i}`}
                      value={rule.weekday}
                      onChange={(e) => update(i, { weekday: Number(e.target.value) })}
                      className="h-9 w-full rounded-md border border-input bg-background/70 px-3 text-sm"
                    >
                      {WEEKDAYS.map((d, index) => (
                        <option key={d} value={index}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="w-28 space-y-1.5">
                    <Label htmlFor={`from-${i}`}>Opens</Label>
                    <Input
                      id={`from-${i}`}
                      type="time"
                      value={minutesToTime(rule.startMinute)}
                      onChange={(e) => update(i, { startMinute: timeToMinutes(e.target.value) })}
                    />
                  </div>
                  <div className="w-28 space-y-1.5">
                    <Label htmlFor={`to-${i}`}>Closes</Label>
                    <Input
                      id={`to-${i}`}
                      type="time"
                      value={minutesToTime(rule.endMinute)}
                      onChange={(e) => update(i, { endMinute: timeToMinutes(e.target.value) })}
                    />
                  </div>
                  <div className="w-24 space-y-1.5">
                    <Label htmlFor={`cap-${i}`}>Capacity</Label>
                    <Input
                      id={`cap-${i}`}
                      type="number"
                      min={1}
                      value={rule.capacity}
                      onChange={(e) => update(i, { capacity: Number(e.target.value) })}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDraft((d) => d.filter((_, index) => index !== i))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={saveRules.isPending || invalid} onClick={() => saveRules.mutate(draft)}>
              {saveRules.isPending ? 'Saving...' : 'Save weekly hours'}
            </Button>
            {invalid && (
              <p className="text-sm text-amber-600 dark:text-amber-400">
                A window has to close after it opens.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Saving replaces the whole week - that is what the endpoint does, so the screen
              does not pretend otherwise.
            </p>
          </div>
        </DataState>
      </section>

      <Exceptions serviceId={id} />
    </div>
  );
}

/**
 * Date exceptions, which beat the weekly rules for a single local date: a closure, or an
 * override that opens hours the week does not have.
 */
function Exceptions({ serviceId }: { serviceId: string | undefined }) {
  const exceptions = useExceptions(serviceId);
  const save = useSaveException(serviceId ?? '');
  const remove = useDeleteException(serviceId ?? '');
  const [form, setForm] = useState({
    date: '',
    type: 'CLOSED',
    start: '10:00',
    end: '14:00',
    capacity: '1',
    reason: '',
  });

  const isOverride = form.type === 'OPEN_OVERRIDE';

  return (
    <section className="space-y-3">
      <h2 className="font-medium">Date exceptions</h2>

      {(save.isError || remove.isError) && (
        <Alert variant="destructive">
          <AlertTitle>That exception was refused</AlertTitle>
          <AlertDescription>
            {((save.error ?? remove.error) as ApiError).message}
          </AlertDescription>
        </Alert>
      )}

      <form
        className="glass flex flex-wrap items-end gap-2 rounded-xl p-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(
            {
              date: form.date,
              type: form.type,
              ...(isOverride
                ? {
                    startMinute: timeToMinutes(form.start),
                    endMinute: timeToMinutes(form.end),
                    capacity: Number(form.capacity),
                  }
                : {}),
              ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
            },
            { onSuccess: () => setForm({ ...form, date: '', reason: '' }) },
          );
        }}
      >
        <div className="w-40 space-y-1.5">
          <Label htmlFor="ex-date">Date</Label>
          <Input
            id="ex-date"
            type="date"
            required
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
          />
        </div>
        <div className="w-44 space-y-1.5">
          <Label htmlFor="ex-type">Type</Label>
          <select
            id="ex-type"
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
            className="h-9 w-full rounded-md border border-input bg-background/70 px-3 text-sm"
          >
            <option value="CLOSED">Closed all day</option>
            <option value="OPEN_OVERRIDE">Open with different hours</option>
          </select>
        </div>

        {isOverride && (
          <>
            <div className="w-28 space-y-1.5">
              <Label htmlFor="ex-from">Opens</Label>
              <Input
                id="ex-from"
                type="time"
                value={form.start}
                onChange={(e) => setForm({ ...form, start: e.target.value })}
              />
            </div>
            <div className="w-28 space-y-1.5">
              <Label htmlFor="ex-to">Closes</Label>
              <Input
                id="ex-to"
                type="time"
                value={form.end}
                onChange={(e) => setForm({ ...form, end: e.target.value })}
              />
            </div>
            <div className="w-24 space-y-1.5">
              <Label htmlFor="ex-cap">Capacity</Label>
              <Input
                id="ex-cap"
                type="number"
                min={1}
                value={form.capacity}
                onChange={(e) => setForm({ ...form, capacity: e.target.value })}
              />
            </div>
          </>
        )}

        <div className="min-w-[10rem] flex-1 space-y-1.5">
          <Label htmlFor="ex-reason">Reason (optional)</Label>
          <Input
            id="ex-reason"
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
          />
        </div>
        <Button type="submit" size="sm" disabled={save.isPending}>
          Add exception
        </Button>
      </form>

      <DataState
        isLoading={exceptions.isLoading}
        isError={exceptions.isError}
        error={exceptions.error as ApiError}
        isEmpty={exceptions.data?.exceptions.length === 0}
        emptyTitle="No exceptions"
        emptyHint="Closures and one-off opening hours will appear here."
        onRetry={() => void exceptions.refetch()}
      >
        <ul className="space-y-2">
          {(exceptions.data?.exceptions ?? []).map((ex) => (
            <li
              key={ex.id}
              className="glass flex flex-wrap items-center justify-between gap-2 rounded-xl p-3 text-sm"
            >
              <span>
                <span className="font-medium">{ex.date.slice(0, 10)}</span> ·{' '}
                {ex.type === 'CLOSED'
                  ? 'closed all day'
                  : `open ${minutesToTime(ex.startMinute ?? 0)}-${minutesToTime(ex.endMinute ?? 0)}${
                      ex.capacity ? ` · capacity ${ex.capacity}` : ''
                    }`}
                {ex.reason && ` · ${ex.reason}`}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={remove.isPending}
                onClick={() => remove.mutate({ id: ex.id })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      </DataState>
    </section>
  );
}
