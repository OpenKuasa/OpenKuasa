/**
 * A ringgit payment of invoices in another currency, worked as the database
 * works it (private.finance_fx_settle and private.finance_fx_carried in
 * supabase/migrations/20261120110000_bendahara_fx_payments_in.sql): the
 * ringgit received shared over the invoices, what each invoice carried for
 * the part paid, and the realised gain or loss; and a credit note or a
 * refund on such an invoice, which the same closing rule carries (stage 3c,
 * 20261120120000_bendahara_fx_credit_notes_refunds.sql); and a ringgit payment of
 * supplier bills in another currency (stage 4b, private.finance_fx_carried_bill in
 * 20261121111000_bendahara_fx_payments_out.sql, the bill side of the same rule:
 * carriedSen answers it too); and money on a bank or cash account in another currency (stage 5b,
 * 20261122110000_bendahara_fx_foreign_account_money.sql: finance_transaction_to_currency puts the movement into
 * ringgit at its rate, movementRinggitSen, and that ringgit is shared over the documents as a ringgit payment's
 * is); and the rate a transfer between a ringgit account and one in another currency derives (stage 5c,
 * 20261122120000_bendahara_fx_transfers.sql, transferRateScaled); and a foreign balance revalued at a month end's
 * closing rate (stage 6, 20261123100000_bendahara_fx_revaluation.sql: revaluedSen, revaluationLine). Pure, and in whole numbers
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

/** A part at a rate, in sen, rounded half up (the parts are never below 0). */
function atRateSen(partSen: bigint, rateScaled: bigint): bigint {
  return (partSen * rateScaled + RATE_ONE / TWO) / RATE_ONE;
}

/**
 * A movement's ringgit on an account in another currency: its amount at its rate, to the sen, as
 * finance_transaction_to_currency writes amount_myr (round(amount x rate, 2), half away from zero; the amount is
 * never below 0). `rateScaled` is the rate per one unit in 10^-10 units.
 */
export function movementRinggitSen(amountSen: bigint, rateScaled: bigint): bigint {
  return atRateSen(amountSen, rateScaled);
}

/**
 * Stage 5c (20261122120000): the rate a transfer between a ringgit account and an account in another currency
 * derives for the side in that currency, as finance_record_transfer writes it: round(ringgit / foreign, 10), in
 * 10^-10 units. Both amounts in sen, above 0.
 */
export function transferRateScaled(ringgitSen: bigint, foreignSen: bigint): bigint {
  return roundDiv(ringgitSen * RATE_ONE, foreignSen);
}

/**
 * The ringgit of a same-currency payment (USD from a USD account), as two-decimal text, for settlementPreview,
 * billPaymentPreview and refundPreview to share: `amount` is decimal text with at most two places, `rateText`
 * the rate per one unit as exact decimal text ("4.1500000000"). Null while either is not such a number above 0.
 */
export function movementRinggitText(amount: string, rateText: string): string | null {
  const amountSen = senFromText(amount);
  const rate = scaledFromText(rateText);
  if (amountSen === null || amountSen <= ZERO || rate === undefined || rate <= ZERO) return null;
  const ringgit = movementRinggitSen(amountSen, rate);
  const whole = ringgit / HUNDRED;
  const cents = (ringgit % HUNDRED).toString().padStart(2, '0');
  return `${whole}.${cents}`;
}

/**
 * What an invoice carried, in ringgit, for a part of its foreign balance, as private.finance_fx_carried works it
 * (supabase/migrations/20261120120000_bendahara_fx_credit_notes_refunds.sql). `openForeignSen` is what is still
 * open in the direction the part moves (what is owed, for money in or a credit note; what the customer is in
 * credit, for a refund), and `openRinggitSen` the same in ringgit, with its sign (the database stopped taking
 * its absolute value in 3c: a sign that disagrees is refused there, not doubled).
 *   * The part is all that is still open: the ringgit still open, so an invoice settled in full leaves nothing.
 *   * Nothing is open (a credit note on a paid invoice, or one already in credit): the part at the rate.
 *   * The part is more than is open (a credit note past zero): what is open, and the rest at the rate.
 *   * Otherwise the part at the invoice's rate, rounded to the sen, never more than the ringgit still open.
 * Money in and refunds never reach the second and third (they are held to what is open).
 */
export function carriedSen(partSen: bigint, rateScaled: bigint, openForeignSen: bigint, openRinggitSen: bigint): bigint {
  const open = openRinggitSen;
  if (partSen === openForeignSen) return open;
  if (openForeignSen <= ZERO) return atRateSen(partSen, rateScaled);
  if (partSen > openForeignSen) return open + atRateSen(partSen - openForeignSen, rateScaled);
  const atRate = atRateSen(partSen, rateScaled);
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
 * The shared working of the two previews below: the ringgit shared over the parts, what each part carried,
 * and `difference(share, carried)` for each. Null while a figure is not a number yet.
 */
function previewOf(
  ringgit: string,
  parts: SettledPart[],
  difference: (shareSen: bigint, carried: bigint) => bigint,
): SettlementPreview | null {
  const total = senFromText(ringgit);
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
    const d = difference(shares[i], carried);
    realised += d;
    carriedAll += carried;
    return { id: p.id, ringgit: ringgitOf(shares[i]), carried: ringgitOf(carried), realised: ringgitOf(d) };
  });
  return { parts: out, carried: ringgitOf(carriedAll), realised: ringgitOf(realised) };
}

