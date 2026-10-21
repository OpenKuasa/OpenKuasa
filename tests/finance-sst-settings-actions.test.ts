import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * saveSstSettingsAction (#222 stage 1): an owner or admin outside the demo saves; a member is told who may,
 * before anything is written; a viewer and the demo are refused. The SST Report screen is refreshed.
 */
const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: false } as {
    userId: string; orgId: string; role: string; isDemo: boolean;
  },
  saved: [] as { orgId: string; input: unknown }[],
  revalidated: [] as string[],
  answer: { ok: true } as { ok: true } | { ok: false; error: string },
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    ctl.revalidated.push(path);
  },
}));
vi.mock('@/lib/finance/sst', async (orig) => ({
  ...(await orig<typeof import('@/lib/finance/sst')>()),
  saveSstSettings: async (ctx: { orgId: string }, input: unknown) => {
    ctl.saved.push({ orgId: ctx.orgId, input });
    return ctl.answer;
  },
}));

const { saveSstSettingsAction } = await import('@/app/(app)/finance/actions');

const INPUT = { period_start_month: 9, service_tax_no: ' W10-1 ', sales_tax_no: '', service_tax_basis: 'payment' };
const NEEDS = { ok: false, error: 'Only an owner or admin can change SST settings.' };

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: false };
  ctl.saved = [];
  ctl.revalidated = [];
  ctl.answer = { ok: true };
});

describe('saveSstSettingsAction', () => {
  it.each(['owner', 'admin'])('saves for an %s, parsed, and refreshes the SST Report', async (role) => {
    ctl.viewer.role = role;
    expect(await saveSstSettingsAction(INPUT)).toEqual({ ok: true, data: null });
    expect(ctl.saved).toEqual([
      { orgId: 'org1', input: { period_start_month: 9, service_tax_no: 'W10-1', sales_tax_no: null, service_tax_basis: 'payment' } },
    ]);
    expect(ctl.revalidated).toEqual(['/finance/sst-report']);
  });

  it('tells a member who may, without writing', async () => {
    ctl.viewer.role = 'member';
    expect(await saveSstSettingsAction(INPUT)).toEqual(NEEDS);
    expect(ctl.saved).toEqual([]);
  });

  it('refuses a viewer and the demo', async () => {
    ctl.viewer.role = 'viewer';
    expect((await saveSstSettingsAction(INPUT)).ok).toBe(false);
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true };
    expect((await saveSstSettingsAction(INPUT)).ok).toBe(false);
    expect(ctl.saved).toEqual([]);
  });

  it('answers a bad month with the schema message, without writing', async () => {
    const r = await saveSstSettingsAction({ ...INPUT, period_start_month: 13 });
    expect(r).toEqual({ ok: false, error: 'Choose the month the first taxable period starts.' });
    expect(ctl.saved).toEqual([]);
  });

  it('passes on the database refusal', async () => {
    ctl.answer = { ok: false, error: NEEDS.error };
    expect(await saveSstSettingsAction(INPUT)).toEqual(NEEDS);
  });
});
