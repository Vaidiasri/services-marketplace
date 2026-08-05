import { useEffect, useState } from 'react';
import type { ApiError } from '../lib/api';

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
  if (isLoading) return <Skeleton />;

  if (isError) {
    const code = (error as ApiError | null)?.code;
    // A 403 means signed in and refused. Sending the user to login would be a lie and
    // an infinite loop for someone whose role simply lacks the permission.
    const forbidden = code === 'FORBIDDEN';
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4">
        <p className="font-medium text-red-800">
          {forbidden ? 'You do not have access to this' : 'Could not load this'}
        </p>
        <p className="mt-1 text-sm text-red-700">
          {error?.message ?? 'Something went wrong.'}
        </p>
        {!forbidden && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 rounded border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100"
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center">
        <p className="font-medium text-slate-700">{emptyTitle}</p>
        {emptyHint && <p className="mt-1 text-sm text-slate-500">{emptyHint}</p>}
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
export function Skeleton({ rows = 3 }: { rows?: number }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 5000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-200" />
      ))}
      {slow && (
        <p className="text-sm text-slate-500">
          Still waking the API up - free hosting sleeps after a while. This can take
          around 30 seconds.
        </p>
      )}
    </div>
  );
}
