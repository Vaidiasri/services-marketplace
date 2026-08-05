export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

/** Mirrors the server envelope in doc/03_API_CONVENTIONS.md. */
export type ApiErrorBody = {
  error: { code: string; message: string; details?: unknown; requestId?: string };
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * The access token lives here and nowhere else.
 *
 * Not localStorage: a module variable cannot be read by injected script, and it dies
 * with the tab. The httpOnly refresh cookie is what survives a reload, which is the
 * whole reason the token does not need to be persisted.
 */
let accessToken: string | null = null;

// Token changes have to be observable, not just readable. React needs to re-enable the
// /me query the moment a token exists: without this the query stays disabled after
// login, and the app sits on skeletons forever.
const tokenListeners = new Set<(t: string | null) => void>();

export const setAccessToken = (t: string | null): void => {
  accessToken = t;
  tokenListeners.forEach((fn) => fn(t));
};
export const getAccessToken = (): string | null => accessToken;

export function subscribeToToken(fn: (t: string | null) => void): () => void {
  tokenListeners.add(fn);
  return () => tokenListeners.delete(fn);
}

/** Called when a session ends unrecoverably, so the app can clear caches and redirect. */
let onSessionLost: () => void = () => undefined;
export const setSessionLostHandler = (fn: () => void): void => {
  onSessionLost = fn;
};

// ---------------------------------------------------------------- refresh

/**
 * The single most important variable in the client.
 *
 * Six parallel queries expiring at once must produce ONE refresh, not six. Refresh
 * tokens are single-use on the server, so five simultaneous rotations are indistinguishable
 * from token theft - the server revokes the whole chain and the user is logged out
 * mid-task. Concurrent callers await this same promise instead.
 */
let inFlightRefresh: Promise<string> | null = null;

export function refreshOnce(): Promise<string> {
  inFlightRefresh ??= doRefresh().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

async function doRefresh(): Promise<string> {
  const res = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw await toApiError(res);
  const body = (await res.json()) as { accessToken: string };
  setAccessToken(body.accessToken);
  return body.accessToken;
}

/** Test seam only - lets the dedupe be asserted without a browser. */
export function _resetRefreshState(): void {
  inFlightRefresh = null;
  accessToken = null;
}

// ---------------------------------------------------------------- fetch

type Options = Omit<RequestInit, 'body'> & {
  body?: unknown;
  /**
   * Generated once per user INTENT and reused across retries. Regenerating it on retry
   * defeats the server's idempotency guarantee entirely, which is why it is passed in
   * rather than created here.
   */
  idempotencyKey?: string;
};

export async function apiFetch<T>(path: string, opts: Options = {}): Promise<T> {
  const send = (): Promise<Response> => {
    const headers = new Headers(opts.headers);
    if (opts.body !== undefined) headers.set('content-type', 'application/json');
    if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
    if (opts.idempotencyKey) headers.set('idempotency-key', opts.idempotencyKey);

    return fetch(`${API_URL}${path}`, {
      ...opts,
      headers,
      // Required for the refresh cookie to travel cross-origin.
      credentials: 'include',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  };

  let res = await send();

  if (res.status === 401) {
    const err = await toApiError(res);
    // Only an EXPIRED token is worth refreshing. A forged or malformed one will fail
    // again identically, so retrying it just doubles the latency before logout.
    if (err.code === 'TOKEN_EXPIRED') {
      try {
        await refreshOnce();
      } catch {
        setAccessToken(null);
        onSessionLost();
        throw err;
      }
      // Replay exactly once. Never a loop: if the fresh token also 401s, something is
      // wrong that another attempt cannot fix.
      res = await send();
    } else {
      setAccessToken(null);
      onSessionLost();
      throw err;
    }
  }

  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return new ApiError(
      res.status,
      body.error?.code ?? 'UNKNOWN',
      body.error?.message ?? res.statusText,
      body.error?.details,
    );
  } catch {
    // A proxy's HTML 502, or a cold-start timeout, is not JSON. Turning that into a
    // parse crash would surface as a blank screen instead of a readable error.
    return new ApiError(
      res.status,
      res.status >= 500 ? 'SERVER_UNREACHABLE' : 'UNKNOWN',
      res.status >= 500
        ? 'The API is not responding. It may still be waking up.'
        : res.statusText || 'Request failed',
    );
  }
}
