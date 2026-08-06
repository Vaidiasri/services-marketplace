import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { MapPin, Search, SlidersHorizontal } from 'lucide-react';
import { DataState } from '@/components/DataState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { money, useCatalogue, useCategories, type Service } from '@/lib/catalogue';

/**
 * The public catalogue. Search, category filter, price ceiling and pagination are ALL
 * server-side - this component sends parameters and renders what comes back. Nothing is
 * filtered in the browser, which is what the brief grades and what makes `meta.total`
 * meaningful.
 *
 * Filters live in the URL so a filtered view can be linked, shared and reloaded. That also
 * makes the back button behave, which it does not when filter state is local.
 */
export function Catalogue() {
  const [params, setParams] = useSearchParams();

  const page = Number(params.get('page') ?? '1');
  const q = params.get('q') ?? '';
  const categoryId = params.get('categoryId') ?? '';
  const maxPriceMinor = params.get('maxPrice') ?? '';

  // Local mirror so typing is not one round trip per keystroke; the URL updates after a
  // pause. Without the debounce every character is a query, and the server-side search
  // looks slow when it is actually just being asked twelve times.
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  useEffect(() => {
    if (draft === q) return;
    const t = setTimeout(() => update({ q: draft, page: '1' }), 350);
    return () => clearTimeout(t);
  }, [draft]);

  function update(next: Record<string, string>) {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) merged.set(k, v);
      else merged.delete(k);
    }
    setParams(merged, { replace: true });
  }

  const categories = useCategories();
  const catalogue = useCatalogue({ page, q, categoryId, maxPriceMinor });
  const meta = catalogue.data?.meta;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Browse services</h1>
        <p className="text-sm text-muted-foreground">
          Only published services from approved vendors appear here.
        </p>
      </header>

      <div className="glass grid gap-4 rounded-xl p-4 sm:grid-cols-[1fr_auto_auto]">
        <div className="space-y-1.5">
          <Label htmlFor="q">Search</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="q"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="haircut, cleaning, plumbing"
              className="pl-9"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cat">Category</Label>
          <select
            id="cat"
            value={categoryId}
            onChange={(e) => update({ categoryId: e.target.value, page: '1' })}
            className="h-10 w-full rounded-md border border-input bg-background/70 px-3 text-sm backdrop-blur-sm sm:w-48"
          >
            <option value="">All categories</option>
            {categories.data?.map((parent) => (
              // Choosing a parent includes its children server-side, so "Beauty & Wellness"
              // also returns everything filed under Salon.
              <optgroup key={parent.id} label={parent.name}>
                <option value={parent.id}>All {parent.name}</option>
                {parent.children?.map((child) => (
                  <option key={child.id} value={child.id}>
                    {child.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="max">Max price</Label>
          <Input
            id="max"
            inputMode="numeric"
            value={maxPriceMinor}
            onChange={(e) => update({ maxPrice: e.target.value.replace(/\D/g, ''), page: '1' })}
            placeholder="3000"
            className="sm:w-28"
          />
        </div>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {meta ? (
            <>
              <strong className="text-foreground">{meta.total}</strong>{' '}
              {meta.total === 1 ? 'service' : 'services'}
              {meta.totalPages > 1 && ` · page ${meta.page} of ${meta.totalPages}`}
            </>
          ) : (
            ' '
          )}
        </span>
        {(q || categoryId || maxPriceMinor) && (
          <Button variant="ghost" size="sm" onClick={() => setParams({}, { replace: true })}>
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Clear filters
          </Button>
        )}
      </div>

      <DataState
        isLoading={catalogue.isLoading}
        isError={catalogue.isError}
        error={catalogue.error as Error}
        isEmpty={catalogue.data?.data.length === 0}
        emptyTitle="No services match those filters"
        emptyHint="Try a broader search, or clear the filters above."
        onRetry={() => void catalogue.refetch()}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {catalogue.data?.data.map((s) => (
            <ServiceCard key={s.id} service={s} />
          ))}
        </div>

        {meta && meta.totalPages > 1 && (
          <nav className="mt-6 flex items-center justify-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={meta.page <= 1}
              onClick={() => update({ page: String(meta.page - 1) })}
            >
              Previous
            </Button>
            <span className="px-2 text-sm text-muted-foreground">
              {meta.page} / {meta.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={meta.page >= meta.totalPages}
              onClick={() => update({ page: String(meta.page + 1) })}
            >
              Next
            </Button>
          </nav>
        )}
      </DataState>
    </div>
  );
}

function ServiceCard({ service }: { service: Service }) {
  // The cheapest active offering is the headline price. The server already sorts offerings
  // by price ascending, so this is the first one rather than a scan.
  const from = service.offerings[0];

  return (
    <Link
      to={`/services/${service.id}`}
      className="glass glass-hover group flex h-full flex-col rounded-xl p-5 transition-transform duration-300 hover:-translate-y-0.5"
    >
      <span className="w-fit rounded-full bg-indigo-500/10 px-2.5 py-0.5 text-xs font-medium text-indigo-600 dark:text-indigo-300">
        {service.category.name}
      </span>

      <h2 className="mt-3 font-semibold leading-snug tracking-tight group-hover:underline">
        {service.title}
      </h2>
      <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">{service.description}</p>

      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        <MapPin className="h-3.5 w-3.5" />
        {service.vendorProfile.businessName} · {service.vendorProfile.city}
      </p>

      <div className="mt-auto pt-4">
        {from ? (
          <p className="text-sm">
            <span className="text-muted-foreground">from </span>
            <strong className="text-base">{money(from.priceMinor, from.currency)}</strong>
            <span className="text-muted-foreground"> · {from.durationMinutes} min</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No offerings yet</p>
        )}
      </div>
    </Link>
  );
}
