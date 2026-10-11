import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/reach/capabilities', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/reach/capabilities')>();
  return {
    ...actual,
    promoteLeadToContact: vi.fn(async () => ({ ok: true, data: { contact_id: 'c1', contact: { id: 'c1', name: 'Aina' } } })),
    createForm: vi.fn(async () => ({ ok: true, data: { id: 'f1', status: 'draft' } })),
  };
});
vi.mock('@/lib/auth/viewer', () => ({ getViewer: vi.fn() }));
vi.mock('@/lib/auth/permissions', () => ({ can: (role: string, _p: string) => role !== 'viewer' }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// A session client whose update() chains we control.
type Update = { patch: Record<string, unknown>; chain: string[] };
let claimResult: Record<string, unknown> | null = null;
let rejectResult: Record<string, unknown> | null = null;
const updates: Update[] = [];
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        const u: Update = { patch, chain: [] };
        updates.push(u);
        const q: Record<string, unknown> = {};
        for (const m of ['eq', 'gt', 'select']) q[m] = () => { u.chain.push(m); return q; };
        q.maybeSingle = async () => ({ data: patch.status === 'rejected' ? rejectResult : claimResult });
        q.then = (res: (v: unknown) => unknown) => res({ error: null });
        return q;
      },
    }),
  }),
}));

import { runProposalAction, isAllowedAction, ALLOWED_ACTION_NAMES } from '@/lib/agents/apply-proposal';
import { promoteLeadToContact } from '@/lib/reach/capabilities';
import { getViewer } from '@/lib/auth/viewer';
import { applyProposalAction, rejectProposalAction } from '@/app/(app)/reach/actions';

const ctx = { client: {} as never, orgId: 'org-1' };

describe('runProposalAction', () => {
  it('dispatches an allow-listed action after re-validating its input', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const res = await runProposalAction(ctx, 'promoteLeadToContact', { id });
    expect(res).toEqual({ ok: true, result: { contact_id: 'c1', contact: { id: 'c1', name: 'Aina' } } });
    expect(promoteLeadToContact).toHaveBeenCalledWith(ctx, { id });
  });

  it('rejects a non-allowlisted action', async () => {
    expect(isAllowedAction('deleteLead')).toBe(false);
    const res = await runProposalAction(ctx, 'deleteLead', { id: '1' });
    expect(res).toEqual({ ok: false, error: 'That action is not allowed.' });
  });

  it('allow-list is exactly the seven non-destructive actions', () => {
    expect([...ALLOWED_ACTION_NAMES].sort()).toEqual(
      [
        'createAppointment',
        'createForm',
        'promoteLeadToContact',
        'setAppointmentStatus',
        'setLeadStage',
        'updateAppointment',
        'updateForm',
      ].sort(),
    );
  });

  it('rejects input that no longer matches the capability schema', async () => {
    const res = await runProposalAction(ctx, 'promoteLeadToContact', { id: 'not-a-uuid' });
    expect(res.ok).toBe(false);
  });

  it('surfaces a capability failure (missing target) as ok:false', async () => {
    (promoteLeadToContact as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: 'That lead was not found.' });
    const id = '22222222-2222-4222-8222-222222222222';
    const res = await runProposalAction(ctx, 'promoteLeadToContact', { id });
    expect(res).toEqual({ ok: false, error: 'That lead was not found.' });
  });

  it('catches a capability that throws and returns ok:false', async () => {
    (promoteLeadToContact as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network boom'));
    const id = '55555555-5555-4555-8555-555555555555';
    const res = await runProposalAction(ctx, 'promoteLeadToContact', { id });
    expect(res.ok).toBe(false);
  });
});

const ID = '44444444-4444-4444-8444-444444444444';
const claimRow = { action: 'promoteLeadToContact', input: { id: '33333333-3333-4333-8333-333333333333' } };

describe('applyProposalAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimResult = { ...claimRow };
    rejectResult = null;
    updates.length = 0;
    (getViewer as ReturnType<typeof vi.fn>).mockResolvedValue({ orgId: 'org-1', role: 'owner', isDemo: false });
  });

  it('claims then applies under the owner session, with no failure flip', async () => {
    const res = await applyProposalAction({ id: ID });
    expect(res).toEqual({ ok: true });
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toMatchObject({ status: 'approved' });
    expect(updates[0].chain).toEqual(['eq', 'eq', 'eq', 'gt', 'select']);
    expect(promoteLeadToContact).toHaveBeenCalledTimes(1);
    const [calledCtx, calledInput] = (promoteLeadToContact as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledCtx.orgId).toBe('org-1');
    expect(calledInput).toEqual(claimRow.input);
  });
  it('denied without edit permission', async () => {
    (getViewer as ReturnType<typeof vi.fn>).mockResolvedValue({ orgId: 'org-1', role: 'viewer', isDemo: false });
    const res = await applyProposalAction({ id: ID });
    expect(res.ok).toBe(false);
    expect(updates).toHaveLength(0);
    expect(promoteLeadToContact).not.toHaveBeenCalled();
  });
  it('is a no-op when the claim loses (already handled or expired)', async () => {
    claimResult = null;
    const res = await applyProposalAction({ id: ID });
    expect(res.ok).toBe(false);
    expect(promoteLeadToContact).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
  });
  it('flips approved to failed when the capability fails after the claim', async () => {
    (promoteLeadToContact as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: 'That lead was not found.' });
    const res = await applyProposalAction({ id: ID });
    expect(res.ok).toBe(false);
    expect(updates).toHaveLength(2);
    expect(updates[0].patch).toMatchObject({ status: 'approved' });
    expect(updates[1].patch).toMatchObject({ status: 'failed', result: { error: 'That lead was not found.' } });
    expect(updates[1].chain).toEqual(['eq', 'eq']);
  });
  it('flips approved to failed when the capability throws after the claim', async () => {
    (promoteLeadToContact as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network boom'));
    const res = await applyProposalAction({ id: ID });
    expect(res.ok).toBe(false);
    expect(updates).toHaveLength(2);
    expect(updates[1].patch).toMatchObject({ status: 'failed' });
  });
});

describe('rejectProposalAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updates.length = 0;
    (getViewer as ReturnType<typeof vi.fn>).mockResolvedValue({ orgId: 'org-1', role: 'owner', isDemo: false });
  });
  it('is denied for a viewer', async () => {
    (getViewer as ReturnType<typeof vi.fn>).mockResolvedValue({ orgId: 'org-1', role: 'viewer', isDemo: false });
    const res = await rejectProposalAction({ id: ID });
    expect(res.ok).toBe(false);
    expect(updates).toHaveLength(0);
  });
  it('rejects a pending proposal', async () => {
    rejectResult = { id: 'p1' };
    const res = await rejectProposalAction({ id: ID });
    expect(res).toEqual({ ok: true });
    expect(updates[0].patch).toMatchObject({ status: 'rejected' });
    expect(promoteLeadToContact).not.toHaveBeenCalled();
  });
  it('reports already handled when nothing matched', async () => {
    rejectResult = null;
    const res = await rejectProposalAction({ id: ID });
    expect(res.ok).toBe(false);
  });
});
