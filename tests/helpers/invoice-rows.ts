import type { InvoiceListRow } from '@/lib/finance/invoices';

/** The fields stage 3a added to an invoice row. */
type CurrencyKeys =
  | 'currency'
  | 'fx_rate'
  | 'fx_rate_text'
  | 'fx_rate_source'
  | 'fx_rate_date'
  | 'fx_rate_provider'
  | 'fx_rate_reference'
  | 'supply_date'
  | 'total_myr'
  | 'balance_myr'
  | 'sst_myr';

/**
 * A test's invoice row, in ringgit unless the row says otherwise: rate 1, and its ringgit total and balance its
 * total and balance, worked out from the row as given (so a factory's overrides of `total` or `balance` carry).
 */
export function ringgitRow<T extends Omit<InvoiceListRow, CurrencyKeys> & Partial<Pick<InvoiceListRow, CurrencyKeys>>>(
  row: T,
): T & InvoiceListRow {
  return {
    currency: 'MYR',
    fx_rate: 1,
    fx_rate_text: '1.0000000000',
    fx_rate_source: null,
    fx_rate_date: null,
    fx_rate_provider: null,
    fx_rate_reference: null,
    supply_date: null,
    total_myr: row.total,
    balance_myr: row.balance,
    sst_myr: 0,
    ...row,
  };
}
