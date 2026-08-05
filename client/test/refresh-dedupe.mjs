/**
 * The refresh stampede is the highest-risk bug in the client, so it gets the one
 * automated frontend test.
 *
 * Scenario: several queries hold the same expired access token and all 401 at once.
 * Refresh tokens are single-use server-side, so N simultaneous rotations look exactly
 * like token theft - the server revokes the whole chain and the user is logged out
 * mid-task. Exactly one refresh call must leave the client.
 *
 * Run: node test/refresh-dedupe.mjs   (from client/)
 */
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_BASE = 'http://api.test';

// api.ts is TypeScript and reads import.meta.env, neither of which plain node accepts.
// esbuild is already present as a Vite dependency, so use it rather than hand-rolling a
// regex stripper - the first attempt at that produced a syntax error, which is exactly
// the failure mode of parsing a language with regexes.
const { transform } = await import('esbuild');
const raw = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
const { code: src } = await transform(raw, {
  loader: 'ts',
  format: 'esm',
  define: { 'import.meta.env.VITE_API_URL': JSON.stringify(API_BASE) },
});

let pass = 0;
let fail = 0;
const ok = (cond, label, extra) => {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${extra !== undefined ? `  <- ${extra}` : ''}`);
  }
};

const dir = mkdtempSync(join(tmpdir(), 'api-test-'));
const file = join(dir, 'api.mjs');
writeFileSync(file, src);
const api = await import(pathToFileURL(file).href);

// ---------------------------------------------------------------- harness

let refreshCalls = 0;
let protectedCalls = 0;
let refreshShouldFail = false;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

globalThis.fetch = async (url, init) => {
  const path = String(url).replace(API_BASE, '');

  if (path === '/auth/refresh') {
    refreshCalls++;
    // A real refresh is a network round trip. Without this delay the calls would
    // serialise and the test would pass even with no dedupe at all.
    await new Promise((r) => setTimeout(r, 25));
    if (refreshShouldFail) {
      return json(401, { error: { code: 'REFRESH_INVALID', message: 'no' } });
    }
    return json(200, { accessToken: 'fresh-token' });
  }

  protectedCalls++;
  const auth = new Headers(init?.headers).get('authorization');
  if (auth === 'Bearer fresh-token') return json(200, { ok: true });
  return json(401, { error: { code: 'TOKEN_EXPIRED', message: 'expired' } });
};

// ---------------------------------------------------------------- tests

api._resetRefreshState();
api.setAccessToken('stale-token');

const results = await Promise.all(
  Array.from({ length: 6 }, () => api.apiFetch('/me')),
);

ok(refreshCalls === 1, '6 concurrent 401s trigger exactly ONE refresh', refreshCalls);
ok(results.every((r) => r.ok === true), 'all 6 requests still resolve successfully');
ok(protectedCalls === 12, 'each request was sent twice: original + one replay', protectedCalls);
ok(api.getAccessToken() === 'fresh-token', 'in-memory token replaced with the fresh one');

// A later expiry must be able to refresh again - the promise is cleared, not latched.
refreshCalls = 0;
api.setAccessToken('stale-token');
await api.apiFetch('/me');
ok(refreshCalls === 1, 'a later expiry refreshes again (in-flight promise is cleared)', refreshCalls);

// Failed refresh: session lost exactly once, no retry loop.
api._resetRefreshState();
refreshShouldFail = true;
refreshCalls = 0;
let sessionLost = 0;
api.setSessionLostHandler(() => sessionLost++);
api.setAccessToken('stale-token');

let threw = null;
try {
  await api.apiFetch('/me');
} catch (e) {
  threw = e;
}
ok(threw !== null, 'a failed refresh rejects rather than hanging');
ok(refreshCalls === 1, 'a failed refresh is not retried', refreshCalls);
ok(sessionLost === 1, 'session-lost handler fired exactly once', sessionLost);
ok(api.getAccessToken() === null, 'token cleared after failed refresh');

// TOKEN_INVALID must NOT attempt a refresh - it would fail identically and just add latency.
api._resetRefreshState();
refreshShouldFail = false;
refreshCalls = 0;
globalThis.fetch = async (url) => {
  const path = String(url);
  if (path.includes('/auth/refresh')) {
    refreshCalls++;
    return json(200, { accessToken: 'fresh-token' });
  }
  return json(401, { error: { code: 'TOKEN_INVALID', message: 'forged' } });
};
api.setAccessToken('forged');
try {
  await api.apiFetch('/me');
} catch {
  /* expected */
}
ok(refreshCalls === 0, 'TOKEN_INVALID does not trigger a refresh', refreshCalls);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
