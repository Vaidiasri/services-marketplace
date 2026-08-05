// Kept out of main.ts so it can be tested without booting the app.

/**
 * Matches an Origin header against comma-separated CLIENT_ORIGIN entries.
 *
 * An entry may contain a single `*`, which matches exactly one DNS label -
 * `https://*.vercel.app` allows `https://app-abc123.vercel.app` but not
 * `https://sub.app.vercel.app`, and not `https://evil.vercel.app.attacker.com`.
 * Everything else is compared literally.
 *
 * The label restriction is the point: a `.*` wildcard would let any host whose
 * name merely contains "vercel.app" through.
 */
export function isOriginAllowed(origin: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (!p.includes('*')) return p === origin;
    const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+');
    return new RegExp(`^${escaped}$`).test(origin);
  });
}
