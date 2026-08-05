import { useEffect, useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

type Health = { status: string; db: 'up' | 'down'; commit: string };
type Probe =
  | { state: 'loading' }
  | { state: 'ok'; health: Health }
  | { state: 'error'; message: string };

export function App() {
  const [probe, setProbe] = useState<Probe>({ state: 'loading' });

  useEffect(() => {
    // credentials: 'include' is the point of this call, not an accident. It forces
    // the strict CORS path - exact origin echo plus Allow-Credentials - which is
    // what M1's refresh cookie will need. A plain fetch would pass here and fail
    // in Phase 2. See doc/00_MASTER_PLAN.md Phase 0.
    fetch(`${API_URL}/health`, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        setProbe({ state: 'ok', health: (await res.json()) as Health });
      })
      .catch((err: unknown) =>
        setProbe({
          state: 'error',
          message: err instanceof Error ? err.message : 'unreachable',
        }),
      );
  }, []);

  return (
    <main className="min-h-screen bg-slate-50 p-8 font-sans text-slate-900">
      <h1 className="text-2xl font-semibold">Services Marketplace</h1>
      <p className="mt-1 text-sm text-slate-500">
        Phase 0 - pipeline check. No features yet.
      </p>

      <section className="mt-6 max-w-md rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Deployment probe
        </h2>

        {probe.state === 'loading' && (
          <div className="mt-3 h-5 w-40 animate-pulse rounded bg-slate-200" />
        )}

        {probe.state === 'ok' && (
          <p className="mt-3 font-mono text-sm">
            api: <span className="text-green-600">{probe.health.status}</span>
            {'  '}db:{' '}
            <span
              className={
                probe.health.db === 'up' ? 'text-green-600' : 'text-red-600'
              }
            >
              {probe.health.db}
            </span>
            <span className="ml-2 text-slate-400">({probe.health.commit})</span>
          </p>
        )}

        {probe.state === 'error' && (
          <div className="mt-3">
            <p className="font-mono text-sm text-red-600">api: {probe.message}</p>
            <p className="mt-1 text-xs text-slate-500">
              Cross-origin request to {API_URL} failed. Check CLIENT_ORIGIN on the API.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
