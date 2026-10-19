/**
 * The Contra Entries screen's rules, kept out of the components so they can be tested: which contacts and which
 * of their invoices and bills a contra entry can set off, and for how much; what the form holds, what is wrong
 * with it, and what is sent to the save actions; the list's filter, figures and export; and the sentences of
 * its questions. Pure. The database decides every rule again (src/lib/finance/contras.ts).
 *
 * An invoice is offered for what it still owes less what money in recorded but not yet posted holds of it, and a
 * bill for what it still owes less what payments not yet paid hold of it: posting asks exactly that (FIN05).
 * A draft contra entry holds nothing, so a draft being edited takes nothing back.
 */
import {
  amountText,
  amountsError,
  amountsTotal,
  keptOffered,
  sen,
  typedAmounts,
} from './allocation-form';
import { type ContraContact, type ContraRow, type ContraStatus, CONTRA_MESSAGES, contraSides } from './contras';
import { BASE_CURRENCY } from './currencies';
import { toCsv } from './csv';
import { isIsoDate } from './document-lines';
import { rm, typedNumber } from './format';
import type { PayableBill } from './payment-form';
import type { ReceivableInvoice } from './receipt-form';
import { displayDate } from './view-helpers';

const M = CONTRA_MESSAGES;

/** What the form says of an amount over what its invoice or bill can take. */
export const CONTRA_FORM_MESSAGES = {
  tooMuch: 'Set off no more than each invoice or bill still owes.',
  /** Nothing to choose: shown in place of the form. */
  nobody:
    'No contact can have a contra entry yet. A contra entry is for a contact who is both a customer and a supplier, with a posted invoice and a posted bill that are still owed.',
} as const;

/* ---- what can be set off ------------------------------------------------ */

/** One invoice or bill the form offers. */
export type ContraDocument = {
  id: string;
  /** INV-0001 or BILL-0001. */
  number: string;
  due_date: string;
  overdue: boolean;
  /** Still owed. */
  balance: number;
  /** Held by payments recorded but not yet posted or paid. */
  held: number;
  /** What a contra entry may set off: the balance less what is held. */
  payable: number;
};

/** A contact a contra entry can be for, with their invoices and bills that can be set off. */
export type ContraParty = { id: string; name: string; invoices: ContraDocument[]; bills: ContraDocument[] };

/**
 * The contacts the form offers, by name: active, both a customer and a supplier, and with at least one invoice and
 * one bill that can be set off. `keep` are the contacts of the drafts, offered even when one no longer qualifies,
 * so the form for a draft shows what it holds. `invoices` and `bills` are what Payments In and Payments Out
 * would offer (`receivableInvoices`, `payableBills`), less invoices and bills in another currency: a contra entry
 * sets off ringgit only (FIN42) through stages 3 and 4, while Payments In takes foreign invoices from stage 3b and
 * Payments Out foreign bills from stage 4b.
 */
export function contraParties(
  contacts: ContraContact[],
  invoices: ReceivableInvoice[],
  bills: PayableBill[],
  keep: string[] = [],
): ContraParty[] {
  const kept = new Set(keep);
  const both = new Set(contacts.filter((c) => c.active && c.is_customer && c.is_supplier).map((c) => c.id));
  const doc = (d: { id: string; due_date: string; overdue: boolean; balance: number; payable: number }, number: string, held: number): ContraDocument => ({
    id: d.id,
    number,
    due_date: d.due_date,
    overdue: d.overdue,
    balance: d.balance,
    held,
    payable: d.payable,
  });
  return contacts
    .filter((c) => kept.has(c.id) || both.has(c.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      invoices: invoices.filter((i) => i.customer_id === c.id && i.currency === 'MYR').map((i) => doc(i, i.invoice_no, i.held)),
      bills: bills.filter((b) => b.supplier_id === c.id && b.currency === BASE_CURRENCY).map((b) => doc(b, b.bill_no, b.scheduled)),
    }))
    .filter((p) => kept.has(p.id) || (p.invoices.length > 0 && p.bills.length > 0))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The contacts the New form offers: only those with an invoice and a bill to set off. The contact of a draft that
 * no longer has both is offered to that draft's Edit form only.
 */
export function newContraParties(parties: ContraParty[]): ContraParty[] {
  return parties.filter((p) => p.invoices.length > 0 && p.bills.length > 0);
}

