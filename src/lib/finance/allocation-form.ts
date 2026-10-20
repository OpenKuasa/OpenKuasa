/**
 * What the payment-out form and the payment-in form share: one payment from
 * or to one party, split across that party's open documents, each for no
 * more than it can still take. Also the description of one such form
 * (`AllocationFormKind`) that the shared card draws. Pure. Amounts are held
 * as the text the person typed and added up in whole sen.
 */
import { typedNumber } from './format';
import { BASE_CURRENCY } from './currencies';
import type { CurrencyFields } from './document-currency';
import type { FinanceAccount, PaymentMethod, PaymentOutRow } from './money';

/** What the form needs to know of a document that can take a payment. */
export type Payable = {
  id: string;
  due_date: string;
  overdue: boolean;
  /** What a new payment may take. */
  payable: number;
};

/** What every payment form holds, whichever way the money goes. */
export type AllocationFormState = {
  /** The ticked documents, each with the amount as typed. */
  amounts: Record<string, string>;
  accountId: string;
  date: string;
  method: PaymentMethod;
  reference: string;
  notes: string;
};

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const sen = (n: number) => Math.round(n * 100);

/** A payment in one of these states has not paid the document yet, but the database already counts it against the document. */
const HOLDING: ReadonlySet<PaymentOutRow['status']> = new Set(['draft', 'pending_approval', 'scheduled']);

/**
 * What payments that are not yet posted already hold of each document, to the
 * sen, by document id. A document with nothing held is not in the answer.
 */
export function heldBy<R extends { status: PaymentOutRow['status']; amount: number }>(
  payments: R[],
  documentId: (payment: R) => string,
): Record<string, number> {
  const held = new Map<string, number>();
  for (const p of payments) {
    if (HOLDING.has(p.status)) held.set(documentId(p), (held.get(documentId(p)) ?? 0) + sen(p.amount));
  }
  return Object.fromEntries([...held].filter(([, total]) => total > 0).map(([id, total]) => [id, total / 100]));
}

/** The parties that have at least one document to pay, by name, with how many. */
export function partiesOf<D>(
  documents: D[],
  partyId: (document: D) => string,
  partyName: (document: D) => string,
): { id: string; name: string; open: number }[] {
  const parties = new Map<string, { id: string; name: string; open: number }>();
  for (const d of documents) {
    const entry = parties.get(partyId(d)) ?? { id: partyId(d), name: partyName(d), open: 0 };
    entry.open += 1;
    parties.set(entry.id, entry);
  }
  return [...parties.values()].sort((x, y) => x.name.localeCompare(y.name));
}

/** 1200.5 → "1200.50", the way an amount box shows it. */
export function amountText(amount: number): string {
  return amount.toFixed(2);
}

/**
 * The first ringgit bank account, or the first ringgit account of any kind. An account in another currency is never
 * the default (stage 5b: a payment form offers one for documents in its currency, chosen by the person).
 */
export function defaultAccount(accounts: FinanceAccount[]): string {
  const ringgit = accounts.filter((a) => a.currency === BASE_CURRENCY);
  return (ringgit.find((a) => a.kind === 'bank') ?? ringgit[0])?.id ?? '';
}

/** Ticks a document for all it can still take, or unticks it. */
export function ticked<F extends { amounts: Record<string, string> }>(
  form: F,
  document: { id: string; payable: number },
  on: boolean,
): F {
  const amounts = { ...form.amounts };
  if (on) amounts[document.id] = amountText(document.payable);
  else delete amounts[document.id];
  return { ...form, amounts };
}

/** Ticks every document given, each for all it can still take, or clears them all. */
export function tickedAll<F extends { amounts: Record<string, string> }>(
  form: F,
  documents: { id: string; payable: number }[],
  on: boolean,
): F {
  return { ...form, amounts: on ? Object.fromEntries(documents.map((d) => [d.id, amountText(d.payable)])) : {} };
}

/**
 * After a refresh, a ticked document that was paid off or voided meanwhile is
 * no longer offered. Its amount goes, so the total, the count and the save
 * stay true to what the person can see. The same form when nothing goes.
 */
export function keptOffered<F extends { amounts: Record<string, string> }>(form: F, offered: { id: string }[]): F {
  const ids = new Set(offered.map((d) => d.id));
  const entries = Object.entries(form.amounts);
  const kept = entries.filter(([id]) => ids.has(id));
  return kept.length === entries.length ? form : { ...form, amounts: Object.fromEntries(kept) };
}

