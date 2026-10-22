import { describe, expect, it } from 'vitest';
import { LIVE_SCREENS, isSampleScreen } from '@/config/live-screens';
import { findItem, getProduct } from '@/config/nav';

describe('live screens', () => {
  it('lists only screens that are in the navigation', () => {
    for (const key of LIVE_SCREENS) {
      const [productKey, slug] = key.split('/');
      const product = getProduct(productKey);
      expect(product && findItem(product, slug), key).toBeTruthy();
    }
  });

  it('marks a screen that is not connected as sample', () => {
    expect(isSampleScreen('/crm/plugins')).toBe(true);
  });

  it('leaves connected screens and Tuah alone', () => {
    expect(isSampleScreen('/crm/deals')).toBe(false);
    expect(isSampleScreen('/reach/ad-studio')).toBe(false);
    expect(isSampleScreen('/reach/leads')).toBe(false);
    expect(isSampleScreen('/command')).toBe(false);
  });

  it('counts all nine Lekir screens as live', () => {
    for (const slug of ['assistant', 'dashboard', 'jobs', 'candidates', 'applications', 'interviews', 'talent-pool', 'careers-page', 'settings']) {
      expect(isSampleScreen(`/hire/${slug}`), slug).toBe(false);
    }
  });

  it('counts Invoices and Payments In as live', () => {
    expect(isSampleScreen('/finance/invoices')).toBe(false);
    expect(isSampleScreen('/finance/payments-in')).toBe(false);
  });

  it('counts Quotations, Credit Notes and Refunds as live', () => {
    for (const slug of ['quotations', 'credit-notes', 'refunds']) {
      expect(isSampleScreen(`/finance/${slug}`), slug).toBe(false);
    }
  });

  it('counts Cash Receipts, Payment Vouchers, Expenses, Banking and Receipts Inbox as live', () => {
    for (const slug of ['cash-receipts', 'payment-vouchers', 'expenses', 'banking', 'receipts-inbox']) {
      expect(isSampleScreen(`/finance/${slug}`), slug).toBe(false);
    }
  });

  it('counts Contra Entries as live', () => {
    expect(isSampleScreen('/finance/contra-entries')).toBe(false);
  });

  it('counts the Bendahara Dashboard and Overview as live', () => {
    expect(isSampleScreen('/finance/dashboard')).toBe(false);
    expect(isSampleScreen('/finance/assistant')).toBe(false);
  });

  it('counts the Bendahara Audit Trail as live', () => {
    expect(isSampleScreen('/finance/audit-trail')).toBe(false);
  });

  it('counts the Bendahara Accounting Settings as live', () => {
    expect(isSampleScreen('/finance/settings')).toBe(false);
  });

  it('counts FX Revaluation as live', () => {
    expect(isSampleScreen('/finance/fx-revaluation')).toBe(false);
  });

  it('ignores paths that are not a screen', () => {
    expect(isSampleScreen('/reach')).toBe(false);
    expect(isSampleScreen('/nope/nothing')).toBe(false);
  });
});
