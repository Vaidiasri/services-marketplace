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

// Written next to node_modules so the transpiled module can resolve 'axios'.
const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.api-test-'));
const file = join(dir, 'api.mjs');
writeFileSync(file, src);
const api = await import(pathToFileURL(file).href);

// ---------------------------------------------------------------- harness

let refreshCalls = 0;
let protectedCalls = 0;
let refreshShouldFail = false;

/**
 * A stub axios adapter. Replaces the network entirely, and is responsible for settling
 * on status itself - axios delegates that to the adapter.
 */
function makeAdapter() {
  return async (config) => {
    const url = String(config.url ?? '');
    const reply = (status, data) => {
      const response = { data, status, statusText: '', headers: {}, config };
      if (status >= 200 && status < 300) return response;
      const err = new Error(`Request failed with status code ${status}`);
      err.isAxiosError = true;
      err.response = response;
      err.config = config;
      throw err;
    };

    if (url.includes('/auth/refresh')) {
      refreshCalls++;
      // A real refresh is a network round trip. Without this delay the calls would
      // serialise and the test would pass even with no dedupe at all.
      await new Promise((r) => setTimeout(r, 25));
      return refreshShouldFail
        ? reply(401, { error: { code: 'REFRESH_INVALID', message: 'no' } })
        : reply(200, { accessToken: 'fresh-token' });
    }

    protectedCalls++;
    const auth = config.headers?.authorization ?? config.headers?.Authorization;
    return auth === 'Bearer fresh-token'
      ? reply(200, { ok: true })
      : reply(401, { error: { code: 'TOKEN_EXPIRED', message: 'expired' } });
  };
}

api._setTestAdapter(makeAdapter());

// ---------------------------------------------------------------- tests

api._resetRefreshState();
api.setAccessToken('stale-token');

const results = await Promise.all(Array.from({ length: 6 }, () => api.apiFetch('/me')));

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
// The ORIGINAL request's error surfaces, not the refresh's. The caller asked for /me
// and /me failed; why recovery also failed is the session-lost handler's business, and
// leaking REFRESH_INVALID here would have screens rendering a refresh-token message for
// a request that was never about refreshing.
ok(threw?.code === 'TOKEN_EXPIRED', 'the rejection is a typed ApiError for the original request', threw?.code);
ok(threw?.constructor?.name === 'ApiError', 'and it is an ApiError, not a raw AxiosError', threw?.constructor?.name);
ok(refreshCalls === 1, 'a failed refresh is not retried', refreshCalls);
ok(sessionLost === 1, 'session-lost handler fired exactly once', sessionLost);
ok(api.getAccessToken() === null, 'token cleared after failed refresh');

// TOKEN_INVALID must NOT attempt a refresh - it would fail identically and just add latency.
api._resetRefreshState();
refreshShouldFail = false;
refreshCalls = 0;
api._setTestAdapter(async (config) => {
  const url = String(config.url ?? '');
  if (url.includes('/auth/refresh')) {
    refreshCalls++;
    return { data: { accessToken: 'fresh-token' }, status: 200, statusText: '', headers: {}, config };
  }
  const err = new Error('401');
  err.isAxiosError = true;
  err.config = config;
  err.response = {
    data: { error: { code: 'TOKEN_INVALID', message: 'forged' } },
    status: 401,
    statusText: '',
    headers: {},
    config,
  };
  throw err;
});
api.setAccessToken('forged');
try {
  await api.apiFetch('/me');
} catch {
  /* expected */
}
ok(refreshCalls === 0, 'TOKEN_INVALID does not trigger a refresh', refreshCalls);

// A network failure with no response must be readable, not a crash.
api._resetRefreshState();
api._setTestAdapter(async () => {
  const err = new Error('Network Error');
  err.isAxiosError = true;
  throw err;
});
let netErr = null;
try {
  await api.apiFetch('/me');
} catch (e) {
  netErr = e;
}
ok(netErr?.code === 'NETWORK_ERROR', 'an unreachable API yields NETWORK_ERROR, not a parse crash', netErr?.code);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
