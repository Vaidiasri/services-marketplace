import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarClock, Clock, Info, MapPin } from 'lucide-react';
import { DataState } from '@/components/DataState';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import type { ApiError } from '@/lib/api';
import {
  dayLabel,
  money,
  timeOnly,
  useConfirmPayment,
  useCreateBooking,
  useService,
  useSlots,
  type Slot,
} from '@/lib/catalogue';

/**
 * Service detail, slot picker and the booking flow in one screen.
 *
 * Slots are grouped by the vendor's LOCAL day and every time is rendered in the vendor's
 * timezone, labelled with it. Showing a customer their own local time would be wrong for
 * anyone travelling, and silently wrong - which is the worst kind.
 */
export function ServiceDetail() {
  const { id } = useParams<{ id: string }>();
  const { me } = useAuth();
  const navigate = useNavigate();

  const service = useService(id);
  const [offeringId, setOfferingId] = useState<string>();
  const [selected, setSelected] = useState<Slot>();

  // Default to the cheapest offering once the service loads. Slots depend on duration, so
  // there is no meaningful slot list until one is chosen.
  useEffect(() => {
    if (!offeringId && service.data?.offerings.length) setOfferingId(service.data.offerings[0].id);
  }, [service.data, offeringId]);

  const slots = useSlots(id, offeringId);
  const offering = service.data?.offerings.find((o) => o.id === offeringId);

  const byDay = useMemo(() => {
    const zone = slots.data?.timezone;
    if (!zone || !slots.data) return [];
    const groups = new Map<string, Slot[]>();
    for (const slot of slots.data.slots) {
      const key = dayLabel(slot.startUtc, zone);
      groups.set(key, [...(groups.get(key) ?? []), slot]);
    }
    return [...groups.entries()];
  }, [slots.data]);

  return (
    <div className="space-y-6">
      <Link
        to="/services"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to services
      </Link>

      <DataState
        isLoading={service.isLoading}
        isError={service.isError}
        error={service.error as ApiError}
        onRetry={() => void service.refetch()}
      >
        {service.data && (
          <>
            <header className="glass rounded-xl p-6">
              <span className="rounded-full bg-indigo-500/10 px-2.5 py-0.5 text-xs font-medium text-indigo-600 dark:text-indigo-300">
                {service.data.category.name}
              </span>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight">{service.data.title}</h1>
              <p className="mt-2 text-muted-foreground">{service.data.description}</p>
              <p className="mt-4 flex items-center gap-1.5 text-sm text-muted-foreground">
                <MapPin className="h-4 w-4" />
                {service.data.vendorProfile.businessName} · {service.data.vendorProfile.city},{' '}
                {service.data.vendorProfile.state}
              </p>

              {/* The cancellation policy is per service and enforced server-side, so it is
                  stated before booking rather than discovered at cancellation time. */}
              <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Free cancellation up to {service.data.freeCancellationHours} hours before the
                appointment. After that, {service.data.cancellationFeePercent}% of the price is
                charged.
              </p>
            </header>

            <section className="space-y-3">
              <h2 className="font-semibold tracking-tight">Choose an option</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {service.data.offerings.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => {
                      setOfferingId(o.id);
                      setSelected(undefined);
                    }}
                    className={`glass rounded-xl p-4 text-left transition-all duration-200 ${
                      o.id === offeringId
                        ? 'ring-2 ring-indigo-500 ring-offset-2 ring-offset-transparent'
                        : 'glass-hover'
                    }`}
                  >
                    <p className="font-medium">{o.name}</p>
                    <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                      <Clock className="h-3.5 w-3.5" />
                      {o.durationMinutes} min · {money(o.priceMinor, o.currency)}
                    </p>
                  </button>
                ))}
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-semibold tracking-tight">Pick a time</h2>
                {slots.data && (
                  <p className="text-xs text-muted-foreground">
                    Times shown in {slots.data.timezone.replace('_', ' ')} — the vendor&apos;s
                    timezone
                  </p>
                )}
              </div>

              <DataState
                isLoading={slots.isLoading}
                isError={slots.isError}
                error={slots.error as ApiError}
                isEmpty={slots.data?.slots.length === 0}
                emptyTitle="No times available"
                emptyHint="This vendor has nothing bookable in the next two weeks."
                onRetry={() => void slots.refetch()}
              >
                <div className="space-y-4">
                  {byDay.map(([day, daySlots]) => (
                    <div key={day}>
                      <h3 className="mb-2 text-sm font-medium text-muted-foreground">{day}</h3>
                      <div className="flex flex-wrap gap-2">
                        {daySlots.map((slot) => {
                          const active = selected?.startUtc === slot.startUtc;
                          return (
                            <button
                              key={slot.startUtc}
                              type="button"
                              onClick={() => setSelected(slot)}
                              className={`rounded-lg border px-3 py-2 text-sm transition-all duration-200 ${
                                active
                                  ? 'border-indigo-500 bg-indigo-500 text-white shadow-md shadow-indigo-500/30'
                                  : 'border-white/50 bg-white/50 backdrop-blur-md hover:border-indigo-400 dark:border-white/10 dark:bg-white/5'
                              }`}
                            >
                              {timeOnly(slot.startUtc, slots.data!.timezone)}
                              {/* Only when the slot is genuinely partly taken. Comparing
                                  against a fixed number showed "2 left" on every slot of a
                                  capacity-2 service, which is noise; comparing against the
                                  slot's OWN capacity makes it a scarcity signal. */}
                              {slot.remainingCapacity < slot.capacity && (
                                <span
                                  className={`ml-1.5 text-xs ${active ? 'text-white/80' : 'text-amber-600 dark:text-amber-400'}`}
                                >
                                  {slot.remainingCapacity} left
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </DataState>
            </section>

            {selected && offering && (
              <BookingPanel
                serviceId={service.data.id}
                offeringId={offering.id}
                priceMinor={offering.priceMinor}
                currency={offering.currency}
                slot={selected}
                timezone={slots.data!.timezone}
                signedIn={!!me}
                onDone={() => navigate('/my/bookings')}
              />
            )}
          </>
        )}
      </DataState>
    </div>
  );
}

/**
 * Booking plus payment, as one panel with two steps.
 *
 * PAY_NOW creates the booking and then confirms its payment, mirroring a real gateway's
 * intent-then-confirm. The token selector exists so the failure path is demonstrable from the
 * UI - the server decides outcomes from a deterministic token, and hiding that would make the
 * most interesting behaviour in the payment layer unreachable without curl.
 */
function BookingPanel({
  serviceId,
  offeringId,
  priceMinor,
  currency,
  slot,
  timezone,
  signedIn,
  onDone,
}: {
  serviceId: string;
  offeringId: string;
  priceMinor: number;
  currency: string;
  slot: Slot;
  timezone: string;
  signedIn: boolean;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<'PAY_NOW' | 'PAY_AFTER'>('PAY_AFTER');
  const [token, setToken] = useState('tok_success');
  const create = useCreateBooking();
  const confirm = useConfirmPayment();

  const error = (create.error ?? confirm.error) as ApiError | null;
  const busy = create.isPending || confirm.isPending;

  async function book() {
    const result = await create.mutateAsync({ serviceId, offeringId, startUtc: slot.startUtc, paymentMode: mode });
    if (result.payment) {
      await confirm.mutateAsync({ paymentId: result.payment.id, token });
    }
    onDone();
  }

  return (
    <section className="glass sticky bottom-4 space-y-4 rounded-xl p-5 ring-1 ring-indigo-500/20">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="flex items-center gap-2 font-medium">
          <CalendarClock className="h-4 w-4" />
          {dayLabel(slot.startUtc, timezone)} at {timeOnly(slot.startUtc, timezone)}
        </p>
        <p className="text-lg font-semibold">{money(priceMinor, currency)}</p>
      </div>

      {!signedIn ? (
        <Alert>
          <AlertTitle>Sign in to book</AlertTitle>
          <AlertDescription>
            <Link className="underline" to="/login">
              Sign in
            </Link>{' '}
            or{' '}
            <Link className="underline" to="/register">
              create an account
            </Link>{' '}
            to hold this slot.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {(['PAY_AFTER', 'PAY_NOW'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-lg border px-3 py-2 text-sm transition-all ${
                  mode === m
                    ? 'border-indigo-500 bg-indigo-500/10 font-medium'
                    : 'border-white/50 bg-white/40 dark:border-white/10 dark:bg-white/5'
                }`}
              >
                {m === 'PAY_NOW' ? 'Pay now' : 'Pay after the appointment'}
              </button>
            ))}
          </div>

          {mode === 'PAY_NOW' && (
            <div className="space-y-1.5">
              <label htmlFor="tok" className="text-xs text-muted-foreground">
                Mock card — payments are simulated, no gateway is involved
              </label>
              <select
                id="tok"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background/70 px-3 text-sm"
              >
                <option value="tok_success">Card that succeeds</option>
                <option value="tok_fail">Card that is declined</option>
                <option value="tok_delay">Card that stays pending</option>
              </select>
            </div>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertTitle>
                {error.code === 'SLOT_FULL' ? 'That slot has just been taken' : 'Could not book'}
              </AlertTitle>
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          )}

          <Button className="w-full" disabled={busy} onClick={() => void book()}>
            {busy ? 'Booking…' : mode === 'PAY_NOW' ? 'Pay and book' : 'Request booking'}
          </Button>
          <p className="text-xs text-muted-foreground">
            The vendor confirms your booking. You can cancel free up to the cutoff.
          </p>
        </>
      )}
    </section>
  );
}
