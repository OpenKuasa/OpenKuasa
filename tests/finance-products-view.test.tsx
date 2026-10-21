import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ProductFormCard,
  initialTaxTypeTouched,
  onRateChange,
  onTypeChange,
  productTaxFields,
  productTaxTypeFor,
  type TaxTypeState, type ProductActions } from '@/components/finance/products-view';
import type { FinanceProduct } from '@/lib/finance/products';

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

const ACTIONS = {} as ProductActions;
const base: FinanceProduct = {
  id: 'p1', sku: null, name: 'Consulting', type: 'service', category: null, uom: 'job',
  price: 100, cost: 0, sst_rate: 6, active: true, tax_type: 'service', sst_code: null,
};
const form = (editing: FinanceProduct | null) =>
  renderToStaticMarkup(<ProductFormCard editing={editing} actions={ACTIONS} onClose={() => {}} />);

describe('productTaxTypeFor', () => {
  it('follows the rate until the person chooses a type', () => {
    expect(productTaxTypeFor({ taxType: 'none', touched: false, sst: '6' })).toBe('service');
    expect(productTaxTypeFor({ taxType: 'service', touched: false, sst: '10' })).toBe('sales');
    expect(productTaxTypeFor({ taxType: 'sales', touched: false, sst: '0' })).toBe('none');
    expect(productTaxTypeFor({ taxType: 'sales', touched: false, sst: '' })).toBe('none');
  });
  it('has no type for a rate the rule does not know', () => {
    expect(productTaxTypeFor({ taxType: 'service', touched: false, sst: '7' })).toBeNull();
  });
  it('keeps the chosen type once touched', () => {
    expect(productTaxTypeFor({ taxType: 'sales', touched: true, sst: '6' })).toBe('sales');
    expect(productTaxTypeFor({ taxType: null, touched: true, sst: '6' })).toBeNull();
  });
  it('keeps the current type while the rate is not a number', () => {
    expect(productTaxTypeFor({ taxType: 'service', touched: false, sst: 'abc' })).toBe('service');
  });
});

describe('the tax type across edits', () => {
  const start = (p: FinanceProduct | null): TaxTypeState => ({ taxType: p ? p.tax_type : 'none', touched: initialTaxTypeTouched(p) });

  it('a new item at rate 6 is service, then at 10 is sales', () => {
    const s1 = onRateChange(start(null), '6');
    expect(s1.taxType).toBe('service');
    expect(onRateChange(s1, '10').taxType).toBe('sales');
  });
  it('an edited 6% sales item keeps sales when the rate becomes 8 or 7', () => {
    const s = start({ ...base, tax_type: 'sales' });
    expect(s.touched).toBe(true);
    expect(onRateChange(s, '8').taxType).toBe('sales');
    expect(onRateChange(s, '7').taxType).toBe('sales');
  });
  it('an edited 6% service item follows the rate to 10', () => {
    const s = start(base);
    expect(s.touched).toBe(false);
    expect(onRateChange(s, '10').taxType).toBe('sales');
  });
  it('a stored null type follows the rate', () => {
    const s = start({ ...base, tax_type: null, sst_rate: 7 });
    expect(s.touched).toBe(false);
    expect(onRateChange(s, '6').taxType).toBe('service');
  });
  it('once the person picks a type, rate changes no longer move it', () => {
    const s = onTypeChange(start(null), 'sales');
    expect(onRateChange(s, '6')).toEqual({ taxType: 'sales', touched: true });
  });
  it('the save sends no code for No SST or no type, and the trimmed code otherwise', () => {
    expect(productTaxFields('none', 'X1')).toEqual({ tax_type: 'none', sst_code: null });
    expect(productTaxFields(null, 'X1')).toEqual({ tax_type: null, sst_code: null });
    expect(productTaxFields('sales', ' 8471 ')).toEqual({ tax_type: 'sales', sst_code: '8471' });
    expect(productTaxFields('service', '')).toEqual({ tax_type: 'service', sst_code: '' });
  });
});

describe('the product form', () => {
  it('offers the three tax types', () => {
    const html = form(base);
    for (const label of ['Sales tax', 'Service tax', 'No SST']) expect(html).toContain(label);
  });
  it('asks for a Service type code for a service', () => {
    const html = form(base);
    expect(html).toContain('Service type code');
    expect(html).not.toContain('Tariff code');
  });
  it('asks for a Tariff code for sales tax', () => {
    const html = form({ ...base, tax_type: 'sales', sst_rate: 10, sst_code: '8471.30' });
    expect(html).toContain('Tariff code');
    expect(html).toContain('8471.30');
  });
  it('shows no code field for No SST', () => {
    const html = form({ ...base, tax_type: 'none', sst_rate: 0 });
    expect(html).not.toContain('Tariff code');
    expect(html).not.toContain('Service type code');
  });
  it('shows no choice for a stored null type', () => {
    const html = form({ ...base, type: 'product', tax_type: null, sst_rate: 7 });
    expect(html).not.toContain('data-chosen="sales"');
    expect(html).not.toContain('data-chosen="service"');
    expect(html).not.toContain('data-chosen="none"');
  });
  it('starts a new item at No SST, as the rate starts at 0', () => {
    expect(form(null)).toContain('data-chosen="none"');
  });
});
