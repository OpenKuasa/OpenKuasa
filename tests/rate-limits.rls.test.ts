// tests/rate-limits.rls.test.ts
//
// Live checks of the attempt counter (public.consume_rate_limits) and of who may call it and the three
// public write functions after 20261101091500_rate_limits.sql. Needs the service key; skips, visibly,
// against a database that does not have the migration yet.
//
// The counter's rows hold a hash and a time and belong to no workspace. Each run uses keys of its own,
// and the hourly sweep removes them.
import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, expect, test, type TestContext } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { createAnonymousClient } from '@/lib/supabase/anonymous';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { liveClient, signInAnon } from './helpers/live-workspaces';
import { hasServiceKey, liveServer, rateLimitsApplied } from './helpers/public-writer';

const runnable = hasSupabaseEnv && hasServiceKey;
const testWithSupabase = runnable ? test : test.skip;
if (!runnable) {
  console.warn(hasSupabaseEnv ? 'Set SUPABASE_SERVICE_ROLE_KEY in .env.local to run the rate limit checks' : supabaseEnvSkipReason);
}

const SKIP_REASON = 'Apply supabase/migrations/20261101091500_rate_limits.sql to run the rate limit checks';
const REFUSED = '42501';
const NONE = '00000000-0000-4000-8000-00000000dead';

let server: SupabaseClient;
let visitor: SupabaseClient; // no session
let stranger: SupabaseClient; // signed in, member of nothing
let migrationMissing = false;

beforeAll(async () => {
  if (!runnable) return;
  server = liveServer();
  migrationMissing = !(await rateLimitsApplied(server));
  if (migrationMissing) {
    console.warn(SKIP_REASON);
    return;
  }
  visitor = createAnonymousClient();
  stranger = liveClient();
  const signedIn = await signInAnon(stranger);
  expect(signedIn.error, signedIn.error?.message).toBeNull();
}, 60_000);

function needsMigration(ctx: TestContext) {
  if (migrationMissing) ctx.skip(SKIP_REASON);
}

/** A key shaped like the server's: 64 hex characters, different on every call. */
const freshKey = () => createHash('sha256').update(randomUUID()).digest('hex');

type Check = { bucket: string; key: string; limit: number; window_seconds: number };
const consume = (c: SupabaseClient, checks: Check[]) => c.rpc('consume_rate_limits', { p_checks: checks });

/** One row, no error: what the function answered. */
function answer(res: { data: unknown; error: { message: string } | null }) {
  expect(res.error, res.error?.message).toBeNull();
  const rows = res.data as { allowed: boolean; retry_after_seconds: number }[];
  expect(rows).toHaveLength(1);
  return rows[0];
}

testWithSupabase('1. a key is allowed up to its limit, then refused with a wait', async (ctx) => {
  needsMigration(ctx);
  const check = { bucket: 'rls_test', key: freshKey(), limit: 3, window_seconds: 3600 };
  // An hour's window: a boundary falling inside these four calls is not worth guarding against.
  for (let i = 1; i <= 3; i += 1) {
    expect(answer(await consume(server, [check])), `event ${i}`).toEqual({ allowed: true, retry_after_seconds: 0 });
  }
  const refused = answer(await consume(server, [check]));
  expect(refused.allowed).toBe(false);
  expect(refused.retry_after_seconds).toBeGreaterThan(0);
  expect(refused.retry_after_seconds).toBeLessThanOrEqual(3600);

  // Another key in the same bucket, and the same key in another bucket, are counted apart.
  expect(answer(await consume(server, [{ ...check, key: freshKey() }])).allowed).toBe(true);
  expect(answer(await consume(server, [{ ...check, bucket: 'rls_test_other' }])).allowed).toBe(true);
}, 60_000);

testWithSupabase('2. a refused key is allowed again in the next window', async (ctx) => {
  needsMigration(ctx);
  const check = { bucket: 'rls_test', key: freshKey(), limit: 1, window_seconds: 2 };
  // At most three calls reach a refusal even if a window ends between two of them.
  let refused = false;
  for (let i = 0; i < 3 && !refused; i += 1) refused = !answer(await consume(server, [check])).allowed;
  expect(refused).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  expect(answer(await consume(server, [check])).allowed).toBe(true);
}, 60_000);

