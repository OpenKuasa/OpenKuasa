/**
 * The payment-out form's rules, kept out of the component so they can be
 * tested: which bills can still take a payment, what each defaults to, what
 * is wrong with the form, and what is sent to recordPaymentOutAction. Pure.
 * What a payment in shares is in allocation-form.ts.
 *
 * A bill in another currency (stage 4b) is paid from a ringgit account, now:
 * the amounts ticked are in the bill's currency, and the form also asks for
 * the ringgit that left the account. One payment is in one currency: the first
 * bill ticked sets it, and only that currency's bills are offered until every
 * tick is cleared. Ticking a foreign bill takes the payment off "Schedule for
 * later" (FIN47), and the card does not offer it for one.
 *
 * Stage 5b: bills in another currency may also be paid from an account in that currency. The account picker then
 * lists it beside the ringgit ones; choosing it offers that currency's bills only, asks no ringgit but the
 * movement's rate (BNM's selling rate for the date, or typed), and pays now.
 */
import {
  type AllocationFormKind,
  amountText,
  amountsError,
  amountsTotal,
  defaultAccount,
  heldBy,
  keptOffered,
  partiesOf,
  round2,
  ticked,
  tickedAll,
  typedAmounts,
} from './allocation-form';
import { BILL_MESSAGES, type BillListRow } from './bills';
import { BASE_CURRENCY, minorUnits } from './currencies';
import { CURRENCY_MESSAGES, type CurrencyFields, ringgitFields } from './document-currency';
import { money, rm, typedNumber } from './format';
import { billPaymentPreview } from './fx-settlement';
import {
  fxForAccount,
  movementAccounts,
  movementRateError,
  movementRatePayload,
  movementRinggit,
  movementRinggitNote,
  onForeignAccount,
} from './movement-rate';
import {
  type FinanceAccount,
  MONEY_MESSAGES,
  type PaymentMethod,
  type PaymentOutRow,
  recordPaymentOutInput,
} from './money';

// Defined in allocation-form.ts, which the payment-in form shares; kept exported from here because the purchase-side tests import it from this module.
export { amountText } from './allocation-form';

export type PayableBill = {
  id: string;
  bill_no: string;
  supplier_id: string;
  supplier_name: string;
  /** The purchase order the bill is raised against; null when it has none. */
  purchase_order_id: string | null;
  /** ISO 4217 code: the currency of the figures below. */
  currency: string;
  due_date: string;
  overdue: boolean;
  /** Still owed after every paid payment. */
  balance: number;
  /** Promised by payments that are scheduled but not yet paid. */
  scheduled: number;
  /** What a new payment may take: the balance less what is already scheduled. */
  payable: number;
  /**
   * The bill's rate as the database's exact text, and what is still owed in ringgit (posted payments only): what
   * the payment that clears it carries (stage 4b). Absent, the bill is taken to be ringgit: rate 1, its balance.
   */
  fx_rate_text?: string | null;
  balance_myr?: number;
};

export type PaymentForm = {
  supplierId: string;
  /** The ticked bills, each with the amount as typed, in `currency`. */
  amounts: Record<string, string>;
  /** The currency of the ticked bills: the first one ticked sets it. Read only while something is ticked. */
  currency: string;
  /** For bills in another currency: the ringgit that left the account, as typed. */
  ringgit: string;
  accountId: string;
  date: string;
  method: PaymentMethod;
  reference: string;
  notes: string;
  /** False to pay now; true to schedule for later. */
  scheduled: boolean;
  /** The chosen account's currency and the movement's rate (stage 5b); ringgit, with no rate, on a ringgit account. */
  fx: CurrencyFields;
};

/**
 * What payments that have not been paid yet already hold of each bill, to the
 * sen, by bill id. A bill with nothing held is not in the answer. Supplier
 * Bills shows it under a balance, so a bill with no Pay choice says why.
 */
