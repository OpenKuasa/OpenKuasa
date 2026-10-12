import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReportsView } from '@/components/finance/reports-view';
import { monthlyTotals, type MonthlyTotals, type ReportAccount } from '@/lib/finance/reports';
import { SAMPLE_LEDGER_ACCOUNTS, SAMPLE_LEDGER_LINES } from '@/screens/finance/ledger-sample';
import { SAMPLE_TODAY } from '@/screens/finance/sales-sample';

/**
 * The Reports screen, as the server sends it: rendered to a string and read as markup. There is no DOM here
 * (node, no jsdom), so nothing can be pressed or typed: the sums and the periods are in plain functions
 * (tests/finance-reports.test.ts). What still needs a browser is checked by hand.
 */

// A closed select draws no options. Here its options are drawn in place, and the chosen one is marked.
vi.mock('@/components/ui/select', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Select: ({ value, children }: { value?: string; children?: ReactNode }) => <div data-chosen={value}>{children}</div>,
    SelectTrigger: Pass,
    SelectValue: () => null,
    SelectContent: Pass,
    SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => <span data-option={value}>{children}</span>,
  };
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const accounts: ReportAccount[] = SAMPLE_LEDGER_ACCOUNTS.map(({ id, code, name, type }) => ({ id, code, name, type }));
const { totals: sampleTotals } = monthlyTotals(SAMPLE_LEDGER_LINES);

const render = (over: { totals?: MonthlyTotals; unassigned?: number; today?: string } = {}) =>
  renderToStaticMarkup(
    <ReportsView
      accounts={accounts}
      totals={over.totals ?? sampleTotals}
      unassigned={over.unassigned}
      today={over.today ?? SAMPLE_TODAY}
      followClock={false}
    />,
  );

