import axios, {
  AxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from 'axios';

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

// ---------------------------------------------------------------- instances

/** Every application request goes through this one instance. */
export const http: AxiosInstance = axios.create({
  baseURL: API_URL,
  // Required for the httpOnly refresh cookie to travel cross-origin (Vercel -> Render).
  withCredentials: true,
  headers: { 'content-type': 'application/json' },
});

/**
 * Refresh uses a SEPARATE instance with no interceptors.
 *
 * On the shared instance a 401 from /auth/refresh would re-enter the response
 * interceptor and try to refresh again - infinite recursion on an expired session.
 */
const refreshHttp: AxiosInstance = axios.create({
  baseURL: API_URL,
  withCredentials: true,
});

// ---------------------------------------------------------------- refresh

/**
 * The single most important variable in the client.
 *
 * Six parallel queries expiring at once must produce ONE refresh, not six. Refresh
 * tokens are single-use on the server, so five simultaneous rotations are
 * indistinguishable from token theft - the server revokes the whole chain and the user
 * is logged out mid-task. Concurrent callers await this same promise instead.
 */
let inFlightRefresh: Promise<string> | null = null;

export function refreshOnce(): Promise<string> {
  inFlightRefresh ??= doRefresh().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

async function doRefresh(): Promise<string> {
  const res = await refreshHttp.post<{ accessToken: string }>('/auth/refresh');
  setAccessToken(res.data.accessToken);
  return res.data.accessToken;
}

/** Test seam only - lets the dedupe be asserted without a browser. */
export function _resetRefreshState(): void {
  inFlightRefresh = null;
  accessToken = null;
}

/**
 * Test seam only. Applied to both instances because an axios instance snapshots the
 * global defaults when it is created, so setting axios.defaults.adapter afterwards
 * would silently miss these two and the test would hit the real network.
 */
export function _setTestAdapter(adapter: unknown): void {
  http.defaults.adapter = adapter as never;
  refreshHttp.defaults.adapter = adapter as never;
}

// ---------------------------------------------------------------- interceptors

type RetriableConfig = InternalAxiosRequestConfig & { _retried?: boolean };

http.interceptors.request.use((config) => {
  if (accessToken) config.headers.set('authorization', `Bearer ${accessToken}`);
  return config;
});

http.interceptors.response.use(
  (res) => res,
  async (error: unknown) => {
    const err = error as AxiosError<ApiErrorBody>;
    const config = err.config as RetriableConfig | undefined;
    const status = err.response?.status;
    const apiError = toApiError(err);

    if (status === 401 && config) {
      // Only an EXPIRED token is worth refreshing. A forged or malformed one fails
      // again identically, so retrying just doubles the latency before logout.
      if (apiError.code === 'TOKEN_EXPIRED' && !config._retried) {
        config._retried = true;
        try {
          await refreshOnce();
        } catch {
          setAccessToken(null);
          onSessionLost();
          throw apiError;
        }
        // Replay exactly once. The _retried flag makes a second attempt impossible
        // even if the fresh token also 401s.
        return http.request(config);
      }
      setAccessToken(null);
      onSessionLost();
    }

    throw apiError;
  },
);

// ---------------------------------------------------------------- request helper

type Options = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Generated once per user INTENT and reused across retries. Regenerating it on retry
   * defeats the server's idempotency guarantee entirely, which is why it is passed in
   * rather than created here.
   */
  idempotencyKey?: string;
};

export async function apiFetch<T>(path: string, opts: Options = {}): Promise<T> {
  const res = await http.request<T>({
    url: path,
    method: opts.method ?? 'GET',
    data: opts.body,
    headers: {
      ...opts.headers,
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
    },
  });
  return res.data;
}

function toApiError(err: AxiosError<ApiErrorBody>): ApiError {
  const status = err.response?.status ?? 0;
  const envelope = err.response?.data?.error;

  if (envelope?.code) {
    return new ApiError(status, envelope.code, envelope.message, envelope.details);
  }

  // No envelope: a proxy's HTML 502, a cold-start timeout, or the network being down.
  // Turning that into a parse crash would surface as a blank screen rather than a
  // readable message.
  if (!err.response) {
    return new ApiError(
      0,
      'NETWORK_ERROR',
      'Could not reach the API. It may still be waking up.',
    );
  }
  return new ApiError(
    status,
    status >= 500 ? 'SERVER_UNREACHABLE' : 'UNKNOWN',
    status >= 500
      ? 'The API is not responding. It may still be waking up.'
      : (err.message || 'Request failed'),
  );
}
