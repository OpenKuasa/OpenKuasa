import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import SettingsScreen from '@/screens/finance/settings';

const state = vi.hoisted(() => ({
  env: false,
  role: 'owner' as string,
  isDemo: false,
  settings: null as null | (() => Promise<unknown>),
  sequences: null as null | (() => Promise<unknown>),
}));

vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ orgId: 'org-1', orgName: 'Acme', role: state.role, isDemo: state.isDemo }),
  hasSupabaseEnv: () => state.env,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/account/data', () => ({
  getCompany: async () => ({
    name: 'Acme Sdn Bhd',
    registrationNo: '2020010001',
    sstNo: 'W10-1',
    tin: 'C999',
    address: '1 Jalan A',
    city: 'KL',
    state: 'WP',
    postcode: '50000',
  }),
}));
vi.mock('@/lib/account/workspace-overview', () => ({
  loadWorkspaceOverview: async () => ({
    companyName: 'Acme Sdn Bhd',
    registrationNo: '2020010001',
    members: 2,
    canEdit: !state.isDemo && (state.role === 'owner' || state.role === 'admin'),
  }),
}));
vi.mock('@/lib/finance/sst', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/finance/sst')>()),
  getSstSettings: async () => ({ period_start_month: 3, service_tax_no: 'W10-9', sales_tax_no: null, service_tax_basis: 'payment' }),
}));
vi.mock('@/lib/finance/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/finance/settings')>()),
  getFinanceSettings: () => state.settings!(),
  listSequences: () => state.sequences!(),
}));
vi.mock('@/app/(app)/finance/actions', () => ({
  saveFinanceSettingsAction: async () => ({ ok: true, data: null }),
  setSequenceAction: async () => ({ ok: true, data: null }),
}));

const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const render = async () => renderToStaticMarkup(await SettingsScreen());
const count = (s: string, needle: string) => s.split(needle).length - 1;

beforeEach(() => {
  state.env = false;
  state.role = 'owner';
  state.isDemo = false;
  state.settings = async () => ({ yearEndMonth: 6, lockDate: '2026-09-30', updatedAt: null });
  state.sequences = async () => [{ doc: 'invoice', label: 'Invoice', prefix: 'INV-', nextNumber: 43, pad: 4 }];
});

describe('Accounting Settings without a database', () => {
  it('shows every card with the forms greyed out', async () => {
    const html = await render();
    const text = textOf(html);
    for (const t of ['Workspace', 'Legal details', 'Base currency', 'Financial year & books lock', 'Document numbering', 'SST', 'Bank accounts', 'Integrations & notifications']) {
      expect(text).toContain(t);
    }
    expect(text).toContain('MYR (Malaysian ringgit)');
    expect(text).toContain('Every report and the ledger are kept in ringgit.');
    expect(html).toContain('href="/finance/sst-report"');
    expect(html).toContain('href="/finance/banking"');
    expect(html).not.toContain('Edit in Account');
    expect(count(html, 'Coming soon')).toBe(7); // the card's subtitle and its six items
    expect(html).toMatch(/<button[^>]*disabled[^>]*type="submit"|<button[^>]*type="submit"[^>]*disabled/);
    expect(text).toContain('INV-1043');
  });

  it('names the six third-party items', async () => {
    const text = textOf(await render());
    for (const t of ['MyInvois integration', 'Auto-submit validated invoices', 'FPX auto-reconciliation', 'e-Invois alerts', 'Overdue reminders', 'SST due reminders']) {
      expect(text).toContain(t);
    }
  });
});

describe('Accounting Settings, signed in', () => {
  beforeEach(() => {
    state.env = true;
  });

  it('gives an owner the forms, the company link and the example number', async () => {
    const html = await render();
    const text = textOf(html);
    expect(text).toContain('Books locked to 30 Sep 2026');
    expect(text).toContain('Nothing dated on or before this date can be posted, voided or paid. Move it back to reopen.');
    expect(html).toContain('type="submit"');
    expect(html).toContain('max="');
    expect(html).toContain('href="/account/company"');
    expect(text).toContain('Edit in Account');
    expect(text).toMatch(/Workspace.*Acme Sdn Bhd Reg\. no 2020010001.*Edit company.*2 people have access/);
    expect(text).toMatch(/^.*Accounting Settings Financial year, numbering and tax preferences\. /);
    expect(text).not.toContain('Saudara');
    // One Save for the whole numbering table, not one per row.
    expect(count(textOf(html.slice(html.indexOf('Document numbering'))).split('SST')[0], 'Save')).toBe(1);
    expect(text).toContain('INV-0043');
    // Each row's two boxes are named for their document.
    expect(html).toContain('aria-label="Invoice prefix"');
    expect(html).toContain('aria-label="Invoice next number"');
    expect(text).toContain('C999');
    expect(count(html, 'Coming soon')).toBe(7); // the card's subtitle and its six items
  });

  it('shows a member everything without a Save button or the company link', async () => {
    state.role = 'member';
    const html = await render();
    const text = textOf(html);
    expect(html).not.toContain('type="submit"');
    expect(text).not.toContain('Save');
    // The Workspace card still points to Account, where a member can only look.
    expect(text).not.toContain('Edit in Account');
    expect(text).toContain('View company');
    expect(text).not.toContain('Edit company');
    expect(text).toContain('Books locked to 30 Sep 2026');
    expect(text).toContain('INV-0043');
    // On a phone each read-only value carries its own small label (hidden from sight on wider screens).
    expect(html).toMatch(/<span class="[^"]*sm:sr-only[^"]*">Prefix<\/span>/);
    expect(html).toMatch(/<span class="[^"]*sm:sr-only[^"]*">Next number<\/span>/);
    expect(html).toMatch(/<span class="[^"]*sm:sr-only[^"]*">Example<\/span>/);
  });

  it('shows the demo workspace read-only even to its owner', async () => {
    state.isDemo = true;
    const html = await render();
    expect(html).not.toContain('type="submit"');
  });

  it('says "Books open" with no lock', async () => {
    state.settings = async () => ({ yearEndMonth: 12, lockDate: null, updatedAt: null });
    expect(textOf(await render())).toContain('Books open');
  });

  it("says Couldn't load on the card whose read failed, and keeps the others", async () => {
    state.sequences = async () => {
      throw new Error('boom');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const text = textOf(await render());
    expect(text).toMatch(/Document numbering[^]*Couldn't load/);
    expect(text).toContain('Books locked to 30 Sep 2026');
  });
});
