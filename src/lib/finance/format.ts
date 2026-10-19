import { BASE_CURRENCY, minorUnits } from './currencies';

/** RM 1,240.00 */
export function rm(n: number) {
  return `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * An amount in its own currency: exactly `rm` for ringgit (so every ringgit
 * figure reads as it always has), "USD 1,000.00" for a two-decimal currency
 * and "JPY 150,000" for one with no minor unit.
 */
export function money(n: number, currency: string = BASE_CURRENCY) {
  if (currency === BASE_CURRENCY) return rm(n);
  const digits = minorUnits(currency) ?? 2;
  return `${currency} ${n.toLocaleString('en-MY', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/**
 * A unit price keeps up to 4 decimals, so two prices that differ only there do not read the same. In another
 * currency it is named by its code ("USD 33.33"), with as few decimals as that currency has at the least.
 */
export function unitPrice(n: number, currency: string = BASE_CURRENCY) {
  if (currency === BASE_CURRENCY) return `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  const digits = minorUnits(currency) ?? 2;
  return `${currency} ${n.toLocaleString('en-MY', { minimumFractionDigits: digits, maximumFractionDigits: 4 })}`;
}

/** Short money for KPI cards: RM 2,600 / RM 12.7k. */
export function rmShort(n: number) {
  return n >= 10_000
    ? `RM ${(n / 1000).toFixed(1)}k`
    : `RM ${Math.round(n).toLocaleString('en-MY')}`;
}

/**
 * What a person typed into a number box, as a number. null when the box is
 * empty or holds anything but digits with an optional decimal point, so
 * "1,200.50" is refused instead of being read as some other number.
 */
export function typedNumber(value: string): number | null {
  const text = value.trim();
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