export function heldByBill(payments: PaymentOutRow[]): Record<string, number> {
  return heldBy(payments, (p) => p.bill_id);
}

/**
 * The bills a payment can be recorded against: posted, not fully paid, and not
 * already covered by scheduled payments. The database refuses a payment for
 * more than balance − scheduled, so that is what the form offers. Any currency
 * (stage 4b): a bill in another currency is paid now from a ringgit account
 * with the ringgit that left it. A posted bill always has its rate. A payment
 * voucher and a contra entry filter these to ringgit bills themselves.
 */
export function payableBills(bills: BillListRow[], payments: PaymentOutRow[]): PayableBill[] {
  const held = heldByBill(payments);
  return bills
    .filter(
      (b) =>
        (b.display_status === 'pending' || b.display_status === 'overdue') &&
        b.balance > 0 &&
        (b.currency === BASE_CURRENCY || b.fx_rate_text !== null),
    )
    .map((b) => {
      const scheduled = held[b.id] ?? 0;
      return {
        id: b.id,
        bill_no: b.bill_no ?? '—',
        supplier_id: b.supplier_id,
        supplier_name: b.supplier_name,
        purchase_order_id: b.purchase_order_id,
        currency: b.currency,
        due_date: b.due_date,
        overdue: b.display_status === 'overdue',
        balance: b.balance,
        scheduled,
        payable: round2(b.balance - scheduled),
        fx_rate_text: b.fx_rate_text,
        balance_myr: b.balance_myr ?? b.balance,
      };
    })
    .filter((b) => b.payable > 0)
    .sort(
      (x, y) =>
        x.supplier_name.localeCompare(y.supplier_name) ||
        x.due_date.localeCompare(y.due_date) ||
        x.bill_no.localeCompare(y.bill_no),
    );
}

/** The suppliers that have at least one bill to pay, by name. */
export function paymentSuppliers(payable: PayableBill[]): { id: string; name: string; bills: number }[] {
  return partiesOf(
    payable,
    (b) => b.supplier_id,
    (b) => b.supplier_name,
  ).map(({ id, name, open }) => ({ id, name, bills: open }));
}

/** One supplier's payable bills, the earliest due first. */
export function billsOf(payable: PayableBill[], supplierId: string): PayableBill[] {
  return payable.filter((b) => b.supplier_id === supplierId);
}

/**
 * A fresh form. The account defaults to the first bank account. With
 * `preselect` (the Pay choice on a bill row) the supplier is chosen and that
 * bill ticked for all it can still take.
 */
export function newPaymentForm(
  payable: PayableBill[],
  accounts: FinanceAccount[],
  today: string,
  preselect?: { supplierId: string; billId: string },
): PaymentForm {
  const suppliers = paymentSuppliers(payable);
  const bill = preselect ? payable.find((b) => b.id === preselect.billId && b.supplier_id === preselect.supplierId) : undefined;
  return {
    supplierId: preselect?.supplierId ?? (suppliers.length === 1 ? suppliers[0].id : ''),
    amounts: bill ? { [bill.id]: amountText(bill.payable) } : {},
    currency: bill?.currency ?? BASE_CURRENCY,
    ringgit: '',
    accountId: defaultAccount(accounts),
    date: today,
    method: 'bank_transfer',
    reference: '',
    notes: '',
    scheduled: false,
    fx: ringgitFields(),
  };
}

/** Choosing another supplier starts the ticks again: one payment pays one supplier. */
export function chooseSupplier(form: PaymentForm, supplierId: string): PaymentForm {
  return supplierId === form.supplierId ? form : { ...form, supplierId, amounts: {}, ringgit: '' };
}

/** The currency the ticked amounts are in; null while nothing is ticked. */
export function paymentCurrency(form: PaymentForm): string | null {
  return Object.keys(form.amounts).length > 0 ? form.currency : null;
}

