/**
 * What the Receipts Inbox shows, worked out from the rows the data layer
 * reads. Pure, with no server imports, so the client view and the tests both
 * use it. Nothing here depends on today's date.
 */
import type { Slice } from '@/components/charts';
import { toCsv } from './csv';
import { rm } from './format';
import type { InboxReceiptRow, InboxReceiptStatus, InboxReceiptType } from './receipts';
import { type Stat, count, sum } from './view-helpers';

export const INBOX_STATUS_LABELS: Record<InboxReceiptStatus, string> = {
  review: 'To review',
  matched: 'Matched',
  unmatched: 'Unmatched',
};

/** The order the cards and the donut show the three states in. */
export const INBOX_STATUSES: InboxReceiptStatus[] = ['review', 'matched', 'unmatched'];

export const INBOX_STATUS_COLORS: Record<InboxReceiptStatus, string> = {
  matched: 'var(--chart-2)',
  review: 'var(--chart-3)',
  unmatched: 'var(--chart-4)',
};

export const INBOX_TYPE_LABELS: Record<InboxReceiptType, string> = {
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'application/pdf': 'PDF',
  'image/heic': 'HEIC',
  'image/heif': 'HEIF',
};

/** 184320 → 180 KB, 1572864 → 1.5 MB; a dash when the size is not known. */
export function fileSizeLabel(bytes: number | null): string {
  if (bytes === null || !(bytes > 0)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = Math.round(bytes / 1024);
  // 1048575 bytes rounds to 1024 KB: that is a megabyte, so it is written as one.
  if (kb < 1024) return `${kb} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/** What a receipt is tied to, in words: "Bill BILL-0007", "Draft bill" (no number until posted), "Expense · Travel", or a dash. */
export function inboxDocument(row: InboxReceiptRow): string {
  if (row.document_kind === 'bill') return row.document_label ? `Bill ${row.document_label}` : 'Draft bill';
  if (row.document_kind === 'expense') return row.document_label ? `Expense · ${row.document_label}` : 'Expense';
  return '—';
}

/** What the screen says under a receipt about how its details got there, or null when there is nothing to say. */
export const INBOX_READING_NOTES = {
  read: 'Read by AI. Check the figures before you use them.',
  failed: 'This receipt could not be read automatically.',
} as const;

/**
 * `read` only while a model's reading is still waiting for a person (in review, stamped, no error); `failed`
 * while a failed reading stands. Once a person has reviewed the receipt neither is said: the figures are theirs.
 * A receipt no model has touched says nothing, so the screen never claims a reading that did not happen.
 */
export function inboxReadingNote(row: InboxReceiptRow): keyof typeof INBOX_READING_NOTES | null {
  if (row.status !== 'review') return null;
  if (row.extraction_failed) return 'failed';
  return row.extracted_at ? 'read' : null;
}

/** The amounts read from the rows, added up; a receipt nobody has read yet adds nothing. */
const amountOf = (rows: InboxReceiptRow[]) => sum(rows, (r) => r.amount ?? 0);

export type ReceiptsInboxViewData = {
  /** To review, Matched, Unmatched: how many, and what they add up to. */
  stats: Stat[];
  /** One slice per state that has receipts, in the order of `INBOX_STATUSES`. */
  byStatus: Slice[];
  /** Whether there is any receipt at all: worked out from the rows, never from the slices. */
  hasReceipts: boolean;
  total: string;
};

export function receiptsInboxView(rows: InboxReceiptRow[]): ReceiptsInboxViewData {
  const by = (status: InboxReceiptStatus) => rows.filter((r) => r.status === status);
  // A card says what its receipts add up to and, when some have no amount yet, how many; if none has one it says only that, never RM 0.00.
  const delta = (group: InboxReceiptRow[]) => {
    const unread = group.filter((r) => r.amount === null);
    if (!unread.length) return rm(amountOf(group));
    if (unread.length === group.length) return `${count(unread.length, 'receipt')} with no amount yet`;
    return `${rm(amountOf(group))} · ${unread.length} with no amount yet`;
  };
  const review = by('review');
  const matched = by('matched');
  const unmatched = by('unmatched');
  return {
    stats: [
      { label: 'To review', value: String(review.length), delta: delta(review), deltaTone: review.length ? 'down' : 'flat' },
      { label: 'Matched', value: String(matched.length), delta: delta(matched), deltaTone: 'flat' },
      {
        label: 'Unmatched',
        value: String(unmatched.length),
        delta: delta(unmatched),
        deltaTone: unmatched.length ? 'down' : 'flat',
      },
    ],
    byStatus: INBOX_STATUSES.map((status) => ({
      key: status,
      label: INBOX_STATUS_LABELS[status],
      value: by(status).length,
      color: INBOX_STATUS_COLORS[status],
    })).filter((slice) => slice.value > 0),
    hasReceipts: rows.length > 0,
    total: String(rows.length),
  };
}

export type InboxReceiptFilter = 'all' | InboxReceiptStatus;

/** Receipts in the chosen state whose file name, vendor or document contains the search text. */
export function filterInboxReceipts(rows: InboxReceiptRow[], query: string, filter: InboxReceiptFilter): InboxReceiptRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (filter === 'all' || r.status === filter) &&
      `${r.file_name} ${r.vendor ?? ''} ${inboxDocument(r)}`.toLowerCase().includes(q),
  );
}

/** What the CSV's "Read by AI" column says for each reading note, as the screen's sentence means it. */
const CSV_READING_NOTES = { read: 'yes', failed: 'could not be read', none: null } as const;

/** The inbox table as a CSV file. Amounts are numbers; a receipt nobody has read has empty cells. */
export function inboxReceiptsCsv(rows: InboxReceiptRow[]): string {
  return toCsv(
    ['Uploaded', 'File', 'Type', 'Vendor', 'Receipt date', 'Amount', 'SST', 'Status', 'Matched to', 'Read by AI'],
    rows.map((r) => [
      r.created_at.slice(0, 10),
      r.file_name,
      INBOX_TYPE_LABELS[r.mime_type],
      r.vendor,
      r.receipt_date,
      r.amount,
      r.sst_amount,
      INBOX_STATUS_LABELS[r.status],
      r.document_kind ? inboxDocument(r) : null,
      CSV_READING_NOTES[inboxReadingNote(r) ?? 'none'],
    ]),
  );
}
