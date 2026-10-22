import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The SST Report loader, live branch (#222 stage 1): an owner or admin outside the demo is given Save on the
 * settings card; a member, a viewer and the demo read it. A failed settings read throws rather than showing an
 * empty form, and the company's SST no. is only offered. The reads are mocked.
 */

const actions = vi.hoisted(() => ({
  saveSstSettingsAction: vi.fn(),
  markSstReturnFiledAction: vi.fn(),
  unmarkSstReturnFiledAction: vi.fn(),
}));
vi.mock('@/app/(app)/finance/actions', () => actions);
// The picker is a client component that changes the URL; there is no app router in a static render.
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }), usePathname: () => '/finance/sst-report' }));


const state = vi.hoisted(() => ({
  viewer: { orgId: 'org', orgName: 'Org', role: 'owner', isDemo: false } as { orgId: string; orgName: string; role: string; isDemo: boolean },
  settings: async (): Promise<unknown> => null,
  company: async (): Promise<{ name: string; sstNo: string }> => ({ name: 'Rimba Ventures Sdn Bhd', sstNo: '' }),
  rows: async (): Promise<{ lines: unknown[]; credits: unknown[] }> => ({ lines: [], credits: [] }),
  filed: async (): Promise<Record<string, string>> => ({}),
  spans: [] as { start: string; end: string }[],
}));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => state.viewer, hasSupabaseEnv: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/account/data', () => ({ getCompany: () => state.company() }));
vi.mock('@/lib/finance/sst-return-data', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readSstRows: (_ctx: unknown, span: { start: string; end: string }) => {
    state.spans.push(span);
    return state.rows();
  },
  listSstFiled: () => state.filed(),
}));
// Malaysian today is pinned: 10 Oct 2026, in the 1 Sep – 31 Oct period of a September start.
vi.mock('@/lib/people/dates', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  todayInMalaysia: () => '2026-10-10',
}));
vi.mock('@/lib/finance/sst', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSstSettings: () => state.settings(),
}));

const { default: SstReportScreen } = await import('@/screens/finance/sst-report');
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

beforeEach(() => {
  state.viewer = { orgId: 'org', orgName: 'Org', role: 'owner', isDemo: false };
  state.settings = async () => null;
  state.company = async () => ({ name: 'Rimba Ventures Sdn Bhd', sstNo: '' });
  state.rows = async () => ({ lines: [], credits: [] });
  state.filed = async () => ({});
  state.spans = [];
});

const SAVED = { period_start_month: 9, service_tax_no: 'W10-1', sales_tax_no: null, service_tax_basis: 'invoice' };
const line = (over: Record<string, unknown>) => ({
  id: 'l1',
  invoice_id: 'i1',
  product_id: null,
  description: 'Consultancy',
  sst_rate: 8,
  tax_type: 'service',
  sst_code: null,
  amount_myr: 1000,
  sst_amount_myr: 80,
  invoice_date: '2026-09-15',
  invoice_status: 'posted',
  voided_on: null,
  ...over,
});

