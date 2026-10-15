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
 * one bill that can be set off. `keep` is the contact of a draft being edited, offered even when it no longer
 * qualifies, so the form shows what the draft holds. `invoices` and `bills` are what Payments In and Payments Out
 * would offer (`receivableInvoices`, `payableBills`).
 */
export function contraParties(
  contacts: ContraContact[],
  invoices: ReceivableInvoice[],
  bills: PayableBill[],
  keep?: string,
): ContraParty[] {
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
    .filter((c) => c.id === keep || both.has(c.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      invoices: invoices.filter((i) => i.customer_id === c.id).map((i) => doc(i, i.invoice_no, i.held)),
      bills: bills.filter((b) => b.supplier_id === c.id).map((b) => doc(b, b.bill_no, b.scheduled)),
    }))
    .filter((p) => p.id === keep || (p.invoices.length > 0 && p.bills.length > 0))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The line under a document's number: what it can take, and why that may be less than its balance. */
export function contraOwedLine(document: ContraDocument): string {
  const due = `due ${displayDate(document.due_date)}${document.overdue ? ', overdue' : ''}`;
  if (document.held > 0) {
    return `${rm(document.payable)} can be set off (${rm(document.balance)} owed, ${rm(document.held)} in payments not yet posted) · ${due}`;
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
 * lacks of the amount typed when that is less, so ticking down a list makes the side add up.
 */
export function toggleContraDocument(form: ContraForm, side: ContraSide, document: ContraDocument, on: boolean): ContraForm {
  const amounts = { ...form[side] };
  if (!on) {
    delete amounts[document.id];
    return { ...form, [side]: amounts };
  }
  const amount = typedNumber(form.amount);
  const lacking = amount !== null ? (sen(amount) - sen(amountsTotal(form[side]))) / 100 : 0;
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
export function contraStats(rows: ContraRow[], today: string): { postedThisMonth: number; setOffThisMonth: number; drafts: number } {
  const month = today.slice(0, 7);
  const posted = rows.filter((r) => r.status === 'posted' && r.contra_date.startsWith(month));
  return {
    postedThisMonth: posted.length,
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

/** Posting a draft from its row. */
export function contraPostQuestion(row: ContraRow): string {
  const invoices = contraDocuments(row.invoices) || 'its invoices';
  const bills = contraDocuments(row.bills) || 'its bills';
  return `Post ${contraName(row)}? Together ${invoices} will owe ${rm(row.amount)} less, and so will ${bills}; the books record the set-off. It gets its number and cannot be edited afterwards: a posted contra entry is undone by voiding it.`;
}

/** Voiding a posted one: what it set off is owed again, and the books reverse it. */
export function contraVoidQuestion(row: ContraRow): string {
  return `Void ${contraName(row)}? Its invoices and bills owe again the ${rm(row.amount)} it set off on each side, and the books reverse it. This cannot be undone.`;
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