/**
 * The line under a document's number: what it can take, and why that may be less than its balance. Money in on an
 * invoice is "posted"; a payment on a bill is "paid", as Supplier Bills says.
 */
export function contraOwedLine(document: ContraDocument, side: ContraSide): string {
  const due = `due ${displayDate(document.due_date)}${document.overdue ? ', overdue' : ''}`;
  if (document.held > 0) {
    const held = side === 'invoices' ? 'in payments not yet posted' : 'in payments not yet paid';
    return `${rm(document.payable)} can be set off (${rm(document.balance)} owed, ${rm(document.held)} ${held}) · ${due}`;
  }
  return `${rm(document.balance)} owed · ${due}`;
}

/* ---- the form ------------------------------------------------------------ */

export type ContraSide = 'invoices' | 'bills';

export type ContraForm = {
  /** The draft being edited; absent for a new one. */
  id?: string;
  contactId: string;
  date: string;
  /** As typed. */
  amount: string;
  reference: string;
  notes: string;
  /** The ticked invoices and bills, by id, each with the amount as typed. */
  invoices: Record<string, string>;
  bills: Record<string, string>;
};

/** A new contra entry dated `today`; the contact is chosen when there is only one. */
export function newContraForm(today: string, parties: ContraParty[]): ContraForm {
  return {
    contactId: parties.length === 1 ? parties[0].id : '',
    date: today,
    amount: '',
    reference: '',
    notes: '',
    invoices: {},
    bills: {},
  };
}

/**
 * The form for a draft being edited. A line whose invoice or bill can no longer be set off (paid, voided, or held by
 * a payment since) is left out, and named in `dropped` so the form can say so.
 */
export function contraFormFromRow(row: ContraRow, parties: ContraParty[]): { form: ContraForm; dropped: string[] } {
  const party = parties.find((p) => p.id === row.contact_id);
  const amounts = (lines: ContraRow['invoices']) => Object.fromEntries(lines.map((l) => [l.document_id, amountText(l.amount)]));
  const full = {
    invoices: amounts(row.invoices),
    bills: amounts(row.bills),
  };
  const invoices = keptOffered({ amounts: full.invoices }, party?.invoices ?? []).amounts;
  const bills = keptOffered({ amounts: full.bills }, party?.bills ?? []).amounts;
  const dropped = [
    ...row.invoices.filter((l) => !(l.document_id in invoices)),
    ...row.bills.filter((l) => !(l.document_id in bills)),
  ].map((l) => l.document_no ?? (l.kind === 'invoice' ? 'an invoice' : 'a bill'));
  return {
    form: {
      id: row.id,
      contactId: row.contact_id,
      date: row.contra_date,
      amount: amountText(row.amount),
      reference: row.reference ?? '',
      notes: row.notes ?? '',
      invoices,
      bills,
    },
    dropped,
  };
}

/** The sentence that says which of a draft's lines were left out, or null when none was. */
export function droppedLinesNote(dropped: string[]): string | null {
  if (dropped.length === 0) return null;
  const names = dropped.length === 1 ? dropped[0] : `${dropped.slice(0, -1).join(', ')} and ${dropped[dropped.length - 1]}`;
  return `${names} can no longer be set off (paid, voided, or held by a payment since this draft was saved), so ${dropped.length === 1 ? 'it was' : 'they were'} taken off the form. Save to keep the draft without ${dropped.length === 1 ? 'it' : 'them'}.`;
}

/** Choosing another contact starts the invoices and bills again: they were the last contact's. */
export function chooseContraContact(form: ContraForm, contactId: string): ContraForm {
  return contactId === form.contactId ? form : { ...form, contactId, invoices: {}, bills: {} };
}

/**
 * Ticks an invoice or a bill, or unticks it. A tick fills in what the document can take, or what its side still
 * lacks of the amount typed when that is less, so ticking down a list makes the side add up. When the side already
 * adds up to the amount, the box is left empty for the person to fill.
 */
export function toggleContraDocument(form: ContraForm, side: ContraSide, document: ContraDocument, on: boolean): ContraForm {
  const amounts = { ...form[side] };
  if (!on) {
    delete amounts[document.id];
    return { ...form, [side]: amounts };
  }
  const amount = typedNumber(form.amount);
  const lacking = amount !== null ? (sen(amount) - sen(amountsTotal(form[side]))) / 100 : 0;
  if (amount !== null && sen(amount) > 0 && lacking <= 0) {
    amounts[document.id] = '';
    return { ...form, [side]: amounts };
  }
  amounts[document.id] = amountText(lacking > 0 && lacking < document.payable ? lacking : document.payable);
  return { ...form, [side]: amounts };
}

