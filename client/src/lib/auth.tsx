import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiFetch,
  getAccessToken,
  refreshOnce,
  setAccessToken,
  setSessionLostHandler,
  subscribeToToken,
  type ApiError,
} from '@/lib/api';

export type Me = {
  id: string;
  email: string;
  fullName: string;
  role: { slug: string; name: string };
  /** `['*']` for SUPER_ADMIN. Resolved server-side per request. */
  permissions: string[];
  vendorProfile?: {
    id: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    rejectionReason: string | null;
    timezone: string;
  };
};

type AuthValue = {
  me: Me | null;
  isLoading: boolean;
  error: ApiError | null;
  logout: () => Promise<void>;
  refetch: () => void;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  // Until the boot refresh resolves there is no access token, so /me would 401 for a
  // user who is in fact signed in. Gating on this is what stops a page reload from
  // flashing the login screen.
  const [booted, setBooted] = useState(false);
  // Mirrors the module-level token into React state, so the /me query below is enabled
  // exactly when a token exists. Reading getAccessToken() directly would not re-render.
  const [hasToken, setHasToken] = useState(() => getAccessToken() !== null);

  useEffect(() => subscribeToToken((t) => setHasToken(t !== null)), []);

  useEffect(() => {
    setSessionLostHandler(() => {
      setAccessToken(null);
      // removeQueries, not clear(): clear() destroys the 'me' query entirely, and a
      // later invalidateQueries then has nothing to refetch - which left the app stuck
      // on skeletons after a successful login.
      qc.removeQueries({ queryKey: ['me'] });
    });
  }, [qc]);

  useEffect(() => {
    // The access token is in memory only, so a reload has none. The httpOnly refresh
    // cookie is the only thing that survived, so try it exactly once at boot.
    refreshOnce()
      .catch(() => undefined)
      .finally(() => setBooted(true));
  }, []);

  const query = useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch<Me>('/me'),
    // Only ask who I am once a token exists. Calling /me unauthenticated returns a
    // legitimate 401 that the error path reads as a lost session, which is wrong for
    // someone who was simply never signed in.
    enabled: booted && hasToken,
    retry: false,
    staleTime: 30_000,
  });

  const logout = useCallback(async () => {
    // Best-effort: the server revoking the token is what matters, and a network failure
    // must not leave the user stuck in a signed-in shell.
    await apiFetch<void>('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setAccessToken(null);
    // Full clear here is correct and intended: on logout every cached response belongs
    // to the previous user and must not be visible to the next one.
    qc.clear();
  }, [qc]);

  const value = useMemo<AuthValue>(
    () => ({
      me: query.data ?? null,
      // Signed out is a settled state, not a loading one. Without the hasToken clause
      // a disabled query reports isLoading forever and the app never renders.
      isLoading: !booted || (hasToken && query.isLoading),
      error: (query.error as ApiError | null) ?? null,
      logout,
      refetch: () => void qc.invalidateQueries({ queryKey: ['me'] }),
    }),
    [booted, hasToken, query.data, query.isLoading, query.error, logout, qc],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

type Credentials = { email: string; password: string };

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (creds: Credentials) => {
      const res = await apiFetch<{ user: Me; accessToken: string }>('/auth/login', {
        method: 'POST',
        body: creds,
      });
      setAccessToken(res.accessToken);
      return res.user;
    },
    // Refetch rather than seeding the cache from the login response: /me carries the
    // resolved permission list and the vendor profile, which login does not.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

export function useRegisterCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (dto: Credentials & { fullName: string }) => {
      const res = await apiFetch<{ user: Me; accessToken: string }>(
        '/auth/register/customer',
        { method: 'POST', body: dto },
      );
      setAccessToken(res.accessToken);
      return res.user;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

export function useRegisterVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (dto: Record<string, string>) => {
      const res = await apiFetch<{ user: Me; accessToken: string }>(
        '/auth/register/vendor',
        { method: 'POST', body: dto },
      );
      setAccessToken(res.accessToken);
      return res.user;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}
