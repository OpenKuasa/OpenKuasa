// tests/hire-application-form.rls.test.ts
import { beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { createAnonymousClient } from '@/lib/supabase/anonymous';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, signInAnon, liveClient, beforeCleanup } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const client = liveClient;

const PREFIX = 'RLS form job';
const SWITCHES = 'require_cv, require_cover_letter, ask_portfolio, ask_expected_salary';
const COLUMNS = `org_id, careers_enabled, ${SWITCHES}`;
const SWITCH_KEYS = ['require_cv', 'require_cover_letter', 'ask_portfolio', 'ask_expected_salary'];
const ALL_OFF = { require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false };
/** What the public board has returned since 2b: this piece must not add to it. */
const BOARD_KEYS = [
  'accepting', 'closes_on', 'department', 'employment_type', 'headline', 'job_id',
  'location', 'org_name', 'tagline', 'title', 'work_arrangement',
];

async function ownedOrg(name: string) {
  const c = client();
  const { error: e1 } = await signInAnon(c);
  expect(e1, e1?.message).toBeNull();
  const { data: orgId, error } = await createOrg(c, name);
  expect(error, error?.message).toBeNull();
  return { c, orgId: orgId as string };
}

type Owned = Awaited<ReturnType<typeof ownedOrg>>;

let owner: Owned;
let other: Owned;
let viewer: SupabaseClient;
let visitor: SupabaseClient;
let demoId: string;

const readRow = (who: Owned, orgId = who.orgId) =>
  who.c.from('hire_settings').select(COLUMNS).eq('org_id', orgId).maybeSingle();

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  owner = await ownedOrg('Hire Form Owner Sdn Bhd');
  other = await ownedOrg('Hire Form Other Sdn Bhd');
  viewer = client();
  await signInAnon(viewer);
  const { data, error } = await joinDemo(viewer);
  expect(error, error?.message).toBeNull();
  demoId = data as string;
  visitor = createAnonymousClient();
}, 30_000);

// If the cleanup cannot delete the workspaces (no key, migration not applied), they must not
// keep a public board or an open application form, so this runs first inside the helper's cleanup.
beforeCleanup(async () => {
  if (!owner) return;
  await owner.c.from('hire_settings').update({ careers_enabled: false, ...ALL_OFF }).eq('org_id', owner.orgId);
});

// The cases run in file order: each builds on the row the one before left.

testWithSupabase('1: an owner with no settings row makes one by setting a switch, and the board stays off', async () => {
  const before = await readRow(owner);
  expect(before.error, before.error?.message).toBeNull();
  expect(before.data).toBeNull();
  const ins = await owner.c.from('hire_settings').insert({ org_id: owner.orgId, require_cv: true }).select(COLUMNS).single();
  expect(ins.error, ins.error?.message).toBeNull();
  expect(ins.data).toEqual({ org_id: owner.orgId, careers_enabled: false, ...ALL_OFF, require_cv: true });
}, 30_000);

testWithSupabase('2: updating one switch leaves the others as they were', async () => {
  const upd = await owner.c.from('hire_settings').update({ ask_portfolio: true }).eq('org_id', owner.orgId).select(COLUMNS).single();
  expect(upd.error, upd.error?.message).toBeNull();
  expect(upd.data).toEqual({ org_id: owner.orgId, careers_enabled: false, ...ALL_OFF, require_cv: true, ask_portfolio: true });
}, 30_000);

testWithSupabase('3: all four switches can be updated, and the row cannot be moved to another workspace', async () => {
  const pattern = { require_cv: false, require_cover_letter: true, ask_portfolio: false, ask_expected_salary: true };
  const upd = await owner.c.from('hire_settings').update(pattern).eq('org_id', owner.orgId).select(COLUMNS).single();
  expect(upd.error, upd.error?.message).toBeNull();
  expect(upd.data).toEqual({ org_id: owner.orgId, careers_enabled: false, ...pattern });

  const moved = await owner.c.from('hire_settings').update({ org_id: other.orgId }).eq('org_id', owner.orgId).select('org_id');
  expect(moved.error).not.toBeNull();
  const still = await readRow(owner);
  expect(still.data).toMatchObject({ org_id: owner.orgId, ...pattern });
}, 30_000);