/** Changes one ticked document's amount as typed. */
export function typedContraAmount(form: ContraForm, side: ContraSide, id: string, text: string): ContraForm {
  return { ...form, [side]: { ...form[side], [id]: text } };
}

/** Sets the amount to the smaller of the two sides, for when the documents were ticked first. */
export function amountFromSides(form: ContraForm): ContraForm {
  const smaller = Math.min(amountsTotal(form.invoices), amountsTotal(form.bills));
  return smaller > 0 ? { ...form, amount: amountText(smaller) } : form;
}

/** The figures under the form: each side against the amount, worked out in sen. */
export function contraFormSides(form: ContraForm) {
  const amount = typedNumber(form.amount);
  const sides = contraSides({
    amount: amount ?? 0,
    invoices: typedAmounts(form.invoices).map((l) => ({ amount: Number.isFinite(l.amount) ? l.amount : 0 })),
    bills: typedAmounts(form.bills).map((l) => ({ amount: Number.isFinite(l.amount) ? l.amount : 0 })),
  });
  return { ...sides, amount: amount ?? 0 };
}

/** "Invoices RM 100.00 of RM 120.00 · Bills RM 120.00 of RM 120.00" */
export function contraSidesLine(form: ContraForm): string {
  const s = contraFormSides(form);
  return `Invoices ${rm(s.invoiceSide)} of ${rm(s.amount)} · Bills ${rm(s.billSide)} of ${rm(s.amount)}`;
}

/**
 * The first thing wrong with the form, or null. A draft may be saved unfinished (no bill yet, or sides that do not
 * add up); posting (`post`) also asks that each side adds up to the amount.
 */
export function contraFormError(form: ContraForm, parties: ContraParty[], post: boolean): string | null {
  const party = parties.find((p) => p.id === form.contactId);
  if (!form.contactId || !party) return M.contact;
  if (!isIsoDate(form.date)) return M.date;
  const amount = typedNumber(form.amount);
  if (amount === null || sen(amount) <= 0) return M.amount;
  if (form.reference.trim().length > 100) return M.reference;
  if (form.notes.trim().length > 1000) return M.notes;
  const messages = { amount: M.amount, tooMuch: CONTRA_FORM_MESSAGES.tooMuch };
  const wrong = amountsError(form.invoices, party.invoices, messages) ?? amountsError(form.bills, party.bills, messages);
  if (wrong) return wrong;
  if (post && !contraFormSides(form).ready) return M.unbalanced;
  return null;
}

/** What "Save draft" and "Save and post" send: the input of `saveContraInput`, or the first thing wrong. */
export function submitContra(form: ContraForm, parties: ContraParty[], post: boolean): { payload: unknown } | { error: string } {
  const error = contraFormError(form, parties, post);
  if (error) return { error };
  return {
    payload: {
      ...(form.id ? { id: form.id } : {}),
      contact_id: form.contactId,
      contra_date: form.date,
      amount: typedNumber(form.amount),
      reference: form.reference,
      notes: form.notes,
      invoices: typedAmounts(form.invoices).map(({ id, amount }) => ({ invoice_id: id, amount })),
      bills: typedAmounts(form.bills).map(({ id, amount }) => ({ bill_id: id, amount })),
    },
  };
}

/* ---- the list ------------------------------------------------------------ */

export const CONTRA_STATUS_LABELS: Record<ContraStatus, string> = {
  draft: 'Draft',
  posted: 'Posted',
  void: 'Void',
};

export type ContraFilter = 'all' | ContraStatus;

/** How a row is named to a screen reader and in a question: its number, or "the draft for <contact>". */
export function contraName(row: ContraRow): string {
  return row.contra_no ?? `the draft for ${row.contact_name || 'a contact'}`;
}

/** The invoices or bills of a row as one line: "INV-0001, INV-0002". */
export function contraDocuments(lines: ContraRow['invoices']): string {
  return lines.map((l) => l.document_no ?? '—').join(', ');
}

/** The rows a search and a status filter leave: the search looks at the number, contact, reference and documents. */
export function filterContras(rows: ContraRow[], query: string, filter: ContraFilter): ContraRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter !== 'all' && row.status !== filter) return false;
    if (!q) return true;
    const haystack = [row.contra_no, row.contact_name, row.reference, ...row.invoices.map((l) => l.document_no), ...row.bills.map((l) => l.document_no)];
    return haystack.some((v) => v?.toLowerCase().includes(q));
  });
}

