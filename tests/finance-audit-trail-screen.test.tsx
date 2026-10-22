import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AuditTrailScreen from '@/screens/finance/audit-trail';
import { buildAuditSummary, type AuditEntry } from '@/lib/finance/audit';
import { SAMPLE_AUDIT_ENTRIES, SAMPLE_TODAY } from '@/screens/finance/audit-sample';

const state = vi.hoisted(() => ({
  env: false,
  list: null as null | (() => Promise<{ entries: AuditEntry[]; nextBefore: string | null }>),
  rows: null as null | (() => Promise<unknown[]>),
}));

vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ orgId: 'org-1' }),
  hasSupabaseEnv: () => state.env,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/finance/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/finance/audit')>()),
  listFinanceAudit: () => state.list!(),
  readAuditSummaryRows: () => state.rows!(),
}));

const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const render = async (params: Record<string, string> = {}) =>
  renderToStaticMarkup(await AuditTrailScreen({ searchParams: Promise.resolve(params) }));

beforeEach(() => {
  state.env = false;
  state.list = null;
  state.rows = null;
});

describe('the Audit Trail without a database', () => {
  it('shows the KPIs worked out from the sample log', async () => {
    const s = buildAuditSummary(
      SAMPLE_AUDIT_ENTRIES.map((e) => ({ created_at: e.createdAt, entity_type: e.entityType, actor_name: e.actorName, event: e.details.event })),
      SAMPLE_TODAY,
    );
    expect(s.voidsThisMonth).toBeGreaterThan(0);
    expect(s.deletionsThisMonth).toBeGreaterThan(0);
    const html = await render();
    const text = textOf(html);
    expect(text).toMatch(new RegExp(`Events today\\s*${s.today}\\b`));
    expect(text).toMatch(new RegExp(`This week\\s*${s.week}\\b`));
    expect(text).toMatch(new RegExp(`Voids this month\\s*${s.voidsThisMonth}\\b`));
    expect(text).toMatch(new RegExp(`Deletions this month\\s*${s.deletionsThisMonth}\\b`));
  });

  it('narrows to one document type, and links a document to its screen', async () => {
    const html = await render({ type: 'finance_invoice' });
    expect(html).toContain('INV-1042');
    expect(html).not.toContain('Approved an expense');
    expect(html).not.toContain('BILL-088');
    expect(html).toContain('href="/finance/invoices"');
  });

  it('says so when the filters match nothing', async () => {
    const text = textOf(await render({ q: 'no-such-thing' }));
    expect(text).toContain('No events match these filters.');
  });

  it('searches the document number (the target) only, as the database does', async () => {
    const byNumber = textOf(await render({ q: 'inv-104', period: 'all' }));
    expect(byNumber).toContain('INV-1042');
    expect(byNumber).toContain('INV-1041');
    expect(byNumber).not.toContain('BILL-088');
    // A party name or an action sentence that is not a target matches nothing.
    expect(textOf(await render({ q: 'Aisyah Trading', period: 'all' }))).toContain('No events match these filters.');
    expect(textOf(await render({ q: 'Posted', period: 'all' }))).toContain('No events match these filters.');
    expect(await render()).toContain('placeholder="Search document numbers…"');
  });

  it('uses the sentences and events the database writes', () => {
    const real: Record<string, string> = {
      'Posted an invoice': 'posted',
      'Voided an invoice': 'voided',
      'Deleted a draft invoice': 'deleted',
      'Deleted a draft quotation': 'deleted',
      'Posted a supplier bill': 'posted',
      'Voided a supplier bill': 'voided',
      'Approved an expense': 'approved',
      'Recorded money in': 'recorded',
      'Posted a journal': 'posted',
    };
    for (const e of SAMPLE_AUDIT_ENTRIES) {
      expect(real[e.action], e.action).toBe(e.details.event);
    }
  });

  it('says the KPI strip and the charts cover the last 30 days, whatever the filters', async () => {
    const text = textOf(await render({ type: 'finance_invoice' }));
    expect(text).toContain('Last 30 days · all documents and people');
    expect(text).not.toContain('last 14 days');
    expect(text).not.toContain('All logged events');
  });
});

describe('the Audit Trail details', () => {
  const row = (details: Record<string, unknown>): AuditEntry => ({
    id: 'x', createdAt: '2026-10-23T03:00:00Z', actorName: 'A', action: 'Posted', target: 'T-1',
    entityType: 'finance_payment', entityId: null, details: { event: 'posted', ...details },
  });
  const show = async (e: AuditEntry) => {
    state.env = true;
    state.list = async () => ({ entries: [e], nextBefore: null });
    state.rows = async () => [];
    return textOf(await render());
  };

  it('labels a foreign amount with no ringgit value by its currency only', async () => {
    const text = await show(row({ amount: 500, currency: 'USD' }));
    expect(text).toContain('USD 500.00');
    expect(text).not.toContain('RM 500.00');
  });

  it('shows the ringgit value then the foreign amount', async () => {
    const text = await show(row({ amount: 500, currency: 'USD', amount_myr: 2350 }));
    expect(text).toContain('RM 2,350.00 (USD 500.00)');
  });
});

describe('the Audit Trail with a database', () => {
  const empty = async (params: Record<string, string>) => {
    state.env = true;
    state.list = async () => ({ entries: [], nextBefore: null });
    state.rows = async () => [];
    return textOf(await render(params));
  };

  it('says nothing was recorded in the last 30 days when only the default period is set', async () => {
    const text = await empty({});
    expect(text).toContain(
      'Nothing recorded in the last 30 days. The audit trail starts on 23 Oct 2026; earlier changes were not recorded.',
    );
    expect(text).not.toContain('No events match these filters.');
  });

  it('says the log starts on 23 Oct 2026 when it is empty for all time and unfiltered', async () => {
    const text = await empty({ period: 'all' });
    expect(text).toContain('Nothing recorded yet. The audit trail starts on 23 Oct 2026; earlier changes were not recorded.');
  });

  it('says no events match when anything else narrows the table', async () => {
    const narrowed: Record<string, string>[] = [{ period: '7d' }, { type: 'finance_invoice' }, { actor: 'Aisyah' }, { q: 'INV', period: 'all' }];
    for (const params of narrowed) {
      expect(await empty(params)).toContain('No events match these filters.');
    }
  });

  it('links to older events when there are more', async () => {
    state.env = true;
    state.list = async () => ({ entries: SAMPLE_AUDIT_ENTRIES.slice(0, 2), nextBefore: '2026-10-23T03:05:00Z' });
    state.rows = async () => [];
    const html = await render({ type: 'finance_invoice' });
    expect(html).toContain('before=2026-10-23T03%3A05%3A00Z');
    expect(html).toContain('type=finance_invoice');
  });

  it('shows the refresh message when a read fails', async () => {
    state.env = true;
    state.list = async () => {
      throw new Error('boom');
    };
    state.rows = async () => [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const text = textOf(await render());
    expect(text).toContain("Couldn't load the audit trail — please refresh");
  });
});
