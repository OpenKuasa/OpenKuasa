import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, signInAnon, liveClient } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

// Activity log, in-app notifications and invites are written only through
// SECURITY DEFINER functions. Identities are anonymous sign-ins, as in
// tenancy.rls.test.ts; an anonymous user who creates an org is its owner.


function client(): SupabaseClient {
  return liveClient();
}

async function anonUser() {
  const c = client();
  const { data, error } = await signInAnon(c);
  expect(error, error?.message).toBeNull();
  return { c, uid: data.user!.id };
}

let owner: Awaited<ReturnType<typeof anonUser>> & { orgId: string };
let stranger: Awaited<ReturnType<typeof anonUser>>;

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const o = await anonUser();
  const { data: orgId, error } = await createOrg(o.c, 'Events Test Sdn Bhd');
  expect(error, error?.message).toBeNull();
  owner = { ...o, orgId: orgId as string };
  stranger = await anonUser();
});

afterAll(async () => {
  await owner?.c.auth.signOut();
  await stranger?.c.auth.signOut();
});

testWithSupabase('log_event writes an activity row only the org can read', async () => {
  const { error } = await owner.c.rpc('log_event', {
    p_action: 'Changed password',
    p_category: 'security',
  });
  expect(error, error?.message).toBeNull();

  const { data } = await owner.c
    .from('activity_log')
    .select('action, category, actor_id')
    .eq('org_id', owner.orgId);
  expect(data).toEqual([
    { action: 'Changed password', category: 'security', actor_id: owner.uid },
  ]);

  const { data: leaked } = await stranger.c
    .from('activity_log')
    .select('id')
    .eq('org_id', owner.orgId);
  expect(leaked ?? []).toHaveLength(0);
});

testWithSupabase('activity rows cannot be written directly', async () => {
  const { error } = await owner.c.from('activity_log').insert({
    org_id: owner.orgId,
    actor_name: 'forged',
    action: 'forged',
    category: 'auth',
  });
  expect(error).not.toBeNull();
});

testWithSupabase('a self notification is private and can be marked read', async () => {
  const { error } = await owner.c.rpc('log_event', {
    p_action: 'Changed password',
    p_category: 'security',
    p_notify: 'self',
    p_event: 'security',
    p_title: 'Your password was changed',
    p_href: '/account/security',
  });
  expect(error, error?.message).toBeNull();

  const { data: mine } = await owner.c
    .from('notifications')
    .select('id, title, href, read_at')
    .eq('user_id', owner.uid);
  expect(mine).toHaveLength(1);
  expect(mine![0]).toMatchObject({
    title: 'Your password was changed',
    href: '/account/security',
    read_at: null,
  });

  const { data: theirs } = await stranger.c
    .from('notifications')
    .select('id')
    .eq('user_id', owner.uid);
  expect(theirs ?? []).toHaveLength(0);

  const { data: read } = await owner.c
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', mine![0].id)
    .select('read_at');
  expect(read?.[0].read_at).not.toBeNull();

  // Only read_at is writable; the content is not.
  const { error: editErr } = await owner.c
    .from('notifications')
    .update({ title: 'edited' })
    .eq('id', mine![0].id);
  expect(editErr).not.toBeNull();
});

testWithSupabase('a muted event is not delivered, but security always is', async () => {
  const { error: prefErr } = await owner.c
    .from('profiles')
    .update({ notification_prefs: { channels: { inapp: false } } })
    .eq('user_id', owner.uid);
  expect(prefErr, prefErr?.message).toBeNull();

  const before = await owner.c.from('notifications').select('id');
  await owner.c.rpc('log_event', {
    p_action: 'Did a thing',
    p_category: 'data',
    p_notify: 'self',
    p_event: 'team_activity',
    p_title: 'Muted',
  });
  await owner.c.rpc('log_event', {
    p_action: 'Did a secure thing',
    p_category: 'security',
    p_notify: 'self',
    p_event: 'security',
    p_title: 'Always on',
  });
  const after = await owner.c.from('notifications').select('title');
  expect((after.data ?? []).length - (before.data ?? []).length).toBe(1);
  expect((after.data ?? []).map((n) => n.title)).toContain('Always on');
  expect((after.data ?? []).map((n) => n.title)).not.toContain('Muted');
});

testWithSupabase('an owner can create an invite that is readable by its token', async () => {
  const { data: token, error } = await owner.c.rpc('create_invite', {
    p_email: '  New.Person@Example.com ',
    p_role: 'member',
  });
  expect(error, error?.message).toBeNull();

  // The token is the secret: even a signed-out client can look it up.
  const { data: invite } = await client().rpc('get_invite', { p_token: token });
  expect(invite).toEqual([
    {
      org_name: 'Events Test Sdn Bhd',
      email: 'new.person@example.com',
      role: 'member',
      status: 'pending',
    },
  ]);

  // But the invite list itself is admin-only.
  const { data: leaked } = await stranger.c.from('org_invites').select('id');
  expect(leaked ?? []).toHaveLength(0);
});

testWithSupabase('invites are refused for non-admins and for the wrong email', async () => {
  const { error: notAdmin } = await stranger.c.rpc('create_invite', {
    p_email: 'x@example.com',
    p_role: 'member',
  });
  expect(notAdmin).not.toBeNull();

  const { data: token } = await owner.c.rpc('create_invite', {
    p_email: 'someone.else@example.com',
    p_role: 'admin',
  });
  const { error: wrongEmail } = await stranger.c.rpc('accept_invite', {
    p_token: token,
  });
  expect(wrongEmail?.message).toContain('another email');
});

testWithSupabase('an owner cannot change or remove their own membership', async () => {
  const { error: roleErr } = await owner.c.rpc('set_member_role', {
    p_user: owner.uid,
    p_role: 'viewer',
  });
  expect(roleErr).not.toBeNull();
  const { error: removeErr } = await owner.c.rpc('remove_member', {
    p_user: owner.uid,
  });
  expect(removeErr).not.toBeNull();
});
