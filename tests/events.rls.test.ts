import { afterAll, beforeAll, expect, test } from 'vitest';
import { type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createOrg, signInAnon, liveClient, signInOwner } from './helpers/live-workspaces';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

// Activity log, in-app notifications and invites are written only through
// SECURITY DEFINER functions. The owner is a signed-up account (only
// those may create a workspace); the stranger is an anonymous sign-in.


function client(): SupabaseClient {
  return liveClient();
}

// The owner is a signed-up account (only those may create a workspace); everyone
// else is an anonymous sign-in.
async function anonUser(signIn: typeof signInAnon | typeof signInOwner = signInAnon) {
  const c = client();
  const { data, error } = await signIn(c);
  expect(error, error?.message).toBeNull();
  return { c, uid: data.user!.id };
}

let owner: Awaited<ReturnType<typeof anonUser>> & { orgId: string };
let stranger: Awaited<ReturnType<typeof anonUser>>;

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const o = await anonUser(signInOwner);
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
  const { error } = await owner.c.rpc('log_event', { p_key: 'password_changed' });
  expect(error, error?.message).toBeNull();

  const { data } = await owner.c
    .from('activity_log')
    .select('action, category, actor_id, audience')
    .eq('org_id', owner.orgId);
  expect(data).toEqual([
    { action: 'Changed password', category: 'security', actor_id: owner.uid, audience: 'members' },
  ]);

  const { data: leaked } = await stranger.c
    .from('activity_log')
    .select('id')
    .eq('org_id', owner.orgId);
  expect(leaked ?? []).toHaveLength(0);
});

testWithSupabase('log_event takes a known key and no text', async () => {
  const unknown = await owner.c.rpc('log_event', { p_key: 'Forged sentence' });
  expect(unknown.error?.message).toContain('unknown event');

  // The earlier free-text form is gone.
  const freeText = await owner.c.rpc('log_event', {
    p_action: 'Forged sentence',
    p_category: 'security',
    p_notify: 'admins',
    p_event: 'security',
    p_title: 'Forged title',
  });
  expect(freeText.error).not.toBeNull();

  // An event that does not match the account's state writes nothing: this
  // account has no authenticator.
  const before = await owner.c.from('activity_log').select('id').eq('org_id', owner.orgId);
  const { error } = await owner.c.rpc('log_event', { p_key: 'mfa_enabled' });
  expect(error, error?.message).toBeNull();
  const after = await owner.c.from('activity_log').select('id').eq('org_id', owner.orgId);
  expect(after.data).toHaveLength(before.data!.length);

  const { data: forged } = await owner.c
    .from('activity_log')
    .select('id')
    .eq('org_id', owner.orgId)
    .eq('action', 'Forged sentence');
  expect(forged ?? []).toHaveLength(0);
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
  const { error } = await owner.c.rpc('log_event', { p_key: 'password_changed' });
  expect(error, error?.message).toBeNull();

  const { data: mine } = await owner.c
    .from('notifications')
    .select('id, title, href, read_at')
    .eq('user_id', owner.uid);
  expect(mine!.length).toBeGreaterThanOrEqual(1);
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

testWithSupabase('a sign-in notification is delivered even with in-app notifications off', async () => {
  const { error: prefErr } = await owner.c
    .from('profiles')
    .update({ notification_prefs: { channels: { inapp: false } } })
    .eq('user_id', owner.uid);
  expect(prefErr, prefErr?.message).toBeNull();

  const before = await owner.c.from('notifications').select('id');
  // No notification belongs to this event.
  await owner.c.rpc('log_event', { p_key: 'profile_updated' });
  // This one always notifies the caller, and only the caller.
  await owner.c.rpc('log_event', { p_key: 'password_reset' });
  const after = await owner.c.from('notifications').select('title, user_id');
  expect((after.data ?? []).length - (before.data ?? []).length).toBe(1);
  expect((after.data ?? []).map((n) => n.title)).toContain('Your password was reset');
  expect((after.data ?? []).every((n) => n.user_id === owner.uid)).toBe(true);
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

  // So is the activity entry that names the invited address.
  const { data: entry } = await owner.c
    .from('activity_log')
    .select('target, audience')
    .eq('org_id', owner.orgId)
    .like('action', 'Invited a member as %');
  expect(entry).toEqual([{ target: 'new.person@example.com', audience: 'admins' }]);
});

testWithSupabase('audit rows cannot be written from a session', async () => {
  const { error } = await owner.c.from('crm_audit_logs').insert({
    org_id: owner.orgId,
    actor_user_id: owner.uid,
    entity_type: 'contact',
    entity_id: owner.uid,
    action: 'forged',
  });
  expect(error).not.toBeNull();
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
  // (An address that matches but was never confirmed is refused with 'email not
  // confirmed'; that needs an unconfirmed account holding a session, which the
  // project's settings do not issue, so it is covered by the migration's text test.)
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