testWithSupabase('4: another workspace can neither read nor change the row', async () => {
  const read = await readRow(other, owner.orgId);
  expect(read.error, read.error?.message).toBeNull();
  expect(read.data).toBeNull();

  const upd = await other.c.from('hire_settings').update({ require_cv: true }).eq('org_id', owner.orgId).select('org_id');
  expect(upd.data ?? []).toHaveLength(0);
  const ins = await other.c.from('hire_settings').insert({ org_id: owner.orgId, require_cv: true }).select('org_id');
  expect(ins.error).not.toBeNull();

  const still = await readRow(owner);
  expect(still.data).toMatchObject({ require_cv: false, require_cover_letter: true, ask_portfolio: false, ask_expected_salary: true });
}, 30_000);

testWithSupabase('5: a viewer cannot set a switch in the workspace they can only read', async () => {
  // Whatever the demo workspace has (usually no row at all) must be the same afterwards.
  const before = await viewer.from('hire_settings').select(COLUMNS).eq('org_id', demoId);
  expect(before.error, before.error?.message).toBeNull();

  const ins = await viewer.from('hire_settings').insert({ org_id: demoId, require_cv: true }).select('org_id');
  // Refused by the row policy (a viewer is not a writer), not by some unrelated error.
  expect(ins.error?.code).toBe('42501');
  const upd = await viewer.from('hire_settings').update({ require_cv: true }).eq('org_id', demoId).select('org_id');
  expect(upd.error, upd.error?.message).toBeNull();
  expect(upd.data).toHaveLength(0);

  const after = await viewer.from('hire_settings').select(COLUMNS).eq('org_id', demoId);
  expect(after.error, after.error?.message).toBeNull();
  expect(after.data).toEqual(before.data);
}, 30_000);

testWithSupabase('6: a signed-out visitor has no access to the settings table', async () => {
  const read = await visitor.from('hire_settings').select(SWITCHES).eq('org_id', owner.orgId);
  // Permission denied, not "row-level security returned nothing".
  expect(read.error?.code).toBe('42501');
}, 30_000);

testWithSupabase('7: the public board returns what it did before, and none of the switches', async () => {
  const job = await owner.c
    .from('hire_jobs')
    .insert({
      org_id: owner.orgId, title: `${PREFIX} open`, status: 'open',
      description: 'A real description of the role.', opened_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  expect(job.error, job.error?.message).toBeNull();
  const on = await owner.c.from('hire_settings').update({ careers_enabled: true }).eq('org_id', owner.orgId).select('careers_enabled').single();
  expect(on.error, on.error?.message).toBeNull();
  expect(on.data!.careers_enabled).toBe(true);

  const board = await visitor.rpc('get_public_careers', { p_org_id: owner.orgId });
  expect(board.error, board.error?.message).toBeNull();
  const rows = board.data as Record<string, unknown>[];
  expect(rows).toHaveLength(1);
  expect(rows[0].job_id).toBe(job.data!.id);
  expect(Object.keys(rows[0]).sort()).toEqual(BOARD_KEYS);
  for (const key of SWITCH_KEYS) expect(rows[0]).not.toHaveProperty(key);
}, 30_000);

testWithSupabase('8: last, everything is switched back off', async () => {
  const off = await owner.c
    .from('hire_settings')
    .update({ careers_enabled: false, ...ALL_OFF })
    .eq('org_id', owner.orgId)
    .select(COLUMNS)
    .single();
  expect(off.error, off.error?.message).toBeNull();
  expect(off.data).toEqual({ org_id: owner.orgId, careers_enabled: false, ...ALL_OFF });
  const board = await visitor.rpc('get_public_careers', { p_org_id: owner.orgId });
  expect(board.error, board.error?.message).toBeNull();
  expect(board.data).toHaveLength(0);
}, 30_000);
