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

// A session client whose agent_proposals row + update we control.
const proposalRow = {
  id: 'p1',
  action: 'promoteLeadToContact',
  input: { id: '33333333-3333-4333-8333-333333333333' },
  status: 'pending',
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
};
let loaded: Record<string, unknown> | null = proposalRow;
const updates: unknown[] = [];
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: loaded }) }) }) }),
      update: (patch: unknown) => {
        updates.push(patch);
        return {
          eq: () => ({
            eq: () => ({
              eq: async () => ({ error: null }),
            }),
          }),
        };
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
});

describe('applyProposalAction', () => {
  beforeEach(() => {
    loaded = { ...proposalRow };
    updates.length = 0;
    (getViewer as ReturnType<typeof vi.fn>).mockResolvedValue({ orgId: 'org-1', role: 'owner', isDemo: false });
  });

  it('applies a pending proposal and marks it approved', async () => {
    const res = await applyProposalAction({ id: '44444444-4444-4444-8444-444444444444' });
    expect(res.ok).toBe(true);
    expect(updates[0]).toMatchObject({ status: 'approved' });
  });
  it('apply denied without edit permission', async () => {
    (getViewer as ReturnType<typeof vi.fn>).mockResolvedValue({ orgId: 'org-1', role: 'viewer', isDemo: false });
    const res = await applyProposalAction({ id: '44444444-4444-4444-8444-444444444444' });
    expect(res.ok).toBe(false);
    expect(updates).toHaveLength(0);
  });
  it('apply is a no-op when not pending', async () => {
    loaded = { ...proposalRow, status: 'approved' };
    const res = await applyProposalAction({ id: '44444444-4444-4444-8444-444444444444' });
    expect(res.ok).toBe(false);
    expect(updates).toHaveLength(0);
  });
  it('apply is a no-op when expired', async () => {
    loaded = { ...proposalRow, expires_at: new Date(Date.now() - 1000).toISOString() };
    const res = await applyProposalAction({ id: '44444444-4444-4444-8444-444444444444' });
    expect(res.ok).toBe(false);
    expect(updates).toHaveLength(0);
  });
  it('apply of a missing target records failed', async () => {
    (promoteLeadToContact as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: 'That lead was not found.' });
    const res = await applyProposalAction({ id: '44444444-4444-4444-8444-444444444444' });
    expect(res.ok).toBe(false);
    expect(updates[0]).toMatchObject({ status: 'failed' });
  });
});

describe('rejectProposalAction', () => {
  it('is denied for a viewer', async () => {
    (getViewer as ReturnType<typeof vi.fn>).mockResolvedValue({ orgId: 'org-1', role: 'viewer', isDemo: false });
    const res = await rejectProposalAction({ id: '44444444-4444-4444-8444-444444444444' });
    expect(res.ok).toBe(false);
  });
});
