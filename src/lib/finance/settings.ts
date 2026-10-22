/** A kind of document that takes a number from `finance_sequences` (the keys of `public.finance_next_number`). */
export type SequenceDoc =
  | 'invoice'
  | 'quotation'
  | 'credit_note'
  | 'bill'
  | 'receipt'
  | 'voucher'
  | 'transfer'
  | 'rfq'
  | 'purchase_order'
  | 'journal'
  | 'contra'
  | 'fx_revaluation'
  | 'supplier_credit_note';

/** Every numbered document, its name, and the prefix it starts with. */
export const SEQUENCE_DOCS: { doc: SequenceDoc; label: string; defaultPrefix: string }[] = [
  { doc: 'invoice', label: 'Invoice', defaultPrefix: 'INV-' },
  { doc: 'quotation', label: 'Quotation', defaultPrefix: 'QT-' },
  { doc: 'credit_note', label: 'Credit note', defaultPrefix: 'CN-' },
  { doc: 'bill', label: 'Supplier bill', defaultPrefix: 'BILL-' },
  { doc: 'receipt', label: 'Receipt', defaultPrefix: 'RC-' },
  { doc: 'voucher', label: 'Payment voucher', defaultPrefix: 'PV-' },
  { doc: 'transfer', label: 'Transfer', defaultPrefix: 'TR-' },
  { doc: 'rfq', label: 'RFQ', defaultPrefix: 'RFQ-' },
  { doc: 'purchase_order', label: 'Purchase order', defaultPrefix: 'PO-' },
  { doc: 'journal', label: 'Journal', defaultPrefix: 'JV-' },
  { doc: 'contra', label: 'Contra entry', defaultPrefix: 'CT-' },
  { doc: 'fx_revaluation', label: 'FX revaluation', defaultPrefix: 'FX-' },
  { doc: 'supplier_credit_note', label: 'Supplier credit note', defaultPrefix: 'SCN-' },
];

/** The workspace's accounting settings: the month its financial year ends (1–12) and the books lock date. */
export type FinanceSettings = { yearEndMonth: number; lockDate: string | null; updatedAt: string | null };

/** One numbered document's next number. */
export type SequenceRow = { doc: SequenceDoc; label: string; prefix: string; nextNumber: number; pad: number };

/** A workspace that never saved settings: a December year end and open books. */
export const DEFAULT_FINANCE_SETTINGS: FinanceSettings = { yearEndMonth: 12, lockDate: null, updatedAt: null };

/** What a person reads when the database refuses a settings change (FIN63–FIN66). */
export const SETTINGS_MESSAGES = {
  locked: (date: string) => `This date is in a closed period: the books are locked to ${date}.`,
  futureLock: "The books can't be locked to a date in the future.",
  numberBack: (n: number) => `The next number can't go back: it must be ${n} or more.`,
  badPrefix: 'A prefix is 1 to 10 letters, numbers, dashes or slashes.',
};