testWithSupabase('3. several limits are counted in one call, and one of them refusing refuses the call', async (ctx) => {
  needsMigration(ctx);
  const tight = { bucket: 'rls_test_tight', key: freshKey(), limit: 1, window_seconds: 3600 };
  const wide = { bucket: 'rls_test_wide', key: freshKey(), limit: 100, window_seconds: 3600 };
  expect(answer(await consume(server, [tight, wide])).allowed).toBe(true);
  expect(answer(await consume(server, [tight, wide])).allowed).toBe(false);
  // The wide one was counted both times and still has room on its own.
  expect(answer(await consume(server, [wide])).allowed).toBe(true);
}, 60_000);

testWithSupabase('4. a key that is not a hash, a bad bucket or an empty list is refused and nothing is stored', async (ctx) => {
  needsMigration(ctx);
  const good = { bucket: 'rls_test', key: freshKey(), limit: 1, window_seconds: 60 };
  const cases: Array<[string, unknown]> = [
    ['an address as the key', [{ ...good, key: '203.0.113.7' }]],
    ['an email as the key', [{ ...good, key: 'siti@example.com' }]],
    ['an upper-case hash', [{ ...good, key: good.key.toUpperCase() }]],
    ['a bucket with a space', [{ ...good, bucket: 'rls test' }]],
    ['no limit', [{ bucket: good.bucket, key: good.key, window_seconds: 60 }]],
    ['a window of zero', [{ ...good, window_seconds: 0 }]],
    ['an empty list', []],
    ['not a list', { bucket: 'rls_test' }],
  ];
  for (const [label, checks] of cases) {
    const res = await server.rpc('consume_rate_limits', { p_checks: checks });
    expect(res.error, label).not.toBeNull();
  }
  // A good check sent together with a bad one is not counted: the call is one transaction.
  const mixed = await consume(server, [good, { ...good, key: 'not-a-hash' }]);
  expect(mixed.error).not.toBeNull();
  expect(answer(await consume(server, [good])).allowed).toBe(true);
}, 60_000);

testWithSupabase('5. only the server may count: a visitor and a signed-in user are refused', async (ctx) => {
  needsMigration(ctx);
  const check = { bucket: 'rls_test', key: freshKey(), limit: 1, window_seconds: 60 };
  for (const [label, c] of [['visitor', visitor], ['signed-in user', stranger]] as Array<[string, SupabaseClient]>) {
    const res = await consume(c, [check]);
    expect(res.error?.code, `${label}: ${res.error?.message}`).toBe(REFUSED);
  }
  // Neither refusal was counted.
  expect(answer(await consume(server, [check])).allowed).toBe(true);
}, 60_000);

testWithSupabase('6. the three public write functions are the server\'s alone; the read functions are still public', async (ctx) => {
  needsMigration(ctx);
  const calls: Array<[string, Record<string, unknown>]> = [
    ['submit_public_form', { p_form_id: NONE, p_name: 'Siti', p_email: 'siti@example.com' }],
    ['record_form_view', { p_form_id: NONE }],
    ['record_form_view', { p_form_id: NONE, p_viewer: null }],
    ['submit_public_application', { p_org_id: NONE, p_job_id: NONE, p_name: 'Siti', p_email: 'siti@example.com', p_consent: true }],
  ];
  for (const [label, c] of [['visitor', visitor], ['signed-in user', stranger]] as Array<[string, SupabaseClient]>) {
    for (const [fn, args] of calls) {
      const res = await c.rpc(fn, args);
      // No EXECUTE, or (the old one-argument view function) no such function: refused either way, never run.
      expect(res.error, `${label} ${fn}`).not.toBeNull();
      expect([REFUSED, 'PGRST202'], `${label} ${fn}: ${res.error?.message}`).toContain(res.error?.code);
    }
    const form = await c.rpc('get_public_form', { p_form_id: NONE });
    expect(form.error, `${label} get_public_form: ${form.error?.message}`).toBeNull();
    const job = await c.rpc('get_public_job', { p_org_id: NONE, p_job_id: NONE });
    expect(job.error, `${label} get_public_job: ${job.error?.message}`).toBeNull();
  }

  // The server is answered by each, with the word for "there is no such form or job".
  expect(await server.rpc('submit_public_form', calls[0][1])).toMatchObject({ data: 'not_found', error: null });
  expect((await server.rpc('record_form_view', calls[2][1])).error).toBeNull();
  expect(await server.rpc('submit_public_application', calls[3][1])).toMatchObject({ data: 'not_found', error: null });
}, 60_000);