/** The running total: every ticked amount that is a number above 0. */
export function amountsTotal(amounts: Record<string, string>): number {
  let total = 0;
  for (const text of Object.values(amounts)) {
    const amount = typedNumber(text);
    if (amount !== null && amount > 0) total += sen(amount);
  }
  return total / 100;
}

/** The ticked amounts as numbers, by document id; a box that is not a number is NaN, and is refused when sent. */
export function typedAmounts(amounts: Record<string, string>): { id: string; amount: number }[] {
  return Object.entries(amounts).map(([id, text]) => ({ id, amount: typedNumber(text) ?? Number.NaN }));
}

/**
 * The first thing wrong with the ticked amounts, or null: each must be a
 * number above 0 and no more than its document can still take. `offered` is
 * the chosen party's documents; a ticked one that is not among them was paid
 * or voided since the form opened.
 */
export function amountsError(
  amounts: Record<string, string>,
  offered: { id: string; payable: number }[],
  messages: { amount: string; tooMuch: string },
): string | null {
  for (const [id, text] of Object.entries(amounts)) {
    const amount = typedNumber(text);
    if (amount === null || sen(amount) <= 0) return messages.amount;
    const document = offered.find((d) => d.id === id);
    if (!document || sen(amount) > sen(document.payable)) return messages.tooMuch;
  }
  return null;
}

/**
 * One kind of payment form, for the shared card: its words, and its rules as
 * the functions of its own module (`payment-form.ts`, `receipt-form.ts`),
 * which are what the tests pin.
 */
export type AllocationFormKind<F extends AllocationFormState, D extends Payable> = {
  words: {
    subtitle: string;
    party: 'supplier' | 'customer';
    document: 'bill' | 'invoice';
    /** The heading over the list of documents. */
    documents: string;
    /** Shown instead of the form when no document can take a payment. */
    nothing: string;
    account: string;
    /** The date box's label when the payment is not being scheduled. */
    date: string;
    /** The submit button when the payment is not being scheduled. */
    submit: string;
  };
  newForm: (
    documents: D[],
    accounts: FinanceAccount[],
    today: string,
    preselect?: { partyId: string; documentId: string },
  ) => F;
  partyId: (form: F) => string;
  chooseParty: (form: F, partyId: string) => F;
  parties: (documents: D[]) => { id: string; name: string; open: number }[];
  documentsOf: (documents: D[], partyId: string) => D[];
  /** The document's number, as the list shows it. */
  number: (document: D) => string;
  /** The line under a document's number: what it can take, and why that may be less than its balance. */
  owed: (document: D) => string;
  /** Names an amount box for screen readers. */
  amountLabel: (document: D) => string;
  toggle: (form: F, document: D, on: boolean) => F;
  toggleAll: (form: F, documents: D[], on: boolean) => F;
  keep: (form: F, documents: D[]) => F;
  total: (form: F) => number;
  error: (form: F, documents: D[]) => string | null;
  payload: (form: F) => unknown;
  /**
   * Present when the payment can be scheduled for later: only money out. `offered` false hides the choice for this
   * form as it stands (a bill in another currency is paid now, stage 4b); absent, it is always offered.
   */
  schedule?: { is: (form: F) => boolean; set: (form: F, scheduled: boolean) => F; offered?: (form: F) => boolean };
  /**
   * Present when documents may be in another currency (money in, stage 3b; money out, 4b): the currency the amounts are in,
   * the documents listed (one currency at a time), and the ringgit-received box with what it comes to. Absent,
   * every amount is ringgit and every document of the party is listed.
   */
  currency?: {
    of: (form: F) => string;
    offered: (form: F, documents: D[]) => D[];
    ringgit: {
      needed: (form: F) => boolean;
      value: (form: F) => string;
      set: (form: F, text: string) => F;
      label: string;
      hint: string;
      /** Sentences under the box: the realised difference, as "about". */
      notes: (form: F, documents: D[]) => string[];
    };
  };
  /**
   * Present when the payment may be on an account in another currency (stage 5b): the accounts offered as the form
   * stands, choosing one, and the rate part (ringgit while the account is). On such an account the documents
   * offered are the account's currency's, no ringgit box is asked, it is paid now, and the rate is asked instead.
   */
  account?: {
    offered: (form: F, accounts: FinanceAccount[]) => FinanceAccount[];
    choose: (form: F, account: FinanceAccount) => F;
    fx: (form: F) => CurrencyFields;
    setFx: (form: F, fx: CurrencyFields) => F;
    /** Sentences under the rate box: the movement's ringgit and the realised difference, as "about". */
    notes: (form: F, documents: D[]) => string[];
  };
};
