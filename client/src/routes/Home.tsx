import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, KeyRound, LayoutGrid, ShieldCheck } from 'lucide-react';
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

  if (!me) return <Landing health={health} />;

  const nav = buildNav(me.permissions);
  const sections = [...nav.admin, ...nav.vendor, ...nav.customer];
  const isSuper = me.permissions.includes('*');

  return (
    <div className="space-y-8">
      <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
        <p className="text-sm font-medium text-muted-foreground">Signed in as</p>
        <h1 className="mt-1 bg-gradient-to-br from-slate-900 to-slate-600 bg-clip-text text-3xl font-semibold tracking-tight text-transparent dark:from-white dark:to-slate-400">
          {me.fullName}
        </h1>
        <p className="mt-1 text-muted-foreground">
          {me.email} &middot;{' '}
          <span className="font-medium text-foreground">{me.role.name}</span>
        </p>
      </div>

      {me.vendorProfile && (
        <Alert variant="warning" className="animate-in fade-in duration-500">
          <AlertTitle>Vendor application: {me.vendorProfile.status}</AlertTitle>
          {me.vendorProfile.rejectionReason && (
            <AlertDescription>
              Reason: {me.vendorProfile.rejectionReason}
            </AlertDescription>
          )}
        </Alert>
      )}

      {/* The point of this screen: navigation is derived from the server's permission
          list, so revoking a permission removes a section on the next refetch with no
          code change and no redeploy. */}
      <Card
        className="animate-in fade-in slide-in-from-bottom-3 delay-100 duration-500"
        style={{ animationFillMode: 'backwards' }}
      >
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LayoutGrid className="h-4 w-4 text-indigo-500" />
            Your sections
            <span className="ml-auto rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
              {sections.length}
            </span>
          </CardTitle>
          <CardDescription>
            Built from what <code className="font-mono text-xs">GET /me</code> returns.
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
              {sections.map((s, i) => (
                <li
                  key={s.to}
                  className="group flex animate-in items-center justify-between rounded-lg border border-white/50 bg-white/50 px-3 py-2.5 backdrop-blur-md transition-all duration-300 fade-in hover:-translate-y-0.5 hover:border-indigo-300/60 hover:bg-white/80 hover:shadow-md dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"
                  style={{ animationDelay: `${150 + i * 40}ms`, animationFillMode: 'backwards' }}
                >
                  <span className="flex items-center gap-2 font-medium">
                    {s.label}
                    <ArrowRight className="h-3.5 w-3.5 -translate-x-1 text-indigo-500 opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100" />
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {s.permission}
                  </span>
                </li>
              ))}
            </ul>
          </DataState>
        </CardContent>
      </Card>

      <Card
        className="animate-in fade-in slide-in-from-bottom-3 delay-200 duration-500"
        style={{ animationFillMode: 'backwards' }}
      >
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-violet-500" />
            Effective permissions
            <span className="ml-auto rounded-full bg-violet-500/10 px-2.5 py-0.5 text-xs font-semibold text-violet-600 dark:text-violet-400">
              {isSuper ? 'all' : me.permissions.length}
            </span>
          </CardTitle>
          <CardDescription>
            Resolved from the database on every request, never read from the token.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isSuper ? (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-300/50 bg-emerald-50/60 px-3 py-2.5 text-sm text-emerald-900 backdrop-blur-md dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200">
              <ShieldCheck className="h-4 w-4" />
              Super admin bypasses every check by role slug, holding no permission rows
              at all.
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {me.permissions.map((p, i) => (
                <span
                  key={p}
                  className="animate-in rounded-md border border-white/50 bg-white/50 px-2 py-1 font-mono text-[11px] text-muted-foreground backdrop-blur-md transition-colors duration-200 fade-in zoom-in-95 hover:border-violet-300/60 hover:bg-white/80 hover:text-foreground dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"
                  style={{ animationDelay: `${250 + i * 18}ms`, animationFillMode: 'backwards' }}
                >
                  {p}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ApiStatus health={health.data} isError={health.isError} isLoading={health.isLoading} />
    </div>
  );
}

function Landing({
  health,
}: {
  health: { data?: Health; isError: boolean; isLoading: boolean };
}) {
  return (
    <div className="space-y-10">
      <div className="animate-in space-y-4 text-center fade-in slide-in-from-bottom-3 duration-700">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/50 bg-white/60 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur-md dark:border-white/10 dark:bg-white/5">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
          Phase 2 - authentication and permissions
        </span>
        <h1 className="bg-gradient-to-br from-slate-900 via-indigo-800 to-sky-700 bg-clip-text text-4xl font-semibold tracking-tight text-transparent sm:text-5xl dark:from-white dark:via-indigo-200 dark:to-sky-300">
          A marketplace where
          <br />
          permissions are data
        </h1>
        <p className="mx-auto max-w-lg text-muted-foreground">
          Sign in and the interface rebuilds itself around what your role is allowed to
          do. Revoke a permission and it disappears on the next request - no redeploy, no
          code change.
        </p>
        <div className="flex items-center justify-center gap-3 pt-2">
          <Button asChild>
            <Link to="/login">
              Sign in
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to="/register">Create an account</Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          {
            icon: ShieldCheck,
            title: 'Server-enforced',
            body: 'Every protected route carries a guard. The UI only hides what it cannot do.',
            tint: 'text-emerald-500',
          },
          {
            icon: KeyRound,
            title: 'Roles are rows',
            body: 'No enums. A role invented at runtime works with no code change.',
            tint: 'text-violet-500',
          },
          {
            icon: LayoutGrid,
            title: 'Nav from /me',
            body: 'Navigation is generated from resolved permissions, not hardcoded.',
            tint: 'text-indigo-500',
          },
        ].map((f, i) => (
          <Card
            key={f.title}
            className="animate-in fade-in slide-in-from-bottom-3 duration-500"
            style={{ animationDelay: `${120 + i * 90}ms`, animationFillMode: 'backwards' }}
          >
            <CardHeader className="pb-3">
              <f.icon className={`h-5 w-5 ${f.tint}`} />
              <CardTitle className="pt-1 text-base">{f.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{f.body}</p>
            </CardContent>
          </Card>
        ))}
      </div>

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
    <p className="flex items-center justify-center gap-2 font-mono text-xs text-muted-foreground">
      {isLoading && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />}
      {isError && <span className="h-1.5 w-1.5 rounded-full bg-red-500" />}
      {health && (
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            health.db === 'up' ? 'bg-emerald-500' : 'bg-red-500'
          }`}
        />
      )}
      {isLoading && 'api: checking...'}
      {isError && `api: unreachable at ${API_URL}`}
      {health && `api: ${health.status}  db: ${health.db}  (${health.commit})`}
    </p>
  );
}
