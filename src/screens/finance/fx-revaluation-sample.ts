import type { RevaluationItem, RevaluationRun } from '@/lib/finance/fx-revaluation';

/**
 * What FX Revaluation shows when no database is connected: an invented workspace (Rimba Ventures Sdn Bhd) at the
 * month end before the sample's day (SAMPLE_TODAY, 10 October 2026), at Bank Negara Malaysia's 5 pm selling rates
 * of that day. The items are the plan's worked examples R1-R5: an invoice part paid, a supplier bill, a customer in
 * credit, a USD account, and an SGD account converted back to ringgit. Every figure is what the database works out
 * for them (round(balance x rate, 2), less what the item carries).
 */

export const SAMPLE_FX_MONTH_END = '2026-09-30';

const USD = { rate_text: '4.4800000000', rate_source: 'bnm' as const, rate_date: '2026-09-30', bnm_rate_text: '4.4800000000', bnm_rate_date: '2026-09-30' };

export const SAMPLE_FX_ITEMS: RevaluationItem[] = [
  {
    kind: 'invoice', item_id: 'sample-fx-a', reference: 'INV-0012', party: 'Harbour Freight Pte Ltd', currency: 'USD',
    foreign_balance: 600, carried_myr: 2520, earlier_myr: 0, ...USD,
    revalued_myr: 2688, difference: 168, posted_myr: 168, gain: 168, digest: null,
  },
  {
    kind: 'invoice', item_id: 'sample-fx-c', reference: 'INV-0015', party: 'Coastal Imports LLC', currency: 'USD',
    foreign_balance: -100, carried_myr: -420, earlier_myr: 0, ...USD,
    revalued_myr: -448, difference: -28, posted_myr: -28, gain: -28, digest: null,
  },
  {
    kind: 'bill', item_id: 'sample-fx-b', reference: 'BILL-0021', party: 'Pacific Components Inc', currency: 'USD',
    foreign_balance: 1080, carried_myr: 4536, earlier_myr: 0, ...USD,
    revalued_myr: 4838.4, difference: 302.4, posted_myr: 302.4, gain: -302.4, digest: null,
  },
  {
    kind: 'account', item_id: 'sample-fx-usd', reference: 'USD current account', party: null, currency: 'USD',
    foreign_balance: 9000, carried_myr: 40240, earlier_myr: 0, ...USD,
    revalued_myr: 40320, difference: 80, posted_myr: 80, gain: 80, digest: null,
  },
  {
    kind: 'account', item_id: 'sample-fx-sgd', reference: 'SGD account', party: null, currency: 'SGD',
    foreign_balance: 0, carried_myr: -30, earlier_myr: 0,
    rate_text: null, rate_source: null, rate_date: null, bnm_rate_text: '3.4500000000', bnm_rate_date: '2026-09-30',
    revalued_myr: 0, difference: 30, posted_myr: 30, gain: 30, digest: null,
  },
];

/** One run posted for the month before, at a typed USD rate. */
export const SAMPLE_FX_RUNS: RevaluationRun[] = [
  {
    id: 'sample-fx-run-1',
    revaluation_no: 'FX-0001',
    period_end: '2026-08-31',
    posted_at: '2026-09-02T02:15:00Z',
    posted_by: null,
    rates: [{ currency: 'USD', rate_text: '4.3000000000', rate_source: 'manual', rate_date: null }],
    lines: [
      {
        id: 'sample-fx-run-1-a', kind: 'invoice', item_id: 'sample-fx-a', reference: 'INV-0012', party: 'Harbour Freight Pte Ltd',
        currency: 'USD', foreign_balance: 1000, carried_myr: 4200, earlier_myr: 0, rate_text: '4.3000000000', rate_source: 'manual',
        rate_date: null, bnm_rate_text: null, bnm_rate_date: null, revalued_myr: 4300, difference: 100, posted_myr: 100, gain: 100, digest: null,
      },
      {
        id: 'sample-fx-run-1-usd', kind: 'account', item_id: 'sample-fx-usd', reference: 'USD current account', party: null,
        currency: 'USD', foreign_balance: 10000, carried_myr: 44620, earlier_myr: 0, rate_text: '4.3000000000', rate_source: 'manual',
        rate_date: null, bnm_rate_text: null, bnm_rate_date: null, revalued_myr: 43000, difference: -1620, posted_myr: -1620, gain: -1620, digest: null,
      },
    ],
    net_gain: -1520,
  },
];
