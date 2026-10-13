import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReportsView } from '@/components/finance/reports-view';
import { cashMovements, monthlyTotals, type CashMovement, type MonthlyTotals, type OpenDocument, type ReportAccount } from '@/lib/finance/reports';
import { SAMPLE_LEDGER_ACCOUNTS, SAMPLE_LEDGER_LINES, SAMPLE_PAYABLES, SAMPLE_RECEIVABLES } from '@/screens/finance/ledger-sample';
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

const sampleCash = cashMovements(SAMPLE_LEDGER_LINES, SAMPLE_LEDGER_ACCOUNTS);

const render = (
  over: { totals?: MonthlyTotals; cash?: CashMovement[]; receivables?: OpenDocument[] | null; payables?: OpenDocument[] | null; unassigned?: number; today?: string } = {},
) =>
  renderToStaticMarkup(
    <ReportsView
      accounts={accounts}
      totals={over.totals ?? sampleTotals}
      cash={over.cash ?? sampleCash}
      receivables={over.receivables === undefined ? SAMPLE_RECEIVABLES : over.receivables}
      payables={over.payables === undefined ? SAMPLE_PAYABLES : over.payables}
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
    expect(html).toContain('Liabilities 2000 Trade Payables RM 1,050.00 2050 Accrued Expenses RM 0.00 2100 SST Payable RM 540.00 Total liabilities RM 1,590.00');
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
    for (const name of ['Profit and loss', 'Balance sheet', 'Trial balance', 'Cash flow', 'Aged Receivables', 'Aged Payables']) expect(html, name).toContain(`aria-label="${name}"`);
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
    expect(html).toContain('Total RM 70,290.00 RM 70,290.00');
    expect(html).toContain('Debits and credits are equal');
  });

  it('has a CSV export for each of the six statements', () => {
    const html = render();
    expect(html.match(/Export CSV/g)).toHaveLength(6);
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
    for (const gone of ['SST Tax Summary', 'Sales by Customer', 'Financial statements', 'View →']) {
      expect(html, gone).not.toContain(gone);
    }
  });

  it('shows the cash flow of the period: opening cash, a row per group, the total and the closing cash', () => {
    const html = text(render());
    expect(html).toContain('Cash Flow January to October 2026');
    expect(html).toContain('Opening cash RM 0.00');
    expect(html).toContain('Received from customers and other income RM 5,300.00 RM 5,300.00');
    expect(html).toContain('Paid to suppliers and for expenses RM 2,000.00 RM -2,000.00');
    expect(html).toContain('Opening balances brought in RM 50,000.00 RM 50,000.00');
    expect(html).toContain('Total RM 55,300.00 RM 2,000.00 RM 53,300.00');
    // the Main Bank balance on the balance sheet
    expect(html).toContain('Closing cash RM 53,300.00');
    expect(html).not.toContain('No money moved in this period.');
  });

  it('says no money moved in a quiet period, and still shows the opening and closing cash', () => {
    const html = text(render({ today: '2027-03-10' }));
    expect(html).toContain('Cash Flow January to March 2027');
    expect(html).toContain('No money moved in this period.');
    expect(html).toContain('Opening cash RM 53,300.00');
    expect(html).toContain('Closing cash RM 53,300.00');
  });

  it('shows the receivables as at today, a customer to a row, with the overdue headline and a link to Invoices', () => {
    const html = render();
    const t = text(html);
    expect(t).toContain('Aged Receivables As at 10 October 2026');
    expect(t).toContain('RM 0.00 overdue of RM 4,240.00 owed');
    expect(t).toContain('Customer Not yet due 1–30 days 31–60 days 61–90 days Over 90 days Total');
    expect(t).toContain('Aisyah Trading RM 4,240.00 RM 4,240.00');
    expect(t).toContain('Total RM 4,240.00 RM 0.00 RM 0.00 RM 0.00 RM 0.00 RM 4,240.00');
    expect(html).toMatch(/<a[^>]*href="\/finance\/invoices"[^>]*>Aisyah Trading</);
  });

  it('shows the payables in their buckets, the largest first, with a link to Supplier Bills', () => {
    const html = render();
    const t = text(html);
    expect(t).toContain('Aged Payables As at 10 October 2026');
    expect(t).toContain('RM 700.00 overdue of RM 1,050.00 you owe');
    expect(t).toContain('Supplier Not yet due');
    expect(t.indexOf('Kopi Hulu Supplies')).toBeLessThan(t.indexOf('Tenaga Utilities'));
    expect(t).toContain('Kopi Hulu Supplies RM 700.00 RM 700.00 Tenaga Utilities RM 350.00 RM 350.00');
    expect(t).toContain('Total RM 350.00 RM 0.00 RM 700.00 RM 0.00 RM 0.00 RM 1,050.00');
    expect(html).toMatch(/<a[^>]*href="\/finance\/supplier-bills"[^>]*>Kopi Hulu Supplies</);
  });

  it('ages from the date it is given: at 20 January 2027 the invoice is 74 days over, the bill due 4 September 138 and the one due 25 October 87', () => {
    const t = text(render({ today: '2027-01-20' }));
    expect(t).toContain('Aged Receivables As at 20 January 2027');
    expect(t).toContain('RM 4,240.00 overdue of RM 4,240.00 owed');
    expect(t).toContain('Total RM 0.00 RM 0.00 RM 0.00 RM 4,240.00 RM 0.00 RM 4,240.00');
    expect(t).toContain('Aged Payables As at 20 January 2027');
    expect(t).toContain('RM 1,050.00 overdue of RM 1,050.00 you owe');
    // Kopi Hulu: Over 90 days; Tenaga: 61–90 days
    expect(t).toContain('Kopi Hulu Supplies RM 700.00 RM 700.00 Tenaga Utilities RM 350.00 RM 350.00');
    expect(t).toContain('Total RM 0.00 RM 0.00 RM 0.00 RM 350.00 RM 700.00 RM 1,050.00');
  });

  it('leaves both aged tables as they were when only what the period changes differs (the books and the cash)', () => {
    // The period is chosen in the browser, so it cannot be pressed here; what it changes is the statements, which are fed other figures.
    const agedOf = (html: string) => html.slice(html.indexOf('Aged Receivables'));
    const full = agedOf(text(render()));
    expect(agedOf(text(render({ totals: [], cash: [] })))).toBe(full);
    expect(agedOf(text(render({ today: SAMPLE_TODAY, totals: sampleTotals.slice(0, 3), cash: sampleCash.slice(0, 1) })))).toBe(full);
  });

  it('says the aged receivables could not be loaded, in an alert, in place of the table, and still shows the rest', () => {
    const html = render({ receivables: null });
    expect(html).toMatch(/<p role="alert"[^>]*>Aged receivables could not be loaded\. Please try again\.<\/p>/);
    const t = text(html);
    expect(t).not.toContain('Nobody owes you anything.');
    expect(html).not.toContain('aria-label="Aged Receivables"');
    expect(t).not.toContain('in credit');
    // the payables, the statements and the cash flow are untouched
    expect(t).toContain('Kopi Hulu Supplies RM 700.00');
    expect(t).toContain('Closing cash RM 53,300.00');
    expect(t).toContain('Total assets RM 57,140.00');
    expect(t).not.toContain('Aged payables could not be loaded');
  });

  it('says the aged payables could not be loaded, in an alert, in place of the table', () => {
    const html = render({ payables: null });
    expect(html).toMatch(/<p role="alert"[^>]*>Aged payables could not be loaded\. Please try again\.<\/p>/);
    expect(html).not.toContain('aria-label="Aged Payables"');
    expect(text(html)).not.toContain('You owe nothing on supplier bills.');
    expect(text(html)).toContain('Aisyah Trading RM 4,240.00');
  });

  it('disables the export of an aged table that could not be loaded', () => {
    const html = render({ receivables: null, payables: null });
    expect(html.match(/<button[^>]*disabled=""[^>]*>[^]*?Export CSV/g)).toHaveLength(2);
  });

  it('disables the cash flow export when nothing moved and the opening cash is nothing, and not when only one of them is', () => {
    // the export button of the Cash Flow card: the last button before its table
    const cashExport = (html: string) => html.slice(html.indexOf('>Cash Flow<'), html.indexOf('aria-label="Cash flow"'));
    const disabled = (html: string) => /<button[^>]*disabled=""/.test(cashExport(html));
    expect(disabled(render({ cash: [] }))).toBe(true);
    // a quiet period with cash brought forward still has something to export
    expect(disabled(render({ today: '2027-03-10' }))).toBe(false);
    // movement in the period
    expect(disabled(render())).toBe(false);
  });

  it('has an empty state for each aged table, with no headline, no totals row and the export disabled', () => {
    const html = render({ receivables: [], payables: [] });
    const t = text(html);
    expect(t).toContain('Nobody owes you anything.');
    expect(t).toContain('You owe nothing on supplier bills.');
    expect(t).not.toContain('overdue of');
    // the two aged exports are the disabled ones
    expect(html.match(/<button[^>]*disabled=""[^>]*>[^]*?Export CSV/g)).toHaveLength(2);
  });

  it('says how many customers are in credit and by how much, only when some are', () => {
    const credit = (party_id: string, balance: number): OpenDocument => ({ party_id, party_name: party_id, due_date: '2026-10-01', balance });
    expect(text(render())).not.toContain('in credit');
    const one = text(render({ receivables: [...SAMPLE_RECEIVABLES, credit('Siti Decor', -600)] }));
    expect(one).toContain('1 customer is in credit by RM 600.00 in total, which is not counted above.');
    // a customer in credit is not a row of the table, and does not change the totals
    expect(one).toContain('RM 0.00 overdue of RM 4,240.00 owed');
    expect(one).not.toMatch(/Siti Decor RM/);
    const two = text(render({ receivables: [credit('A', -600), credit('B', -80.5)] }));
    expect(two).toContain('2 customers are in credit by RM 680.50 in total, which is not counted above.');
    expect(two).toContain('Nobody owes you anything.');
  });

  it('scrolls each of the new tables inside its card', () => {
    const html = render();
    expect(html.match(/<div class="overflow-x-auto">/g)).toHaveLength(6);
  });

  it('uses no purple or violet in its markup', () => {
    expect(render()).not.toMatch(/purple|violet|indigo|fuchsia/i);
  });
});