/** True when the payment is from an account in another currency (stage 5b): the rate is asked, and it is paid now. */
export function fromForeignAccount(form: Pick<PaymentForm, 'fx'>): boolean {
  return onForeignAccount(form.fx);
}

/**
 * True when the ticked bills are in another currency and paid from a ringgit account, so the ringgit paid out is
 * asked for and it is paid now.
 */
export function needsRinggit(form: PaymentForm): boolean {
  const currency = paymentCurrency(form);
  return currency !== null && currency !== BASE_CURRENCY && !fromForeignAccount(form);
}

/**
 * The chosen supplier's bills the form lists: all of them while nothing is ticked, then only those in the ticked
 * bills' currency (one payment, one currency: FIN44).
 */
export function offeredBills(form: PaymentForm, payable: PayableBill[]): PayableBill[] {
  const mine = billsOf(payable, form.supplierId);
  // Stage 5b: from an account in another currency, that currency's bills only (FIN51).
  const currency = fromForeignAccount(form) ? form.fx.currency : paymentCurrency(form);
  return currency === null ? mine : mine.filter((b) => b.currency === currency);
}

/** A foreign bill, or any payment from an account in another currency, is paid now (FIN47): never "Schedule for later". */
function paidNowIfForeign(form: PaymentForm): PaymentForm {
  return (needsRinggit(form) || fromForeignAccount(form)) && form.scheduled ? { ...form, scheduled: false } : form;
}

/**
 * The accounts the form offers (stage 5b): the ringgit ones, and those in the ticked bills' currency when it is
 * another one (the account chosen stays offered).
 */
export function paymentAccounts(form: PaymentForm, accounts: FinanceAccount[]): FinanceAccount[] {
  return movementAccounts(accounts, paymentCurrency(form), form.accountId);
}

/**
 * The account chosen. One in another currency takes the rate box in its currency, keeps only the ticked bills in
 * that currency, and pays now; a ringgit one drops the rate.
 */
export function choosePaymentAccount(form: PaymentForm, account: FinanceAccount): PaymentForm {
  const fx = fxForAccount(form.fx, account.currency);
  const next = { ...form, accountId: account.id, fx };
  if (!onForeignAccount(fx)) return next;
  const keep = paymentCurrency(form) === account.currency;
  return paidNowIfForeign({ ...next, currency: account.currency, ringgit: '', ...(keep ? {} : { amounts: {} }) });
}

/** The rate part, as typed or as BNM's answer left it. */
export function withPaymentFx(form: PaymentForm, fx: CurrencyFields): PaymentForm {
  return { ...form, fx };
}

/**
 * Ticks a bill for all it can still take, or unticks it. The first bill ticked sets the payment's currency; a bill
 * in another currency than the ones ticked starts the ticks again with it.
 */
export function toggleBill(form: PaymentForm, bill: PayableBill, on: boolean): PaymentForm {
  const current = paymentCurrency(form);
  const base = on && current !== null && current !== bill.currency ? { ...form, amounts: {}, ringgit: '' } : form;
  return paidNowIfForeign(ticked(on ? { ...base, currency: bill.currency } : base, bill, on));
}

/** Ticks every bill given (the ones offered, so of one currency), or clears them all. */
export function toggleAll(form: PaymentForm, bills: PayableBill[], on: boolean): PaymentForm {
  const currency = on ? (paymentCurrency(form) ?? bills[0]?.currency ?? form.currency) : form.currency;
  return paidNowIfForeign(tickedAll({ ...form, currency }, on ? bills.filter((b) => b.currency === currency) : bills, on));
}

/** The ringgit box, as typed. */
export function withRinggit(form: PaymentForm, text: string): PaymentForm {
  return { ...form, ringgit: text };
}

/**
 * After a refresh, a ticked bill that was paid off or voided meanwhile is no
 * longer in `bills`. Its amount goes, so the total, the count and the save
 * stay true to what the person can see. The same form when nothing goes.
 */
