import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import SstReportScreen, { SstReturnBody } from '@/screens/finance/sst-report';
import { NO_TYPED_FIGURES, type SstLineRow, buildSstReturn } from '@/lib/finance/sst-return';
import { sstPeriodFor } from '@/lib/finance/sst';

// The server actions module pulls in the server graph; the screen only hands its actions on.
vi.mock('@/app/(app)/finance/actions', () => ({
  saveSstSettingsAction: vi.fn(),
  markSstReturnFiledAction: vi.fn(),
  unmarkSstReturnFiledAction: vi.fn(),
  saveSstFiguresAction: vi.fn(),
}));

// The picker is a client component that changes the URL; there is no app router in a static render.
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }), usePathname: () => '/finance/sst-report' }));

/**
 * The SST Report without a database (#222 stage 2, ruling 11): the layout of the SST-02 return from an empty data
 * set on the sample settings, every figure RM 0.00. It should not teach what SST is not: SST has no input tax and
 * no "net payable"; the return takes deductions off the total tax. It is administered by Customs (JKDM), not
 * LHDN, and nothing is filed from this screen.
 */
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
let text = '';

// The screen takes its own no-database branch only without Supabase env (hasSupabaseEnv); this shell may export it.
beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
  text = textOf(renderToStaticMarkup(await SstReportScreen({})));
});
afterAll(() => vi.unstubAllEnvs());

describe('the SST Report without a database', () => {
  it('follows the SST-02 items of a service tax return, all at RM 0.00', () => {
    for (const item of ['Part A', 'Part B1', 'Value of taxable service (10)', 'Total', '11(c)', '11(d)', '11(e)', '12', '13(a)', '14', 'RM 0.00']) {
      expect(text, item).toContain(item);
    }
    // Typed-in lines say so; they no longer say they come later. 11(e) is a number of cards.
    expect(text).toContain('(typed in)');
    expect(text).not.toContain('coming later');
    expect(text).toContain('0 cards');
    // 13(b) and 13A belong to the sales tax return.
    expect(text).not.toMatch(/13\(b\)|13A/);
  });

  it('shows nothing from GST or LHDN, no way to file, no CSV and no sample note', () => {
    for (const wrong of ['LHDN', 'input tax', 'Net payable', 'File return', 'CSV', 'sample figures']) {
      expect(text.toLowerCase(), wrong).not.toContain(wrong.toLowerCase());
    }
  });

  it('leads with the SST settings, then the return', () => {
    expect(text).toContain('SST settings');
    expect(text.indexOf('SST settings')).toBeLessThan(text.indexOf('Part A'));
  });

  it('says Part D comes later, and that it is a summary to copy into MySST', () => {
    expect(text).toContain('Part D is worked out once invoice lines can carry an exemption reason.');
    expect(text).toContain('Nothing is sent to Customs (JKDM) from here');
    expect(text).toContain('MySST');
  });
});

