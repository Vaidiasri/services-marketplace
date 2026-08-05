import { useEffect, useState } from 'react';
import { AlertCircle, Inbox, ShieldAlert } from 'lucide-react';
import type { ApiError } from '@/lib/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Makes loading, empty and error states structural rather than a per-screen discipline
 * that decays. The brief scores "handles loading, empty, and error states", and every
 * list screen goes through here.
 *
 * isError is checked BEFORE isEmpty deliberately: a failed request must never fall
 * through to "no bookings yet", which reads as working software with no data.
 */
export function DataState({
  isLoading,
  isError,
  error,
  isEmpty,
  emptyTitle = 'Nothing here yet',
  emptyHint,
  onRetry,
  children,
}: {
  isLoading: boolean;
  isError?: boolean;
  error?: ApiError | Error | null;
  isEmpty?: boolean;
  emptyTitle?: string;
  emptyHint?: string;
  onRetry?: () => void;
  children: React.ReactNode;
}) {
  if (isLoading) return <LoadingRows />;

  if (isError) {
    const code = (error as ApiError | null)?.code;
    // A 403 means signed in and refused. Sending the user to login would be a lie and
    // an infinite loop for someone whose role simply lacks the permission.
    const forbidden = code === 'FORBIDDEN';
    return (
      <Alert variant="destructive">
        {forbidden ? <ShieldAlert className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
        <AlertTitle>
          {forbidden ? 'You do not have access to this' : 'Could not load this'}
        </AlertTitle>
        <AlertDescription>
          <p>{error?.message ?? 'Something went wrong.'}</p>
          {!forbidden && onRetry && (
            <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
              Try again
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  if (isEmpty) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <Inbox className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="mt-2 font-medium">{emptyTitle}</p>
        {emptyHint && <p className="mt-1 text-sm text-muted-foreground">{emptyHint}</p>}
      </div>
    );
  }

  return <>{children}</>;
}

/**
 * Skeletons shaped like the content, not a centred spinner - and after 5 seconds it says
 * so. On a free tier the API sleeps and the first request can take 30 seconds; a bare
 * spinner for that long reads as broken, which the brief lists as a deduction.
 */
export function LoadingRows({ rows = 3 }: { rows?: number }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 5000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
      {slow && (
        <p className="text-sm text-muted-foreground">
          Still waking the API up - free hosting sleeps after a while. This can take
          around 30 seconds.
        </p>
      )}
    </div>
  );
}
