import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Banking loader hands the view the rates only for a workspace that deals in another currency, and does not
 * read them otherwise. The gate is mocked here; tests/finance-fx-card-view.test.tsx runs the real one.
 */

vi.mock('@/app/(app)/finance/actions', () => ({
  createBankAccountAction: vi.fn(),
  fxSstRateForAction: vi.fn(),
  recordTransferAction: vi.fn(),
  setBankAccountActiveAction: vi.fn(),
  updateBankAccountAction: vi.fn(),
  voidTransferAction: vi.fn(),
}));

const state = vi.hoisted(() => ({
  reads: 0,
  uses: false,
}));
vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ orgId: 'org', role: 'owner', isDemo: false }),
  hasSupabaseEnv: () => true,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/finance/banking', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listBankAccounts: async () => [],
  listBankTransactions: async () => [],
}));
vi.mock('@/lib/finance/bank-accounts', () => ({ listBankAccountNumbers: async () => ({}) }));
vi.mock('@/lib/finance/fx-rates', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listLatestFxRates: async () => {
    state.reads += 1;
    return [{ currency: 'USD', rate_date: '2026-10-15', unit: 1, middle_rate: 4.0815, rate: 4.0815 }];
  },
}));
vi.mock('@/lib/finance/fx-card-gate', () => ({ workspaceUsesForeignCurrency: async () => state.uses }));
// Replace the view with a component that is never rendered: the element's props are what the loader decided.
vi.mock('@/components/finance/banking-view', () => ({ BankingView: () => null }));

import BankingScreen from '@/screens/finance/banking';

describe('the Banking screen and the exchange-rates card', () => {
  beforeEach(() => {
    state.reads = 0;
    state.uses = false;
  });

  it('passes no rates, and does not read them, for a ringgit-only workspace', async () => {
    const el = (await BankingScreen()) as { props: { fxRates?: unknown } };
    expect(el.props.fxRates).toBeUndefined();
    expect(state.reads).toBe(0);
  });

  it('passes the rates once the workspace deals in another currency', async () => {
    state.uses = true;
    const el = (await BankingScreen()) as { props: { fxRates?: unknown[] } };
    expect(el.props.fxRates).toHaveLength(1);
    expect(state.reads).toBe(1);
  });
});
