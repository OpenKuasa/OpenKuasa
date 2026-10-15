import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BankingView } from '@/components/finance/banking-view';
import { workspaceUsesForeignCurrency } from '@/lib/finance/fx-card-gate';

/**
 * Stage 1 adds neither a contact's default currency nor a quotation's currency, so no workspace can deal in another
 * currency: the real gate answers false, and a ringgit-only workspace's Banking does not draw the rates card.
 * Stage 2 implements the gate and changes the first test.
 */

vi.mock('@/components/charts', () => ({ AreaTrend: () => null, RadialGauge: () => null }));

const base = { accounts: [], rows: [], today: '2026-10-15', followClock: false };
const usd = { currency: 'USD', rate_date: '2026-10-15', unit: 1, middle_rate: 4.0815, rate: 4.0815 };

describe('the exchange-rates card on Banking', () => {
  it('is never asked for in stage 1: the gate is false for every workspace', async () => {
    expect(await workspaceUsesForeignCurrency({} as never, 'org')).toBe(false);
  });

  it('is not drawn when the screen passes no rates (a ringgit-only workspace, the sample)', () => {
    expect(renderToStaticMarkup(<BankingView {...base} />)).not.toContain('Exchange rates');
  });

  it('is drawn when the screen passes rates, or passes that they could not be read', () => {
    expect(renderToStaticMarkup(<BankingView {...base} fxRates={[usd]} />)).toContain('Exchange rates');
    expect(renderToStaticMarkup(<BankingView {...base} fxRates={null} />)).toContain('could not be loaded');
  });
});
