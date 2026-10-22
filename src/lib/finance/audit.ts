/** What a finance row in the audit trail is about: the `entity_type` the database writes on `activity_log`. */
export type AuditEntityType =
  | 'finance_invoice'
  | 'finance_quotation'
  | 'finance_credit_note'
  | 'finance_supplier_bill'
  | 'finance_supplier_credit_note'
  | 'finance_payment'
  | 'finance_transfer'
  | 'finance_expense'
  | 'finance_contra'
  | 'finance_journal'
  | 'finance_purchase_order'
  | 'finance_fx_revaluation'
  | 'finance_sst_return'
  | 'finance_settings';

/** Each kind of document, its name, and the screen it lives on (null when it has none). */
export const AUDIT_ENTITY_TYPES: { value: AuditEntityType; label: string; path: string | null }[] = [
  { value: 'finance_invoice', label: 'Invoice', path: '/finance/invoices' },
  { value: 'finance_quotation', label: 'Quotation', path: '/finance/quotations' },
  { value: 'finance_credit_note', label: 'Credit note', path: '/finance/credit-notes' },
  { value: 'finance_supplier_bill', label: 'Supplier bill', path: '/finance/supplier-bills' },
  { value: 'finance_supplier_credit_note', label: 'Supplier credit note', path: '/finance/supplier-bills' },
  { value: 'finance_payment', label: 'Payment', path: '/finance/banking' },
  { value: 'finance_transfer', label: 'Transfer', path: '/finance/banking' },
  { value: 'finance_expense', label: 'Expense', path: '/finance/expenses' },
  { value: 'finance_contra', label: 'Contra entry', path: '/finance/contra-entries' },
  { value: 'finance_journal', label: 'Journal', path: '/finance/journals' },
  { value: 'finance_purchase_order', label: 'Purchase order', path: '/finance/purchase-orders' },
  { value: 'finance_fx_revaluation', label: 'FX revaluation', path: '/finance/fx-revaluation' },
  { value: 'finance_sst_return', label: 'SST return', path: '/finance/sst-report' },
  { value: 'finance_settings', label: 'Settings', path: '/finance/sst-report' },
];

export type AuditPeriod = '7d' | '30d' | '90d' | 'all';

export const AUDIT_PERIODS: { value: AuditPeriod; label: string; days: number | null }[] = [
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 },
  { value: 'all', label: 'All time', days: null },
];

/** What the database wrote about an event. `event` is always there; the rest depends on the document. */
export type AuditDetails = {
  event: string;
  number?: string;
  party?: string;
  date?: string;
  amount?: number;
  currency?: string;
  amount_myr?: number;
  [key: string]: unknown;
};

export type AuditEntry = {
  id: string;
  createdAt: string;
  actorName: string;
  action: string;
  target: string | null;
  entityType: AuditEntityType;
  entityId: string | null;
  details: AuditDetails;
};

export type AuditFilters = {
  type: AuditEntityType | null;
  actor: string | null;
  period: AuditPeriod;
  q: string;
  /** Cursor: only rows created before this timestamp. */
  before: string | null;
};

export const AUDIT_PAGE_SIZE = 50;

export type AuditSummary = {
  today: number;
  week: number;
  voidsThisMonth: number;
  deletionsThisMonth: number;
  daily: { date: string; label: string; count: number }[];
  byType: { type: AuditEntityType; label: string; count: number }[];
  actors: string[];
};