export function keepPayable(form: PaymentForm, bills: PayableBill[]): PaymentForm {
  return keptOffered(form, bills);
}

/** The running total: every ticked amount that is a number above 0. */
export function paymentTotal(form: PaymentForm): number {
  return amountsTotal(form.amounts);
}

/**
 * What is sent to recordPaymentOutAction. Amounts are numbers; a box that is not a number goes as NaN and is
 * refused. For bills in another currency the ringgit paid out goes as the text typed (commas dropped), so no float
 * stands between the box and the database.
 */
export function paymentPayload(form: PaymentForm) {
  return {
    account_id: form.accountId,
    txn_date: form.date,
    method: form.method,
    reference: form.reference,
    notes: form.notes,
    scheduled: form.scheduled,
    ...(needsRinggit(form) ? { amount_myr: form.ringgit.replace(/,/g, '').trim() } : {}),
    // Stage 5b: from an account in another currency, the movement's rate.
    ...movementRatePayload(form.fx),
    allocations: typedAmounts(form.amounts).map(({ id, amount }) => ({ bill_id: id, amount })),
  };
}

/** The parts of a payment as the previews read them: each ticked bill's amount, rate and what is still open on it. */
function previewParts(form: PaymentForm, payable: PayableBill[]) {
  return Object.entries(form.amounts).map(([id, amount]) => {
    const bill = payable.find((b) => b.id === id);
    return {
      id,
      amount: amount.replace(/,/g, ''),
      rateText: bill?.fx_rate_text ?? null,
      openForeign: bill?.balance ?? 0,
      openRinggit: bill?.balance_myr ?? 0,
    };
  });
}

/** The realised difference of a preview, in the form's words. */
function previewWords(preview: { parts: unknown[]; carried: number; realised: number }): string[] {
  const at = `The ${preview.parts.length === 1 ? 'bill carries' : 'bills carry'} about ${rm(preview.carried)} for what is paid.`;
  if (preview.realised === 0) return [at, 'No exchange gain or loss.'];
  const word = preview.realised > 0 ? 'gain' : 'loss';
  return [at, `Realised exchange ${word} of about ${rm(Math.abs(preview.realised))}.`];
}

/**
 * Under the rate box, on an account in another currency (stage 5b): what the payment comes to in ringgit at the
 * rate, and what the database will make of it, worked in whole sen through the same preview as a ringgit payment
 * of foreign bills, with the movement's ringgit (`movementRinggit`), as "about". Empty while a figure is not a number.
 */
export function paymentAccountNotes(form: PaymentForm, payable: PayableBill[]): string[] {
  if (!fromForeignAccount(form) || paymentCurrency(form) === null) return [];
  const total = amountText(paymentTotal(form));
  const notes = [movementRinggitNote(total, form.fx)].filter((n): n is string => n !== null);
  const ringgit = movementRinggit(total, form.fx);
  const preview = ringgit === null ? null : billPaymentPreview(ringgit, previewParts(form, payable));
  return preview ? [...notes, ...previewWords(preview)] : notes;
}

/**
 * Under the ringgit box: what the database will make of the payment, worked in whole sen (fx-settlement.ts), as
 * "about" (a payment posted first can change it). Empty for ringgit and while a figure is not a number.
 */
export function paymentPreview(form: PaymentForm, payable: PayableBill[]): string[] {
  if (!needsRinggit(form)) return [];
  const preview = billPaymentPreview(form.ringgit.replace(/,/g, ''), previewParts(form, payable));
  return preview ? previewWords(preview) : [];
}

/**
 * The first thing wrong with the form, in the sentence the schema or the
 * database would use, or null when it can be sent.
 */
