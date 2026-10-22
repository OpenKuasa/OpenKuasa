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
    expect(html).not.toContain('EXP-320');
    expect(html).not.toContain('BILL-088');
    expect(html).toContain('href="/finance/invoices"');
  });

  it('says so when the filters match nothing', async () => {
    const text = textOf(await render({ q: 'no-such-thing' }));
    expect(text).toContain('No events match these filters.');
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
  it('says the log starts on 23 Oct 2026 when it is empty and unfiltered', async () => {
    state.env = true;
    state.list = async () => ({ entries: [], nextBefore: null });
    state.rows = async () => [];
    const text = textOf(await render());
    expect(text).toContain('Nothing recorded yet. The audit trail starts on 23 Oct 2026; earlier changes were not recorded.');
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
