import type { BillListRow } from '@/lib/finance/bills';

/** The fields stage 4a added to a bill row. */
type CurrencyKeys =
  | 'currency'
  | 'fx_rate'
  | 'fx_rate_text'
  | 'fx_rate_source'
  | 'fx_rate_date'
  | 'fx_rate_provider'
  | 'fx_rate_reference'
  | 'subtotal_myr'
  | 'sst_myr'
  | 'total_myr'
  | 'balance_myr';

/**
 * A test's bill row, in ringgit unless the row says otherwise: rate 1, and its ringgit total and balance its
 * total and balance, worked out from the row as given (so a factory's overrides of `total` or `balance` carry).
 */
export function ringgitBill<T extends Omit<BillListRow, CurrencyKeys> & Partial<Pick<BillListRow, CurrencyKeys>>>(
  row: T,
): T & BillListRow {
  return {
    currency: 'MYR',
    fx_rate: 1,
    fx_rate_text: '1.0000000000',
    fx_rate_source: null,
    fx_rate_date: null,
    fx_rate_provider: null,
    fx_rate_reference: null,
    subtotal_myr: row.total,
    sst_myr: 0,
    total_myr: row.total,
    balance_myr: row.balance,
    ...row,
  };
}