describe('the return body', () => {
  const period = sstPeriodFor('2026-10-10', 9);
  const settings = { period_start_month: 9, service_tax_no: 'W10', sales_tax_no: null, service_tax_basis: 'payment' as const };

  it('on payment basis, the service tax return is not ready yet and shows no deductions', () => {
    const html = renderToStaticMarkup(
      <SstReturnBody ret={buildSstReturn('service', period, [], [])} settings={settings} companyName="Rimba" />,
    );
    const body = textOf(html);
    expect(body).toContain('Not ready yet');
    expect(body).toContain('Not ready yet: service tax on payment basis is counted from payments received, which comes in the next step.');
    expect(body).not.toContain('13(a)');
    expect(body).toContain('Part A');
  });

  it('the sales tax return always shows its figures', () => {
    const body = textOf(
      renderToStaticMarkup(<SstReturnBody ret={buildSstReturn('sales', period, [], [])} settings={settings} companyName="Rimba" />),
    );
    expect(body).not.toContain('Not ready yet');
    for (const item of ['11(a)', '11(b)', '13(a)', '13(b)', '13A', '13(d)', '14']) expect(body).toContain(item);
    expect(body).toContain('Not registered: add the number in SST settings above');
    // The sales return's B1 column is item (8); (10) is the service return's.
    expect(body).toContain('Value of goods sold (8)');
    expect(body).not.toContain('Value of taxable goods');
  });

  it('leaves an invoice voided after its period out of every return, with no note', () => {
    const invoiceBasis = { ...settings, service_tax_basis: 'invoice' as const };
    const voided: SstLineRow = {
      id: 'l1',
      invoice_id: 'i1',
      product_id: null,
      description: 'Consultancy',
      sst_rate: 6,
      tax_type: 'service',
      sst_code: null,
      amount_myr: 5000,
      sst_amount_myr: 300,
      invoice_date: '2026-09-10',
      invoice_status: 'void',
      voided_on: '2026-11-01',
    };
    const nov = sstPeriodFor('2026-11-10', 9);
    for (const p of [period, nov]) {
      const body = textOf(
        renderToStaticMarkup(<SstReturnBody ret={buildSstReturn('service', p, [voided], [])} settings={invoiceBasis} companyName="Rimba" />),
      );
      expect(body).not.toContain('voided');
      expect(body).not.toContain('item 14 is below zero');
    }
  });

  it('notes an item 14 below zero', () => {
    const invoiceBasis = { ...settings, service_tax_basis: 'invoice' as const };
    const ret = buildSstReturn('service', period, [], [], { ...NO_TYPED_FIGURES, badDebt13d: 100 });
    const body = textOf(renderToStaticMarkup(<SstReturnBody ret={ret} settings={invoiceBasis} companyName="Rimba" />));
    expect(body).toContain(
      "Not on the form: item 14 is below zero because this period's deductions are more than its tax. Check with Customs (JKDM) how to claim it before you file.",
    );
  });

  it('prints the B1 titles and columns, and Part D with item 18, as the form does', () => {
    const invoiceBasis = { ...settings, service_tax_basis: 'invoice' as const };
    const service = textOf(
      renderToStaticMarkup(<SstReturnBody ret={buildSstReturn('service', period, [], [])} settings={invoiceBasis} companyName="Rimba" />),
    );
    expect(service).toContain('Sales / Service Details');
    expect(service).toContain('Value of free services');
    expect(service).not.toContain('Own use or free');
    expect(service).toContain('Sales / services exempted from tax / non-taxable service');
    expect(service).toContain('Item 18: sales of taxable goods / taxable services');

    const sales = textOf(
      renderToStaticMarkup(<SstReturnBody ret={buildSstReturn('sales', period, [], [])} settings={invoiceBasis} companyName="Rimba" />),
    );
    expect(sales).toContain('Sales / Service Details');
    expect(sales).toContain('Value of goods (for own use / disposed)');
    expect(sales).not.toContain('Value of free services');
    expect(sales).not.toContain('Exempt goods');
  });

  it('says a sales line off the form may be a Part C good, and does not say that on a service return', () => {
    const invoiceBasis = { ...settings, service_tax_basis: 'invoice' as const };
    const row = (over: Partial<SstLineRow>): SstLineRow => ({
      id: 'l1',
      invoice_id: 'i1',
      product_id: null,
      description: 'Item',
      sst_rate: 6,
      tax_type: 'service',
      sst_code: null,
      amount_myr: 1000,
      sst_amount_myr: 60,
      invoice_date: '2026-09-10',
      invoice_status: 'posted',
      voided_on: null,
      ...over,
    });
    const sales = textOf(
      renderToStaticMarkup(
        <SstReturnBody
          ret={buildSstReturn('sales', period, [row({ tax_type: 'sales', sst_rate: 3, sst_amount_myr: 30 })], [])}
          settings={invoiceBasis}
          companyName="Rimba"
        />,
      ),
    );
    expect(sales).toContain('Part C (item 17)');
    expect(sales).toContain('Add it on the form');

    const service = textOf(
      renderToStaticMarkup(
        <SstReturnBody
          ret={buildSstReturn('service', period, [row({ sst_rate: 7, sst_amount_myr: 70 })], [])}
          settings={invoiceBasis}
          companyName="Rimba"
        />,
      ),
    );
    expect(service).toContain('Not on the form: 1 line (RM 1,000.00)');
    expect(service).not.toContain('Part C');
  });

  it('carries a voided credit note in a note, with 13(a) held at 0', () => {
    const invoiceBasis = { ...settings, service_tax_basis: 'invoice' as const };
    const nov = sstPeriodFor('2026-11-10', 9);
    const ret = buildSstReturn('service', nov, [], [
      {
        id: 'c1',
        credit_date: '2026-09-15',
        status: 'void',
        voided_on: '2026-11-02',
        amount_myr: 1080,
        invoice_total_myr: 10800,
        invoice_sst_myr: { service: 800, sales: 0 },
      },
    ]);
    const body = textOf(renderToStaticMarkup(<SstReturnBody ret={ret} settings={invoiceBasis} companyName="Rimba" />));
    expect(body).toContain('13(a) is held at 0');
    expect(body).toContain('RM 80.00');
    expect(body).toContain('as a debit note');
    expect(body).not.toContain('13(a) is below zero');
  });
});
