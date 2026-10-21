import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InvoiceFormCard } from '@/components/finance/invoice-form-card';
import type { FinanceContact } from '@/lib/finance/contacts';

const actions = {
  save: async () => ({ ok: true as const, data: { id: 'x' } }),
  saveAndPost: async () => {
    throw new Error('not called');
  },
  fxRate: async () => ({ ok: true as const, data: null }),
};

const maju: FinanceContact = {
  id: '44444444-4444-4444-8444-444444444444',
  name: 'Maju Sdn Bhd',
  is_customer: true,
  is_supplier: false,
  email: null,
  phone: null,
  ssm_no: null,
  tin: null,
  payment_terms_days: 30,
  active: true,
  default_currency: null,
};

/** A new invoice, which opens in ringgit. Server rendering is enough to see which boxes are drawn. */
const html = () =>
  renderToStaticMarkup(
    <InvoiceFormCard customers={[maju]} products={[]} today="2026-10-11" actions={actions} onClose={() => {}} />,
  );

describe('the invoice card', () => {
  it('draws the date of supply on a ringgit invoice, with a hint about the 12 months', () => {
    const out = html();
    expect(out).toContain('Date of supply (if not the invoice date)');
    expect(out).toContain('service tax');
  });
});