/**
 * What the database will make of a ringgit payment of these parts, or null while something is not a number
 * yet (the ringgit received, an amount, or a rate).
 */
export function settlementPreview(received: string, parts: SettledPart[]): SettlementPreview | null {
  return previewOf(received, parts, (share, carried) => realisedSen(share, carried));
}

/** Realised on money out (a bill paid): what the bill carried less the ringgit paid out. Above 0 a gain. */
export function realisedOutSen(carried: bigint, paidSen: bigint): bigint {
  return carried - paidSen;
}

/**
 * What the database will make of a ringgit payment of these bills (stage 4b: private.finance_fx_settle and
 * private.finance_fx_carried_bill): the ringgit paid out shared over the bills as `shareRinggit` shares it, what
 * each carried (`carriedSen`: the closing figure, or the part at the rate capped at the ringgit still open), and
 * the realised difference, carried less paid out. Null while something is not a number yet. "About": a payment
 * posted first can change what a bill still carries; the database's figure is the one kept.
 */
export function billPaymentPreview(paidOut: string, parts: SettledPart[]): SettlementPreview | null {
  return previewOf(paidOut, parts, (share, carried) => realisedOutSen(carried, share));
}

/**
 * The ringgit a credit note on an invoice in another currency takes off it (stage 3c): `carriedSen` of its
 * amount against what the invoice still owes (its posted balance, which may be 0 or below) and the ringgit
 * still open. Null while the amount or the rate is not a number yet. "About": a payment posted first can
 * change what the invoice still carries; the database works it out when the credit note is issued.
 */
export function creditNoteRinggit(amount: string, rateText: string | null, owedForeign: number, owedRinggit: number): number | null {
  const part = senFromText(amount);
  const rate = rateText === null ? undefined : scaledFromText(rateText);
  if (part === null || part <= ZERO || rate === undefined) return null;
  return ringgitOf(carriedSen(part, rate, senFromNumber(owedForeign), senFromNumber(owedRinggit)));
}

export type RefundPreview = {
  /** What the invoice carried for the part refunded. */
  carried: number;
  /** Carried less the ringgit paid out: above 0 a gain, below 0 a loss. */
  realised: number;
};

/**
 * What the database will make of a refund on an invoice in another currency, paid out in ringgit (stage 3c):
 * what the invoice carried for the part refunded (`carriedSen` against what the customer is in credit there, in
 * its currency and in ringgit) and the realised difference, carried less paid out (spec "The difference"). Null
 * while a figure is not a number yet.
 */
export function refundPreview(
  paidOut: string,
  amount: string,
  rateText: string | null,
  creditForeign: number,
  creditRinggit: number,
): RefundPreview | null {
  const paid = senFromText(paidOut);
  const part = senFromText(amount);
  const rate = rateText === null ? undefined : scaledFromText(rateText);
  if (paid === null || paid <= ZERO || part === null || part <= ZERO || rate === undefined) return null;
  const carried = carriedSen(part, rate, senFromNumber(creditForeign), senFromNumber(creditRinggit));
  return { carried: ringgitOf(carried), realised: ringgitOf(carried - paid) };
}

/* ---- stage 6, 20261123100000: month-end revaluation ------------------------------------------------------ */

/** What a revaluation line is of: a foreign invoice, a foreign supplier bill, or a bank or cash account. */
export type RevaluationKind = 'invoice' | 'bill' | 'account';

/**
 * A foreign balance at a closing rate, in sen, as private.finance_fx_revaluation_items works it:
 * round(balance x rate, 2), half away from zero, either sign (a customer in credit and an overdraft revalue with
 * their sign). `rateScaled` is the rate per one unit in 10^-10 units.
 */
export function revaluedSen(foreignSen: bigint, rateScaled: bigint): bigint {
  const negative = foreignSen < ZERO;
  const at = atRateSen(negative ? -foreignSen : foreignSen, rateScaled);
  return negative ? -at : at;
}

/**
 * One line as the database works it: the balance revalued (0 when the foreign balance is 0, with no rate
 * needed), the difference from what the books carry, what this run posts (the difference less what earlier
 * runs for the same month end posted) and the gain (bills the other way round: owing more is a loss). Null when
 * a foreign balance has no rate to revalue it at (the post function refuses that, FIN38).
 */
export function revaluationLine(
  kind: RevaluationKind,
  foreignSen: bigint,
  carriedSen: bigint,
  earlierSen: bigint,
  rateScaled: bigint | null,
): { revalued: bigint; difference: bigint; posted: bigint; gain: bigint } | null {
  if (foreignSen !== ZERO && rateScaled === null) return null;
  const revalued = foreignSen === ZERO || rateScaled === null ? ZERO : revaluedSen(foreignSen, rateScaled);
  const difference = revalued - carriedSen;
  const posted = difference - earlierSen;
  return { revalued, difference, posted, gain: kind === 'bill' ? -posted : posted };
}
