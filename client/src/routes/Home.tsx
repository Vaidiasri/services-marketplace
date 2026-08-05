import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, API_URL } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { buildNav } from '@/lib/permissions';
import { DataState, LoadingRows } from '@/components/DataState';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

type Health = { status: string; db: 'up' | 'down'; commit: string };

export function Home() {
  const { me, isLoading } = useAuth();

  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => apiFetch<Health>('/health'),
    retry: false,
  });

  if (isLoading) return <LoadingRows />;

  if (!me) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Services Marketplace</h1>
          <p className="mt-2 text-muted-foreground">
            Phase 2 - authentication and permissions. Sign in to see how the interface
            changes with the permissions your role holds.
          </p>
        </div>
        <Button asChild>
          <Link to="/login">Sign in</Link>
        </Button>
        <ApiStatus health={health.data} isError={health.isError} isLoading={health.isLoading} />
      </div>
    );
  }

  const nav = buildNav(me.permissions);
  const sections = [...nav.admin, ...nav.vendor, ...nav.customer];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Signed in as {me.fullName}
        </h1>
        <p className="mt-1 text-muted-foreground">
          {me.email} - role <span className="font-medium text-foreground">{me.role.name}</span>
        </p>
      </div>

      {me.vendorProfile && (
        <Alert variant="warning">
          <AlertTitle>Vendor application: {me.vendorProfile.status}</AlertTitle>
          {me.vendorProfile.rejectionReason && (
            <AlertDescription>Reason: {me.vendorProfile.rejectionReason}</AlertDescription>
          )}
        </Alert>
      )}

      {/* The point of this screen: navigation is derived from the server's permission
          list, so revoking a permission removes a section on the next refetch with no
          code change and no redeploy. */}
      <Card>
        <CardHeader>
          <CardTitle>Your sections ({sections.length})</CardTitle>
          <CardDescription>
            Built from the permissions <code className="font-mono">GET /me</code> returns.
            Hiding is cosmetic - every one of these is guarded server-side too.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataState
            isLoading={false}
            isEmpty={sections.length === 0}
            emptyTitle="No sections available"
            emptyHint="Your role holds no permissions that unlock a section. That is a valid state, not an error."
          >
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {sections.map((s) => (
                <li
                  key={s.to}
                  className="flex items-center justify-between rounded-md border px-3 py-2"
                >
                  <span className="font-medium">{s.label}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {s.permission}
                  </span>
                </li>
              ))}
            </ul>
          </DataState>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Effective permissions (
            {me.permissions.includes('*') ? 'all' : me.permissions.length})
          </CardTitle>
          <CardDescription>
            Resolved from the database on every request, never read from the token.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            {me.permissions.map((p) => (
              <span
                key={p}
                className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground"
              >
                {p}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

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
    <p className="font-mono text-xs text-muted-foreground">
      {isLoading && 'api: checking...'}
      {isError && `api: unreachable at ${API_URL}`}
      {health && `api: ${health.status}  db: ${health.db}  (${health.commit})`}
    </p>
  );
}