describe('the SST Report loader', () => {
  it.each(['owner', 'admin'])('gives an %s the form with Save', async (role) => {
    state.viewer.role = role;
    const html = renderToStaticMarkup(await SstReportScreen());
    expect(html).toMatch(/<button[^>]*type="submit"/);
  });

  it.each(['member', 'viewer'])('gives a %s the card read only', async (role) => {
    state.viewer.role = role;
    const html = renderToStaticMarkup(await SstReportScreen());
    expect(html).not.toMatch(/<button[^>]*type="submit"/);
    expect(textOf(html)).toContain('Only an owner or admin can change SST settings.');
  });

  it('gives the demo workspace the card read only, even as owner', async () => {
    state.viewer.isDemo = true;
    const html = renderToStaticMarkup(await SstReportScreen());
    expect(html).not.toMatch(/<button[^>]*type="submit"/);
  });

  it('throws when the settings cannot be read, instead of showing an empty form', async () => {
    state.settings = async () => {
      throw new Error('read failed');
    };
    await expect(SstReportScreen()).rejects.toThrow('read failed');
  });

  it('offers the company SST no., and is still shown when the company details cannot be read', async () => {
    state.company = async () => ({ name: 'Rimba', sstNo: ' W10-9 ' });
    expect(textOf(renderToStaticMarkup(await SstReportScreen()))).toContain('Your company details have SST no. W10-9.');
    state.company = async () => {
      throw new Error('no company');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const text = textOf(renderToStaticMarkup(await SstReportScreen()));
    expect(text).toContain('SST settings');
    expect(text).not.toContain('Your company details have');
  });
});

describe('the SST Report return (#222 stage 2)', () => {
  const render = async (params: Record<string, string> = {}) =>
    textOf(renderToStaticMarkup(await SstReportScreen({ searchParams: Promise.resolve(params) })));

  it('asks for the taxable period first when nothing is saved, and shows no figures', async () => {
    const text = await render();
    expect(text).toContain('Set your taxable period above to see your return.');
    expect(text).not.toContain('Part B1');
    expect(text).not.toContain('RM ');
    expect(state.spans).toEqual([]);
  });

  it('works out the shown period from one read over the twelve listed periods', async () => {
    state.settings = async () => SAVED;
    state.rows = async () => ({ lines: [line({})], credits: [] });
    const text = await render();
    expect(state.spans).toEqual([{ start: '2024-11-01', end: '2026-10-31' }]);
    expect(text).toContain('Rimba Ventures Sdn Bhd');
    expect(text).toContain('W10-1');
    expect(text).toContain('1 Sep – 31 Oct 2026');
    expect(text).toContain('RM 1,000.00');
    expect(text).toContain('RM 80.00');
    expect(text).toContain('1 Nov – 31 Dec 2024');
  });

  it('reaches back to a period older than the list when it is asked for', async () => {
    state.settings = async () => SAVED;
    await render({ period: '2023-09-01' });
    expect(state.spans).toEqual([{ start: '2023-09-01', end: '2026-10-31' }]);
  });

  it('shows the sales tax return when asked, with no number saved for it', async () => {
    state.settings = async () => SAVED;
    const text = await render({ tax: 'sales' });
    expect(text).toContain('11(a)');
    expect(text).toContain('Not registered: add the number in SST settings above');
  });

  it('keeps the service tax return of a payment-basis workspace not ready, but still lists its periods', async () => {
    state.settings = async () => ({ ...SAVED, service_tax_basis: 'payment' });
    const text = await render();
    expect(text).toContain('Not ready yet: service tax on payment basis is counted from payments received, which comes in the next step.');
    expect(text).not.toContain('13(a)');
    expect(text).toContain('Periods');
    expect(text).toContain('1 Jul – 31 Aug 2026');
  });

  it('says "their" for more than one line the form has no item for', async () => {
    state.settings = async () => SAVED;
    state.rows = async () => ({ lines: [line({ id: 'a', sst_rate: 7 }), line({ id: 'b', sst_rate: 7 })], credits: [] });
    expect(await render()).toContain('2 lines (RM 2,000.00) are at a rate with no item on this return. Fix their rate or tax type before you file.');
  });

  it('lists lines the form has no item for in a note', async () => {
    state.settings = async () => SAVED;
    state.rows = async () => ({
      lines: [line({ id: 'a', sst_rate: 7, sst_amount_myr: 70 }), line({ id: 'b', sst_rate: 3, tax_type: null, amount_myr: 50, sst_amount_myr: 1.5 })],
      credits: [],
    });
    const text = await render();
    expect(text).toContain('Not on the form: 1 line (RM 1,000.00) is at a rate with no item on this return. Fix its rate or tax type before you file.');
    expect(text).toContain('Not on the form: 1 line (RM 50.00) has no SST tax type. Set one before you file.');
  });

  it('gives an owner Mark as filed and Undo on ended periods only, and a member neither', async () => {
    state.settings = async () => SAVED;
    state.filed = async () => ({ '2026-07-01': '2026-09-28' });
    const owner = await render();
    expect(owner).toContain('Mark as filed');
    expect(owner).toContain('Undo');
    expect(owner).toContain('filed 28 Sep 2026');
    // The current period has not ended: 12 periods, 1 filed, 1 open, so 10 Mark buttons.
    expect(owner.match(/Mark as filed/g)).toHaveLength(10);

    state.viewer.role = 'member';
    const member = await render();
    expect(member).toContain('filed 28 Sep 2026');
    expect(member).not.toContain('Mark as filed');
    expect(member).not.toContain('Undo');
  });
});
