/**
 * A ringgit payment of invoices in another currency, worked as the database
 * works it (private.finance_fx_settle and private.finance_fx_carried in
 * supabase/migrations/20261120110000_bendahara_fx_payments_in.sql): the
 * ringgit received shared over the invoices, what each invoice carried for
 * the part paid, and the realised gain or loss. Pure, and in whole numbers
 * only: money is a bigint count of sen (every amount column keeps two
 * decimals, a currency with no cents included) and a rate a bigint count of
 * 10^-10, as document-currency.ts works them. The payment form shows the
 * answer as "about": a payment posted first can change what an invoice still
 * carries, and the database's figure is the one kept.
 */
import { scaledFromText } from './document-currency';

const ZERO = BigInt(0);
const TWO = BigInt(2);
const HUNDRED = BigInt(100);
const RATE_ONE = BigInt(10) ** BigInt(10);

/** Decimal text with at most two places ("1658", "2883.5", "0.07") as sen; null when it is not that. */
export function senFromText(text: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(text.trim());
  if (!m) return null;
  return BigInt(m[1]) * HUNDRED + BigInt((m[2] ?? '').padEnd(2, '0'));
}

/** A two-decimal number the database gave (a balance) as sen: its own two places, read from its text. */
export function senFromNumber(n: number): bigint {
  const negative = n < 0;
  const sen = senFromText(Math.abs(n).toFixed(2)) ?? ZERO;
  return negative ? -sen : sen;
}

/** Sen as a number of ringgit, for display. */
export function ringgitOf(sen: bigint): number {
  return Number(sen) / 100;
}

/** a / b rounded half away from zero, for a >= 0 and b > 0 (Postgres's round of a numeric). */
function roundDiv(a: bigint, b: bigint): bigint {
  return (TWO * a + b) / (TWO * b);
}

/**
 * The ringgit received shared over the parts, in proportion to their foreign amounts, each rounded to the sen;
 * the largest part (ties: the lowest id, as the database orders uuids) takes what is left, so the shares add
 * to the total exactly. The answer is in the order of `parts`; empty when there is nothing to share over.
 */
export function shareRinggit(totalSen: bigint, parts: { id: string; sen: bigint }[]): bigint[] {
  const foreign = parts.reduce((sum, p) => sum + p.sen, ZERO);
  if (parts.length === 0 || foreign <= ZERO) return [];
  let largest = 0;
  for (let i = 1; i < parts.length; i += 1) {
    const p = parts[i];
    const best = parts[largest];
    if (p.sen > best.sen || (p.sen === best.sen && p.id.toLowerCase() < best.id.toLowerCase())) largest = i;
  }
  const shares = parts.map((p, i) => (i === largest ? ZERO : roundDiv(totalSen * p.sen, foreign)));
  const shared = shares.reduce((sum, s) => sum + s, ZERO);
  shares[largest] = totalSen - shared;
  return shares;
}

/**
 * What an invoice carried, in ringgit, for a part of its foreign balance: the part at the invoice's rate,
 * rounded to the sen and never more than the ringgit still open on it; when the part is all that is still
 * open, the ringgit still open, so an invoice paid in full leaves nothing behind.
 */
export function carriedSen(partSen: bigint, rateScaled: bigint, openForeignSen: bigint, openRinggitSen: bigint): bigint {
  const open = openRinggitSen < ZERO ? -openRinggitSen : openRinggitSen;
  if (partSen === openForeignSen) return open;
  const atRate = (partSen * rateScaled + RATE_ONE / TWO) / RATE_ONE;
  return atRate < open ? atRate : open;
}

/** Realised on money in: the ringgit received less what the invoice carried. Above 0 a gain, below 0 a loss. */
export function realisedSen(receivedSen: bigint, carried: bigint): bigint {
  return receivedSen - carried;
}

/** One invoice a ringgit payment settles a part of. */
export type SettledPart = {
  id: string;
  /** The part paid, in the invoice's currency, as typed. */
  amount: string;
  /** The invoice's rate, as the database's exact text ("4.2000000000"). */
  rateText: string | null;
  /** What is still open on the invoice in its currency, and in ringgit (posted payments only). */
  openForeign: number;
  openRinggit: number;
};

export type SettlementPreview = {
  /** Per part, in the order given: its share of the ringgit, what it carried, and the difference. */
  parts: { id: string; ringgit: number; carried: number; realised: number }[];
  /** What the invoices carried for the parts, all together. */
  carried: number;
  /** The whole difference: above 0 a gain, below 0 a loss. */
  realised: number;
};

/**
 * What the database will make of a ringgit payment of these parts, or null while something is not a number
 * yet (the ringgit received, an amount, or a rate).
 */
export function settlementPreview(received: string, parts: SettledPart[]): SettlementPreview | null {
  const total = senFromText(received);
  if (total === null || total <= ZERO || parts.length === 0) return null;
  const read: { id: string; sen: bigint; rate: bigint; open: bigint; openMyr: bigint }[] = [];
  for (const p of parts) {
    const sen = senFromText(p.amount);
    const rate = p.rateText === null ? undefined : scaledFromText(p.rateText);
    if (sen === null || sen <= ZERO || rate === undefined) return null;
    read.push({ id: p.id, sen, rate, open: senFromNumber(p.openForeign), openMyr: senFromNumber(p.openRinggit) });
  }
  const shares = shareRinggit(total, read);
  let realised = ZERO;
  let carriedAll = ZERO;
  const out = read.map((p, i) => {
    const carried = carriedSen(p.sen, p.rate, p.open, p.openMyr);
    const difference = realisedSen(shares[i], carried);
    realised += difference;
    carriedAll += carried;
    return { id: p.id, ringgit: ringgitOf(shares[i]), carried: ringgitOf(carried), realised: ringgitOf(difference) };
  });
  return { parts: out, carried: ringgitOf(carriedAll), realised: ringgitOf(realised) };
}