export function paymentFormError(form: PaymentForm, payable: PayableBill[]): string | null {
  if (!form.supplierId) return BILL_MESSAGES.supplier;
  if (Object.keys(form.amounts).length === 0) return MONEY_MESSAGES.bills;
  // A bill that is no longer payable was paid or voided since the form opened.
  const problem = amountsError(form.amounts, offeredBills(form, payable), MONEY_MESSAGES);
  if (problem) return problem;
  const currency = paymentCurrency(form);
  if (currency !== null && minorUnits(currency) === 0) {
    const whole = Object.values(form.amounts).every((text) => Number.isInteger(typedNumber(text)));
    if (!whole) return CURRENCY_MESSAGES.wholeUnits(currency);
  }
  // A bill in another currency is paid now (FIN47); the form never offers scheduling one.
  if (needsRinggit(form) && form.scheduled) return MONEY_MESSAGES.payNow;
  // Stage 5b: from an account in another currency it is paid now too, and needs its rate.
  if (fromForeignAccount(form)) {
    if (form.scheduled) return MONEY_MESSAGES.payNowAccount;
    if (currency !== null && currency !== form.fx.currency) return MONEY_MESSAGES.foreignAccountBills;
    const rate = movementRateError(form.fx);
    if (rate) return rate;
  }
  const parsed = recordPaymentOutInput.safeParse(paymentPayload(form));
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? MONEY_MESSAGES.amount);
}

/** The payment-out form, as the shared card draws it. */
export const PAYMENT_OUT_KIND: AllocationFormKind<PaymentForm, PayableBill> = {
  words: {
    subtitle: 'Pay a supplier\'s bills, now or later',
    party: 'supplier',
    document: 'bill',
    documents: 'Bills to pay',
    nothing: 'There is no bill to pay. A bill can be paid once it is posted, and until payments cover it in full.',
    account: 'Paid from',
    date: 'Date paid',
    submit: 'Record payment',
  },
  newForm: (payable, accounts, today, preselect) =>
    newPaymentForm(
      payable,
      accounts,
      today,
      preselect ? { supplierId: preselect.partyId, billId: preselect.documentId } : undefined,
    ),
  partyId: (form) => form.supplierId,
  chooseParty: chooseSupplier,
  parties: (payable) => paymentSuppliers(payable).map(({ id, name, bills }) => ({ id, name, open: bills })),
  documentsOf: billsOf,
  number: (bill) => bill.bill_no,
  owed: (bill) =>
    `${money(bill.payable, bill.currency)} to pay` +
    (bill.currency === BASE_CURRENCY ? '' : ` (≈ ${rm(bill.balance_myr ?? bill.balance)} still carried)`) +
    (bill.scheduled > 0
      ? ` · ${money(bill.scheduled, bill.currency)} of ${money(bill.balance, bill.currency)} in payments not yet paid`
      : ''),
  amountLabel: (bill) => `Amount to pay on ${bill.bill_no}`,
  toggle: toggleBill,
  toggleAll,
  keep: keepPayable,
  total: paymentTotal,
  error: paymentFormError,
  payload: paymentPayload,
  schedule: {
    is: (form) => form.scheduled,
    set: (form, scheduled) => ({ ...form, scheduled }),
    // A bill in another currency, or any payment from an account in another currency, is paid now (FIN47): the
    // realised difference is decided when the money moves.
    offered: (form) => !needsRinggit(form) && !fromForeignAccount(form),
  },
  currency: {
    of: (form) => (fromForeignAccount(form) ? form.fx.currency : (paymentCurrency(form) ?? BASE_CURRENCY)),
    offered: offeredBills,
    ringgit: {
      needed: needsRinggit,
      value: (form) => form.ringgit,
      set: withRinggit,
      label: 'Ringgit paid out',
      hint: 'What left the account, in RM. The amounts above are in the bills’ currency. A bill in another currency is paid now.',
      notes: paymentPreview,
    },
  },
  account: {
    offered: paymentAccounts,
    choose: choosePaymentAccount,
    fx: (form) => form.fx,
    setFx: withPaymentFx,
    notes: paymentAccountNotes,
  },
};