/** The figures over the list: posted this month, what they set off, and the drafts waiting. */
export function contraStats(
  rows: ContraRow[],
  today: string,
): { postedThisMonth: number; postedInAll: number; setOffThisMonth: number; drafts: number } {
  const month = today.slice(0, 7);
  const postedInAll = rows.filter((r) => r.status === 'posted');
  const posted = postedInAll.filter((r) => r.contra_date.startsWith(month));
  return {
    postedThisMonth: posted.length,
    postedInAll: postedInAll.length,
    setOffThisMonth: posted.reduce((t, r) => t + sen(r.amount), 0) / 100,
    drafts: rows.filter((r) => r.status === 'draft').length,
  };
}

/** The table as Export gives it: one row per contra entry. */
export function contrasCsv(rows: ContraRow[]): string {
  return toCsv(
    ['Date', 'No.', 'Contact', 'Invoices', 'Bills', 'Amount', 'Reference', 'Notes', 'Status'],
    rows.map((r) => [
      r.contra_date,
      r.contra_no,
      r.contact_name,
      contraDocuments(r.invoices),
      contraDocuments(r.bills),
      r.amount,
      r.reference,
      r.notes,
      CONTRA_STATUS_LABELS[r.status],
    ]),
  );
}

/* ---- the questions ------------------------------------------------------- */

/**
 * Posting a draft from its row. A draft may have been saved unfinished; then the question says it cannot be posted
 * yet and how to finish it, instead of promising what posting would refuse (FIN29).
 */
export function contraPostQuestion(row: ContraRow): string {
  const sides = contraSides(row);
  if (!sides.ready) {
    return `Post ${contraName(row)}? It cannot be posted yet: it needs at least one invoice and one bill, each side adding up to ${rm(row.amount)}. Use Edit to finish it first.`;
  }
  return `Post ${contraName(row)}? ${theyOwe(row, 'less')} It gets its number and can't be edited after; to undo it, void it.`;
}

/** Voiding a posted one: what it set off is owed again, both ways, and the books reverse it. */
export function contraVoidQuestion(row: ContraRow): string {
  return `Void ${contraName(row)}? ${theyOwe(row, 'again', row.contact_name)} The books reverse it. This cannot be undone.`;
}

/** Who owes whom, and on which documents: the contact on the invoices, you on the bills. */
function theyOwe(row: ContraRow, how: 'less' | 'again', name?: string): string {
  const who = name || 'They';
  const amount = rm(row.amount);
  return `${who} will owe you ${amount} ${how} on ${contraDocuments(row.invoices)}, and you will owe them ${amount} ${how} on ${contraDocuments(row.bills)}.`;
}

/** An answer that says the row changed under the question (posted, voided or deleted elsewhere): the question closes. */
export function contraAnswerIsStale(error: string | null): boolean {
  return error === M.locked || error === M.gone;
}

/** Deleting a draft. */
export function contraDeleteQuestion(row: ContraRow): string {
  return `Delete ${contraName(row)}? This cannot be undone.`;
}

/* ---- after a write ------------------------------------------------------- */

/** The contra entry just saved, posted or voided, so the screen can say when the list does not show it. */
export type WrittenContra = { id: string; status: ContraStatus; contact: string; amount: number };

/** What the hidden-row note says, or null when the row is in the list. */
export function contraHiddenNote(written: WrittenContra, filter: ContraFilter, inMatching: boolean): string | null {
  if (inMatching) return null;
  const what = `The contra entry of ${rm(written.amount)}${written.contact ? ` for ${written.contact}` : ''} was ${
    written.status === 'draft' ? 'saved as a draft' : written.status === 'posted' ? 'posted' : 'voided'
  }.`;
  if (filter !== 'all' && filter !== written.status) {
    return `${what} Choose ${CONTRA_STATUS_LABELS[written.status]} or All in the status filter to see it.`;
  }
  return `${what} Clear the search to see it.`;
}

/** The contacts with documents, for the picker, with how many of each they have. */
export function contraPartyLabel(party: ContraParty): string {
  const n = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  return `${party.name} (${n(party.invoices.length, 'invoice')}, ${n(party.bills.length, 'bill')})`;
}
