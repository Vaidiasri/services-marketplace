import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, API_URL } from '../lib/api';
import { useAuth } from '../lib/auth';
import { buildNav } from '../lib/permissions';
import { DataState } from '../components/DataState';

type Health = { status: string; db: 'up' | 'down'; commit: string };

export function Home() {
  const { me, isLoading } = useAuth();

  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => apiFetch<Health>('/health'),
    retry: false,
  });

  if (isLoading) return <DataState isLoading>{null}</DataState>;

  if (!me) {
    return (
      <div>
        <h1 className="text-2xl font-semibold">Services Marketplace</h1>
        <p className="mt-2 text-slate-600">
          Phase 2 - authentication and permissions. Sign in to see how the interface
          changes with the permissions your role holds.
        </p>
        <Link
          to="/login"
          className="mt-6 inline-block rounded-md bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-800"
        >
          Sign in
        </Link>
        <ApiStatus health={health.data} isError={health.isError} isLoading={health.isLoading} />
      </div>
    );
  }

  const nav = buildNav(me.permissions);
  const sections = [...nav.admin, ...nav.vendor, ...nav.customer];

  return (
    <div>
      <h1 className="text-2xl font-semibold">Signed in as {me.fullName}</h1>
      <p className="mt-1 text-slate-600">
        {me.email} - role <span className="font-medium">{me.role.name}</span>
      </p>

      {me.vendorProfile && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="font-medium text-amber-900">
            Vendor application: {me.vendorProfile.status}
          </p>
          {me.vendorProfile.rejectionReason && (
            <p className="mt-1 text-amber-800">
              Reason: {me.vendorProfile.rejectionReason}
            </p>
          )}
        </div>
      )}

      {/* The point of this screen: navigation is derived from the server's permission
          list, so revoking a permission removes a section on the next refetch with no
          code change and no redeploy. */}
      <section className="mt-8">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Your sections ({sections.length})
        </h2>
        <DataState
          isLoading={false}
          isEmpty={sections.length === 0}
          emptyTitle="No sections available"
          emptyHint="Your role holds no permissions that unlock a section. That is a valid state, not an error."
        >
          <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {sections.map((s) => (
              <li
                key={s.to}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2"
              >
                <span className="font-medium text-slate-800">{s.label}</span>
                <span className="ml-2 font-mono text-xs text-slate-400">
                  {s.permission}
                </span>
              </li>
            ))}
          </ul>
        </DataState>
      </section>

      <section className="mt-8">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Effective permissions ({me.permissions.includes('*') ? 'all' : me.permissions.length})
        </h2>
        <p className="mt-2 font-mono text-xs leading-relaxed text-slate-600">
          {me.permissions.join('  ')}
        </p>
      </section>

      <ApiStatus health={health.data} isError={health.isError} isLoading={health.isLoading} />
    </div>
  );
}

function ApiStatus({
  health,
  isError,
  isLoading,
}: {
  health?: Health;
  isError: boolean;
  isLoading: boolean;
}) {
  return (
    <p className="mt-10 font-mono text-xs text-slate-400">
      {isLoading && 'api: checking...'}
      {isError && `api: unreachable at ${API_URL}`}
      {health && `api: ${health.status}  db: ${health.db}  (${health.commit})`}
    </p>
  );
}
