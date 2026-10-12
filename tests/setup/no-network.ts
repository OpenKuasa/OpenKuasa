import { afterAll, expect } from 'vitest';

/**
 * Unit tests do not reach the network. This runs before every test file
 * (`setupFiles` in vitest.config.mts) and replaces `fetch` with one that
 * refuses, so a test that forgot to fake a client cannot call the live
 * database, count against a real rate limit or spend on a model.
 *
 * Why it is needed: the Supabase variables are often exported in the shell
 * that runs the tests, so `serviceClient()` and the other real clients work
 * wherever a test did not replace them. `consumeRateLimits` goes further and
 * swallows a failed call (it lets the request through), so a refused call
 * alone would pass unseen. Each refused call is therefore also recorded, and
 * the file fails when it ends.
 *
 * A file may use the network when it is a live test:
 *   - its name contains `.rls.` or `.live.`, or
 *   - it imports `tests/setup/supabase.ts`, which every test that runs against
 *     the Supabase project does (a few earlier ones are not named `.rls.`).
 * Calls to this machine (localhost) are always let through.
 *
 * Limits: only `fetch` is covered (the Supabase client, the AI SDK and the
 * app's own calls all use it). A raw socket or `node:http` request is not.
 * A test that puts its own `fetch` in place is not checked, which is the
 * point: it has faked the network.
 */

const LIVE_NAME = /\.(rls|live)\.test\.tsx?$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Set by tests/setup/supabase.ts when a test file imports it. A global rather
 * than an export, so that file does not import this one (a second copy of this
 * module would wrap `fetch` twice).
 */
const LIVE_FLAG = Symbol.for('openkuasa.tests.live');
const flags = globalThis as unknown as Record<symbol, boolean | undefined>;
// This runs before each test file is loaded: no file inherits another's flag.
flags[LIVE_FLAG] = false;

const refused: string[] = [];

/** Asked at the time of each call, once the test file's imports have run. */
function isLiveFile(): boolean {
  return flags[LIVE_FLAG] === true || LIVE_NAME.test(expect.getState().testPath ?? '');
}

/** Where a call was going, without its path or query (which can carry keys). */
function hostOf(input: Parameters<typeof fetch>[0]): string {
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(url).hostname;
  } catch {
    return 'an unreadable address';
  }
}

const realFetch = globalThis.fetch;

const guardedFetch: typeof fetch = async (input, init) => {
  const host = hostOf(input);
  if (isLiveFile() || LOCAL_HOSTS.has(host)) return realFetch(input, init);
  refused.push(host);
  throw new Error(
    `[no-network] a unit test tried to reach ${host}. Fake the client or the call; only .rls./.live. tests and tests importing tests/setup/supabase.ts may use the network.`,
  );
};

globalThis.fetch = guardedFetch;

afterAll(() => {
  if (refused.length === 0) return;
  const hosts = [...new Set(refused)].join(', ');
  const count = refused.length;
  refused.length = 0;
  throw new Error(
    `[no-network] this file made ${count} network call(s) that were refused (${hosts}). A unit test must fake every client it reaches: see tests/setup/no-network.ts.`,
  );
});