describe('the Reports screen', () => {
  it('keeps its title and says the period in words, This year by default', () => {
    const html = render();
    expect(text(html)).toContain('Financial Reports January to October 2026');
    expect(html).toContain('data-chosen="this_year"');
  });

  it('offers the seven periods', () => {
    const html = render();
    const options = [...html.matchAll(/data-option="(\w+)">([^<]+)</g)].map(([, key, label]) => [key, label]);
    expect(options).toEqual([
      ['this_month', 'This month'], ['last_month', 'Last month'], ['this_quarter', 'This quarter'], ['this_year', 'This year'],
      ['last_year', 'Last year'], ['all_time', 'All time'], ['custom', 'Custom'],
    ]);
    // The two month boxes come with Custom.
    expect(html).not.toContain('type="month"');
    expect(html).not.toContain('role="alert"');
  });

  it('shows the headline figures of the default period: income 9,000, expenses 3,450, profit 5,550, margin 61.7%', () => {
    const html = text(render());
    expect(html).toContain('Revenue RM 9,000.00');
    expect(html).toContain('Expenses RM 3,450.00');
    expect(html).toContain('Net profit RM 5,550.00');
    expect(html).toContain('Profit margin 61.7%');
  });

  it('shows the profit and loss with its lines and totals', () => {
    const html = text(render());
    expect(html).toContain('Profit &amp; Loss January to October 2026');
    expect(html).toContain('Income 4000 Sales RM 9,000.00 Total income RM 9,000.00');
    expect(html).toContain('Expenses 5000 Purchases RM 1,500.00 6100 Office Rent RM 1,200.00 6200 Depreciation RM 400.00 6300 Utilities RM 350.00 Total expenses RM 3,450.00');
    expect(html).toContain('Net profit RM 5,550.00');
  });

  it('shows the balance sheet as at the end of the last month, with current earnings under equity', () => {
    const html = text(render());
    expect(html).toContain('Balance Sheet As at 31 October 2026');
    expect(html).toContain('Assets 1100 Main Bank RM 53,300.00 1200 Trade Receivables RM 4,240.00 1500 Accumulated Depreciation RM -400.00 Total assets RM 57,140.00');
    expect(html).toContain('Liabilities 2000 Trade Payables RM 1,050.00 2100 SST Payable RM 540.00 Total liabilities RM 1,590.00');
    expect(html).toContain('Equity 3000 Owner’s Capital RM 50,000.00 Current earnings RM 5,550.00 Total equity RM 55,550.00');
    expect(html).toContain('Total liabilities and equity RM 57,140.00');
  });

  it('says the sheet balances, with no alarm', () => {
    const html = render();
    expect(text(html)).toContain('Balances');
    expect(text(html)).not.toContain('Out of balance');
    expect(html).not.toContain('role="alert"');
    // announced as a status, as the totals line on Journals is
    expect(html).toMatch(/<p role="status"[^>]*>[^]*?Balances/);
  });

  it('says the sheet is out of balance when it is, by how much', () => {
    // 100.01 of debits against 100.00 of credits: no entry the database would take, but the safety net is for that
    const bad: MonthlyTotals = [
      { account_id: 'acc-1100', month: '2026-10', debit: 100.01, credit: 0 },
      { account_id: 'acc-3000', month: '2026-10', debit: 0, credit: 100 },
    ];
    const html = render({ totals: bad });
    expect(text(html)).toContain('Out of balance by RM 0.01');
    expect(html).toContain('role="alert"');
  });

  it('names each statement table for a screen reader, and announces the equal totals as a status', () => {
    const html = render();
    for (const name of ['Profit and loss', 'Balance sheet', 'Trial balance']) expect(html, name).toContain(`aria-label="${name}"`);
    expect(html).toMatch(/<p role="status"[^>]*>[^]*?Debits and credits are equal/);
  });

  it('says By month on the chart card', () => {
    expect(text(render())).toContain('Revenue and expenses By month');
  });

  it('shows the trial balance with equal totals', () => {
    const html = text(render());
    expect(html).toContain('Trial Balance Debits and credits in January to October 2026');
    expect(html).toContain('1100 Main Bank RM 55,300.00 RM 2,000.00');
    expect(html).toContain('4000 Sales RM 9,000.00');
    expect(html).toContain('Total RM 69,090.00 RM 69,090.00');
    expect(html).toContain('Debits and credits are equal');
  });

  it('has a CSV export for each of the three statements', () => {
    const html = render();
    expect(html.match(/Export CSV/g)).toHaveLength(3);
  });

  it('links each account to its entries in the ledger, and the ledger card to Journals', () => {
    const html = render();
    expect(html).toContain('href="/finance/journals?account=acc-4000"');
    expect(html).toContain('href="/finance/journals?account=acc-1100"');
    expect(html).toContain('href="/finance/journals"');
    expect(text(html)).toContain('General ledger');
  });

  it('draws a chart for the months and one for the categories', () => {
    const html = text(render());
    expect(html).toContain('Revenue and expenses By month');
    expect(html).toContain('Expenses by category');
    expect(html).not.toContain('No revenue or expenses in this period.');
    expect(html).not.toContain('No expenses in this period.');
  });

  it('puts a sentence in place of the charts, and shows empty statements, for a workspace with no lines', () => {
    const html = text(render({ totals: [] }));
    expect(html).toContain('No revenue or expenses in this period.');
    expect(html).toContain('No expenses in this period.');
    expect(html).toContain('Revenue RM 0.00');
    expect(html).toContain('Profit margin —');
    expect(html).toContain('No income in this period.');
    expect(html).toContain('Nothing was posted in this period.');
    expect(html).toContain('Total assets RM 0.00');
    expect(html).toContain('Balances');
    expect(html).toContain('Debits and credits are equal');
  });

  it('works its periods out from the date it is given', () => {
    // 2027-03: This year is January to March 2027 and has nothing in it, though the books have 2026.
    const html = text(render({ today: '2027-03-10' }));
    expect(html).toContain('January to March 2027');
    expect(html).toContain('Revenue RM 0.00');
    // The balance sheet is cumulative, so the 2026 books are still on it.
    expect(html).toContain('As at 31 March 2027');
    expect(html).toContain('Total assets RM 57,140.00');
    expect(html).toContain('Total equity RM 55,550.00');
  });

  it('says nothing about lines left out when there are none, and how many when there are', () => {
    expect(text(render())).not.toContain('not shown in the statements');
    expect(text(render({ unassigned: 1 }))).toContain('1 ledger line is not shown in the statements because its account could not be found.');
    expect(text(render({ unassigned: 3 }))).toContain('3 ledger lines are not shown in the statements because their accounts could not be found.');
  });

  it('no longer carries the sample screen’s other statements', () => {
    const html = text(render());
    for (const gone of ['Cash Flow', 'Aged', 'SST Tax Summary', 'Sales by Customer', 'Financial statements', 'View →']) {
      expect(html, gone).not.toContain(gone);
    }
  });

  it('uses no purple or violet in its markup', () => {
    expect(render()).not.toMatch(/purple|violet|indigo|fuchsia/i);
  });
});
