import { beforeAll, expect, test, type TestContext } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, liveClient, beforeCleanup, signInAnon, signInOwner } from './helpers/live-workspaces';
import { formsTableMissing, formsTableSkipReason } from './helpers/forms-table';
import { createSupabaseReachData } from '@/lib/reach/supabase';
import { createForm, deleteForm, setFormStatus } from '@/lib/reach/capabilities';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const client = liveClient;

async function signedIn() {
  const c = client();
  const { error } = await signInOwner(c);
  expect(error, error?.message).toBeNull();
  return c;
}

async function ownedOrg(c: SupabaseClient, name: string) {
  const { data: orgId, error } = await createOrg(c, name);
  expect(error, error?.message).toBeNull();
  return { c, orgId: orgId as string };
}

type Owned = Awaited<ReturnType<typeof ownedOrg>>;
let owner: Owned;
let other: Owned;
/** True until the forms migration has been applied to the hosted database. */
let tableMissing = false;

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const first = await signedIn();
  tableMissing = await formsTableMissing(first);
  if (tableMissing) {
    console.warn(formsTableSkipReason);
    await first.auth.signOut();
    return;
  }
  owner = await ownedOrg(first, 'Forms Writer Sdn Bhd');
  other = await ownedOrg(await signedIn(), 'Forms Other Sdn Bhd');
});
// If the cleanup cannot delete the workspaces (no key, migration not applied), they must not keep
// active public forms, so this pauses the forms this file created, first inside the helper's cleanup,
// while the owners' sessions are still valid (nothing signs them out earlier).
beforeCleanup(async () => {
  for (const org of [owner, other]) {
    if (!org) continue;
    await org.c.from('forms').update({ status: 'paused' }).eq('org_id', org.orgId);
  }
});

/** Skips a test, visibly, while the table is not there yet. */
function needsFormsTable(ctx: TestContext) {
  if (tableMissing) ctx.skip(formsTableSkipReason);
}

const slug = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

