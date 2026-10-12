/**
 * Live test of who may create a workspace and who may join the demo, against the
 * real database. It needs 20261030131500_demo_guests_cannot_create_workspaces.sql
 * applied; until then the refusals below do not happen and it fails. Skipped
 * without Supabase env vars; the signed-up accounts need the service key (see
 * `signInOwner` in the helper).
 *
 * A demo guest is an anonymous sign-in. A signed-up account is one the helper
 * creates already confirmed, with a generated test address.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, joinDemo, liveClient, signInAnon, signInOwner } from './helpers/live-workspaces';
import { WORKSPACE_NAME_MAX } from '@/lib/auth/workspace-name';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

type Who = { c: SupabaseClient; uid: string };

let guest: Who; // a demo guest who has joined the demo
let loose: Who; // an anonymous sign-in in no workspace
let account: Who; // a signed-up account
let demoId: string;

async function memberships(who: Who) {
  const { data, error } = await who.c.from('org_members').select('org_id, role').eq('user_id', who.uid);
  expect(error, error?.message).toBeNull();
  return data ?? [];
}

beforeAll(async () => {
  if (!hasSupabaseEnv) return;

  const g = liveClient();
  const guestIn = await signInAnon(g);
  expect(guestIn.error, guestIn.error?.message).toBeNull();
  guest = { c: g, uid: guestIn.data.user!.id };
  const joined = await joinDemo(g);
  expect(joined.error, joined.error?.message).toBeNull();
  demoId = joined.data as string;

  const l = liveClient();
  const looseIn = await signInAnon(l);
  expect(looseIn.error, looseIn.error?.message).toBeNull();
  loose = { c: l, uid: looseIn.data.user!.id };

  const a = liveClient();
  const accountIn = await signInOwner(a);
  account = { c: a, uid: accountIn.userId };
});

afterAll(async () => {
  await guest?.c.auth.signOut();
  await loose?.c.auth.signOut();
  await account?.c.auth.signOut();
});

testWithSupabase('a demo guest joins the demo as a viewer, and only that', async () => {
  expect(await memberships(guest)).toEqual([{ org_id: demoId, role: 'viewer' }]);
});

testWithSupabase('a demo guest cannot create a workspace, in the demo or out of it', async () => {
  for (const who of [guest, loose]) {
    const made = await createOrg(who.c, 'Guest Made Sdn Bhd');
    expect(made.data).toBeNull();
    expect(made.error?.message).toContain('demo guests cannot create a workspace');
  }
  expect(await memberships(guest)).toEqual([{ org_id: demoId, role: 'viewer' }]);
  expect(await memberships(loose)).toEqual([]);
});

testWithSupabase('a signed-up account creates a workspace, owns it, and its name is stored trimmed', async () => {
  const made = await createOrg(account.c, '  Signed Up Sdn Bhd \n');
  expect(made.error, made.error?.message).toBeNull();
  const orgId = made.data as string;

  expect(await memberships(account)).toEqual([{ org_id: orgId, role: 'owner' }]);
  const { data: org } = await account.c.from('orgs').select('name').eq('id', orgId).maybeSingle();
  expect(org?.name).toBe('Signed Up Sdn Bhd');
});

testWithSupabase('a workspace needs a name, of at most the length the form allows', async () => {
  const before = await memberships(account);

  for (const blank of ['', '   ', '\n\t ']) {
    const made = await createOrg(account.c, blank);
    expect(made.data).toBeNull();
    expect(made.error?.message).toContain('workspace name required');
  }
  const long = await createOrg(account.c, 'a'.repeat(WORKSPACE_NAME_MAX + 1));
  expect(long.data).toBeNull();
  expect(long.error?.message).toContain('workspace name too long');
  expect(await memberships(account)).toEqual(before);

  // Padding does not count towards the length.
  const longest = await createOrg(account.c, ` ${'a'.repeat(WORKSPACE_NAME_MAX)} `);
  expect(longest.error, longest.error?.message).toBeNull();
  expect(await memberships(account)).toHaveLength(before.length + 1);
});

testWithSupabase('a signed-up account cannot join the demo', async () => {
  const before = await memberships(account);
  const joined = await joinDemo(account.c);
  expect(joined.data).toBeNull();
  expect(joined.error?.message).toContain('the demo is for guests only');
  expect(await memberships(account)).toEqual(before);
  expect(before.map((m) => m.org_id)).not.toContain(demoId);
});

testWithSupabase('a demo guest cannot accept an invite to a workspace', async () => {
  const invite = await account.c.rpc('create_invite', {
    p_email: 'invited.person@example.com',
    p_role: 'admin',
  });
  expect(invite.error, invite.error?.message).toBeNull();

  for (const who of [guest, loose]) {
    const accepted = await who.c.rpc('accept_invite', { p_token: invite.data });
    expect(accepted.error?.message).toContain('another email');
  }
  expect(await memberships(guest)).toEqual([{ org_id: demoId, role: 'viewer' }]);
  expect(await memberships(loose)).toEqual([]);
});
