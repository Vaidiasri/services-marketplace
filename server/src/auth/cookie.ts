import type { CookieOptions, Response } from 'express';

export const REFRESH_COOKIE = 'refresh_token';

const DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7);

/**
 * Environment-aware on purpose, and the plan calls this out as the failure that works
 * locally and breaks deployed.
 *
 * Deployed, the client is on Vercel and the API on Render - different sites - so the
 * cookie must be sameSite=none, which browsers only accept together with secure, which
 * requires HTTPS. Locally there is no HTTPS, so secure=true would mean the cookie is
 * silently never stored and refresh appears broken for no visible reason.
 */
export function refreshCookieOptions(): CookieOptions {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true, // script cannot read it, so XSS cannot steal the refresh token
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/auth',
    maxAge: DAYS * 86_400_000,
  };
}

export function setRefreshCookie(res: Response, raw: string): void {
  res.cookie(REFRESH_COOKIE, raw, refreshCookieOptions());
}

export function clearRefreshCookie(res: Response): void {
  // Same attributes as when set, or the browser treats it as a different cookie and
  // leaves the original in place.
  const { maxAge: _maxAge, ...rest } = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE, rest);
}