testWithSupabase('owner can insert, update and delete a form; a new form is a draft with zero counters', async (ctx) => {
  needsFormsTable(ctx);
  const s = slug('raya');
  const ins = await owner.c
    .from('forms')
    .insert({ org_id: owner.orgId, name: 'Raya Promo', category: 'Promotions', slug: s })
    .select('id, status, views_count, submissions_count, channel')
    .single();
  expect(ins.error, ins.error?.message).toBeNull();
  expect(ins.data).toMatchObject({ status: 'draft', views_count: 0, submissions_count: 0, channel: null });

  const id = ins.data!.id;
  const upd = await owner.c
    .from('forms')
    .update({ name: 'Raya Promo 2', category: 'Sales', status: 'active', channel: 'facebook', updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('name, category, status, channel')
    .single();
  expect(upd.error, upd.error?.message).toBeNull();
  expect(upd.data).toEqual({ name: 'Raya Promo 2', category: 'Sales', status: 'active', channel: 'facebook' });

  const del = await owner.c.from('forms').delete().eq('id', id).select('id');
  expect(del.error, del.error?.message).toBeNull();
  expect(del.data).toHaveLength(1);
});

testWithSupabase('the counters and the ids cannot be written through the API', async (ctx) => {
  needsFormsTable(ctx);
  const s = slug('counters');
  const mine = await owner.c.from('forms').insert({ org_id: owner.orgId, name: 'Counters', slug: s }).select('id').single();
  expect(mine.error, mine.error?.message).toBeNull();
  const id = mine.data!.id;

  for (const forged of [
    { views_count: 999 },
    { submissions_count: 999 },
    { org_id: other.orgId },
    { id: '00000000-0000-4000-8000-000000000000' },
    { created_at: new Date(0).toISOString() },
  ]) {
    const upd = await owner.c.from('forms').update(forged).eq('id', id);
    expect(upd.error?.code, `update ${Object.keys(forged)[0]} must be denied`).toBe('42501');
  }
  for (const forged of [
    { views_count: 5 },
    { submissions_count: 5 },
    { id: '00000000-0000-4000-8000-000000000001' },
  ]) {
    const ins = await owner.c.from('forms').insert({ org_id: owner.orgId, name: 'Forged', slug: slug('forged'), ...forged });
    expect(ins.error?.code, `insert with ${Object.keys(forged)[0]} must be denied`).toBe('42501');
  }

  const after = await owner.c.from('forms').select('views_count, submissions_count, org_id').eq('id', id).single();
  expect(after.data).toEqual({ views_count: 0, submissions_count: 0, org_id: owner.orgId });
  await owner.c.from('forms').delete().eq('id', id);
});

testWithSupabase('a link is unique inside a workspace, free across workspaces, and must match the rule', async (ctx) => {
  needsFormsTable(ctx);
  const s = slug('unique');
  const first = await owner.c.from('forms').insert({ org_id: owner.orgId, name: 'First', slug: s }).select('id').single();
  expect(first.error, first.error?.message).toBeNull();

  const dup = await owner.c.from('forms').insert({ org_id: owner.orgId, name: 'Second', slug: s });
  expect(dup.error?.code).toBe('23505');

  const elsewhere = await other.c.from('forms').insert({ org_id: other.orgId, name: 'Elsewhere', slug: s }).select('id').single();
  expect(elsewhere.error, elsewhere.error?.message).toBeNull();

  for (const bad of ['Raya Promo', 'a', '/raya', 'raya_promo', 'x'.repeat(61)]) {
    const ins = await owner.c.from('forms').insert({ org_id: owner.orgId, name: 'Bad', slug: bad });
    expect(ins.error?.code, `slug "${bad}" must be rejected`).toBe('23514');
  }
  const badStatus = await owner.c.from('forms').insert({ org_id: owner.orgId, name: 'Bad', slug: slug('status'), status: 'archived' });
  expect(badStatus.error?.code).toBe('23514');

  await owner.c.from('forms').delete().eq('id', first.data!.id);
  await other.c.from('forms').delete().eq('id', elsewhere.data!.id);
});

testWithSupabase('another workspace sees nothing and can change nothing', async (ctx) => {
  needsFormsTable(ctx);
  const mine = await owner.c
    .from('forms')
    .insert({ org_id: owner.orgId, name: 'mine', slug: slug('mine') })
    .select('id')
    .single();
  expect(mine.error, mine.error?.message).toBeNull();
  const id = mine.data!.id;

  const seen = await other.c.from('forms').select('id').eq('org_id', owner.orgId);
  expect(seen.error).toBeNull();
  expect(seen.data ?? []).toHaveLength(0);

  const ins = await other.c.from('forms').insert({ org_id: owner.orgId, name: 'intrusion', slug: slug('intrusion') });
  expect(ins.error?.code).toBe('42501');
  const upd = await other.c.from('forms').update({ name: 'hacked' }).eq('id', id).select('id');
  expect(upd.error).toBeNull();
  expect(upd.data ?? []).toHaveLength(0);
  const del = await other.c.from('forms').delete().eq('id', id).select('id');
  expect(del.error).toBeNull();
  expect(del.data ?? []).toHaveLength(0);

  const still = await owner.c.from('forms').select('name').eq('id', id).single();
  expect(still.data!.name).toBe('mine');
  await owner.c.from('forms').delete().eq('id', id);
});

testWithSupabase('a viewer (demo member) reads the six demo forms and cannot write', async (ctx) => {
  needsFormsTable(ctx);
  // A demo guest: an anonymous sign-in, the only kind of session the demo takes.
  const v = client();
  const guest = await signInAnon(v);
  expect(guest.error, guest.error?.message).toBeNull();
  const { data: demoId, error: joinError } = await joinDemo(v);
  expect(joinError, joinError?.message).toBeNull();

  // Through the same seam the page and the chat read.
  const forms = await createSupabaseReachData(v, demoId as string).listForms();
  expect(forms).toHaveLength(6);
  expect(forms.reduce((a, f) => a + f.views_count, 0)).toBe(2378);
  expect(forms.reduce((a, f) => a + f.submissions_count, 0)).toBe(428);
  expect(forms.map((f) => f.slug).sort()).toEqual([
    'demo-request', 'ebook-sme-growth', 'free-consult', 'newsletter', 'raya-promo', 'usahawan-meetup',
  ]);
  expect(forms.filter((f) => f.status === 'active')).toHaveLength(4);
  expect(forms.filter((f) => f.status === 'draft')).toHaveLength(2);
  // Newest first, and every column the Form type promises is there.
  expect(forms[0].slug).toBe('raya-promo');
  expect(Object.keys(forms[0]).sort()).toEqual([
    'category', 'channel', 'created_at', 'id', 'name', 'slug', 'status', 'submissions_count', 'updated_at', 'views_count',
  ]);

  const ins = await v.from('forms').insert({ org_id: demoId, name: 'nope', slug: slug('nope') });
  expect(ins.error?.code).toBe('42501');
  const upd = await v.from('forms').update({ name: 'hacked' }).eq('org_id', demoId).select('id');
  expect(upd.data ?? []).toHaveLength(0);
  const del = await v.from('forms').delete().eq('org_id', demoId).select('id');
  expect(del.data ?? []).toHaveLength(0);
  expect(await createSupabaseReachData(v, demoId as string).listForms()).toHaveLength(6);
  await v.auth.signOut();
});

testWithSupabase('a visitor who is not signed in is denied outright', async (ctx) => {
  needsFormsTable(ctx);
  const nobody = client();
  const read = await nobody.from('forms').select('id').limit(1);
  expect(read.error?.code).toBe('42501');
  const ins = await nobody.from('forms').insert({ org_id: owner.orgId, name: 'anon', slug: slug('anon') });
  expect(ins.error?.code).toBe('42501');
});

testWithSupabase('the capabilities write to the caller workspace and explain a taken link', async (ctx) => {
  needsFormsTable(ctx);
  const cap = { client: owner.c, orgId: owner.orgId };
  const name = `Cap Form ${Math.random().toString(36).slice(2, 8)}`;
  const created = await createForm(cap, { name });
  expect(created.ok, created.ok ? '' : created.error).toBe(true);
  if (!created.ok) return;
  expect(created.data).toMatchObject({ status: 'draft', views_count: 0, submissions_count: 0 });
  expect(created.data.slug).toMatch(/^cap-form-[a-z0-9]+$/);

  expect(await createForm(cap, { name: 'Other', slug: `/${created.data.slug}` })).toEqual({
    ok: false,
    error: 'Another form already uses that short name.',
  });
  const active = await setFormStatus(cap, { id: created.data.id, status: 'active' });
  expect(active).toMatchObject({ ok: true, data: { status: 'active' } });

  // Someone in another workspace gets "no longer exists", not a leak.
  expect(await deleteForm({ client: other.c, orgId: other.orgId }, { id: created.data.id })).toEqual({
    ok: false,
    error: 'That form no longer exists.',
  });
  expect(await deleteForm(cap, { id: created.data.id })).toEqual({ ok: true, data: { id: created.data.id } });
  expect(await deleteForm(cap, { id: created.data.id })).toEqual({ ok: false, error: 'That form no longer exists.' });
});
