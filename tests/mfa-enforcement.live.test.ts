import { expect, test } from 'vitest';
import { generateRecoveryCodes, hashRecoveryCode } from '@/lib/auth/mfa';
import './setup/supabase';
import { totp } from './helpers/totp';
import { createOrg, liveClient, signUpTestUser } from './helpers/live-workspaces';

// Live check that a password-only session of a 2FA user gets nothing from the
// data API until it passes the second factor. Opt-in (RUN_MFA_LIVE=1): each
// run signs up a real email user, which the shared live-workspaces helper deletes afterwards.

const client = liveClient;
const nextWindow = () =>
  new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 1_500));

const liveTest = process.env.RUN_MFA_LIVE === '1' ? test : test.skip;

liveTest('aal1 session of a 2FA user is locked out of the data API', async () => {
  const password = 'enforce-pass-123';

  const a = client();
  const { email, ...signUp } = await signUpTestUser(a, password);
  expect(signUp.error, signUp.error?.message).toBeNull();
  const uid = signUp.data.user!.id;
  const org = await createOrg(a, 'QA Enforce Sdn Bhd');
  expect(org.error, org.error?.message).toBeNull();

  // Before 2FA: normal access.
  const before = await a.from('profiles').select('user_id').eq('user_id', uid);
  expect(before.data).toHaveLength(1);

  const enroll = await a.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: `t-${Date.now()}`,
  });
  expect(enroll.error, enroll.error?.message).toBeNull();
  const secret = enroll.data!.totp.secret;
  const factorId = enroll.data!.id;
  const verify = await a.auth.mfa.challengeAndVerify({
    factorId,
    code: totp(secret),
  });
  expect(verify.error, verify.error?.message).toBeNull();

  // aal2 session: full access, and may mint recovery codes.
  const codes = generateRecoveryCodes();
  const minted = await a.rpc('replace_recovery_codes', {
    p_hashes: codes.map(hashRecoveryCode),
  });
  expect(minted.error, minted.error?.message).toBeNull();
  expect(minted.data).toBe(10);
  const invite = await a.rpc('create_invite', {
    p_email: 'someone@example.com',
    p_role: 'member',
  });
  expect(invite.error, invite.error?.message).toBeNull();

  // A second session with only the password.
  const b = client();
  const signIn = await b.auth.signInWithPassword({ email, password });
  expect(signIn.error, signIn.error?.message).toBeNull();
  const aal = await b.auth.mfa.getAuthenticatorAssuranceLevel();
  expect(aal.data).toMatchObject({ currentLevel: 'aal1', nextLevel: 'aal2' });

  expect((await b.from('profiles').select('user_id')).data).toEqual([]);
  expect((await b.from('orgs').select('id')).data).toEqual([]);
  expect((await b.from('org_members').select('org_id')).data).toEqual([]);
  expect((await b.from('activity_log').select('id')).data).toEqual([]);
  expect((await b.from('notifications').select('id')).data).toEqual([]);
  expect((await b.from('org_invites').select('id')).data).toEqual([]);

  const edit = await b
    .from('profiles')
    .update({ full_name: 'hacked' })
    .eq('user_id', uid)
    .select('user_id');
  expect(edit.data ?? []).toEqual([]);
  const badInvite = await b.rpc('create_invite', {
    p_email: 'attacker@example.com',
    p_role: 'admin',
  });
  expect(badInvite.error).not.toBeNull();
  const badAccept = await b.rpc('accept_invite', { p_token: invite.data });
  expect(badAccept.error?.message).toContain('second factor required');
  const badMint = await b.rpc('replace_recovery_codes', {
    p_hashes: [hashRecoveryCode('AAAAA-BBBBB')],
  });
  expect(badMint.error?.message).toContain('second factor required');
  const upload = await b.storage
    .from('avatars')
    .upload(`${uid}/x.png`, new Blob(['x'], { type: 'image/png' }));
  expect(upload.error).not.toBeNull();
  await b.rpc('log_event', { p_action: 'forged', p_category: 'auth' });
  const badOrg = await createOrg(b, 'Forged Sdn Bhd');
  expect(badOrg.error?.message).toContain('second factor required');
  const badDemo = await b.rpc('join_demo_org');
  expect(badDemo.error?.message).toContain('second factor required');
  // Ask-Jebat quota answers "denied" (-1), the same as having no session.
  expect((await b.rpc('consume_ai_quota', { daily_limit: 50 })).data).toBe(-1);
  expect((await a.rpc('consume_ai_quota', { daily_limit: 50 })).data).toBe(49);

  // Nothing leaked through: checked from the fully verified session.
  const log = await a.from('activity_log').select('action');
  expect((log.data ?? []).map((r) => r.action)).not.toContain('forged');
  const name = await a.from('profiles').select('full_name').eq('user_id', uid);
  expect(name.data?.[0].full_name).not.toBe('hacked');

  // After the code, the same session works.
  await nextWindow();
  const second = await b.auth.mfa.challengeAndVerify({
    factorId,
    code: totp(secret),
  });
  expect(second.error, second.error?.message).toBeNull();
  expect((await b.from('profiles').select('user_id')).data).toHaveLength(1);
  expect((await b.from('orgs').select('id')).data).toHaveLength(1);

  // Recovery path from a third password-only session.
  const c = client();
  await c.auth.signInWithPassword({ email, password });
  const wrong = await c.rpc('redeem_recovery_code', {
    p_hash: hashRecoveryCode('AAAAA-BBBBB'),
  });
  expect(wrong.data).toBe(false);
  const right = await c.rpc('redeem_recovery_code', {
    p_hash: hashRecoveryCode(codes[3]),
  });
  expect(right.data).toBe(true);
  // Even before refreshing its token, the session is no longer blocked.
  expect((await c.from('profiles').select('user_id')).data).toHaveLength(1);
  await c.auth.refreshSession();
  const after = await c.auth.mfa.getAuthenticatorAssuranceLevel();
  expect(after.data?.nextLevel).toBe('aal1');
}, 120_000);
