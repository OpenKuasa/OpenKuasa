import { expect, test } from 'vitest';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { createConfirmedTestUser, createOrg, liveClient, signInOwner } from './helpers/live-workspaces';

// SST return figures (finance_sst_return_figures, 20261125090400) against the
// hosted database. Workspaces are made through tests/helpers/live-workspaces.ts,
// which deletes what it creates. Run only once the migration is applied.

const testWithSupabase = hasSupabaseEnv ? test : test.skip;

if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

testWithSupabase('figures: an owner saves, a member reads only, a filed return is locked (FIN60)', async () => {
  const o = liveClient();
  const { error: authErr } = await signInOwner(o);
  expect(authErr, authErr?.message).toBeNull();
  const { data: orgId, error } = await createOrg(o, 'SST Figures A Sdn Bhd');
  expect(error, error?.message).toBeNull();
  const org = orgId as string;
  const ownerId = (await o.auth.getUser()).data.user!.id;

  const m = liveClient();
  const signUp = await createConfirmedTestUser(m, 'sst-figures-member-pass-123');
  const invite = await o.rpc('create_invite', { p_email: signUp.email, p_role: 'member' });
  expect(invite.error, invite.error?.message).toBeNull();
  const accepted = await m.rpc('accept_invite', { p_token: invite.data });
  expect(accepted.error, accepted.error?.message).toBeNull();

  const key = { org_id: org, tax_type: 'service', period_start: '2026-09-01' };

  // The member cannot save.
  const early = await m
    .from('finance_sst_return_figures')
    .insert({ ...key, cards_11e: 2 })
    .select('org_id');
  expect(early.error?.code).toBe('42501');

  // The owner saves; updated_by is the owner whatever was sent.
  const saved = await o
    .from('finance_sst_return_figures')
    .insert({ ...key, cards_11e: 3, deduction_13c: 12.5, updated_by: signUp.userId })
    .select('cards_11e, deduction_13c, updated_by');
  expect(saved.error, saved.error?.message).toBeNull();
  expect(saved.data).toEqual([{ cards_11e: 3, deduction_13c: 12.5, updated_by: ownerId }]);

  // The owner updates; the member reads it but cannot change or delete it.
  const updated = await o
    .from('finance_sst_return_figures')
    .update({ cards_11e: 4 })
    .match(key)
    .select('cards_11e');
  expect(updated.error, updated.error?.message).toBeNull();
  expect(updated.data).toEqual([{ cards_11e: 4 }]);
  const read = await m.from('finance_sst_return_figures').select('cards_11e').eq('org_id', org);
  expect(read.data).toEqual([{ cards_11e: 4 }]);
  const memberUpdate = await m.from('finance_sst_return_figures').update({ cards_11e: 9 }).eq('org_id', org).select('org_id');
  expect(memberUpdate.data ?? []).toEqual([]);
  const memberDelete = await m.from('finance_sst_return_figures').delete().eq('org_id', org).select('org_id');
  expect(memberDelete.data ?? []).toEqual([]);

  // The other type's column is refused.
  const wrong = await o
    .from('finance_sst_return_figures')
    .insert({ ...key, period_start: '2026-07-01', deduction_13b: 1 })
    .select('org_id');
  expect(wrong.error?.code).toBe('23514');

  // Mark the return filed: saving is refused with FIN60 and nothing changes.
  const mark = await o.from('finance_sst_returns').insert({ ...key, filed_on: '2026-10-20' }).select('org_id');
  expect(mark.error, mark.error?.message).toBeNull();
  const locked = await o.from('finance_sst_return_figures').update({ cards_11e: 8 }).match(key).select('cards_11e');
  expect(locked.error?.code).toBe('FIN60');
  expect(locked.error?.message).toContain('marked filed');

  // The key cannot be moved to dodge the lock.
  const moved = await o.from('finance_sst_return_figures').update({ period_start: '2026-03-01' }).match(key).select('cards_11e');
  expect(moved.error?.code).toBe('FIN61');

  // Undo the mark and the figures open again.
  const unmark = await o.from('finance_sst_returns').delete().match(key).select('org_id');
  expect(unmark.error, unmark.error?.message).toBeNull();
  const again = await o.from('finance_sst_return_figures').update({ cards_11e: 8 }).match(key).select('cards_11e');
  expect(again.error, again.error?.message).toBeNull();
  expect(again.data).toEqual([{ cards_11e: 8 }]);
});
