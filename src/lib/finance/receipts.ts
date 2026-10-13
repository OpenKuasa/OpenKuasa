/**
 * The Receipts Inbox. A receipt is one `finance_receipts` row: an uploaded
 * photo or PDF in the private `finance-receipts` bucket, the details read
 * from it, and the expense or supplier bill it is tied to. Not to be confused
 * with a cash receipt (`cash-book.ts`), which is money in. This file only
 * reads; uploading and the writes arrive with their buttons. org_id comes
 * from the context.
 */
import type { FinanceWriteContext } from './result';

/** The bucket the files live in. KEEP IN STEP with the receipts inbox migration. */
export const INBOX_RECEIPT_BUCKET = 'finance-receipts';
/** 10 MB, the bucket's own limit. */
export const INBOX_RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
/**
 * The media types the bucket accepts, and the extension each is stored with. A phone's HEIC or HEIF is turned
 * into a JPEG before upload whenever the browser can; the original is stored only when that fails, and no
 * browser but Safari draws one.
 */
export const INBOX_RECEIPT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
  'image/heic': 'heic',
  'image/heif': 'heif',
} as const;
export type InboxReceiptType = keyof typeof INBOX_RECEIPT_TYPES;

/** `review` until a person has looked at it, `unmatched` once reviewed, `matched` while tied to an expense or a bill. */
export type InboxReceiptStatus = 'review' | 'matched' | 'unmatched';

export const INBOX_RECEIPT_PAGE_SIZE = 1000;

export type InboxReceiptRow = {
  id: string;
  /** The name the uploader's device gave the file. Render it as text only. */
  file_name: string;
  mime_type: InboxReceiptType;
  /** Null when storage did not say. */
  size_bytes: number | null;
  /** False only on the demo's sample rows, which have no file. */
  has_file: boolean;
  vendor: string | null;
  receipt_date: string | null;
  /** What was paid, SST included. */
  amount: number | null;
  sst_amount: number | null;
  status: InboxReceiptStatus;
  document_kind: 'expense' | 'bill' | null;
  /** A bill's number, or an expense's category. */
  document_label: string | null;
  /** Whether a model tried and failed. The stored message stays on the server; the screen has its own sentence. */
  extraction_failed: boolean;
  /** When a model read it and got something; null when none did. The only ground for saying "read". */
  extracted_at: string | null;
  created_at: string;
};

const RECEIPT_COLUMNS =
  'id,file_name,mime_type,size_bytes,has_file,vendor,receipt_date,amount,sst_amount,status,' +
  'document_kind,document_label,extraction_error,extracted_at,created_at';

const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** Every receipt in the workspace, newest upload first, read a page at a time. */
export async function listInboxReceipts(ctx: FinanceWriteContext): Promise<InboxReceiptRow[]> {
  const rows: InboxReceiptRow[] = [];
  for (let from = 0; ; from += INBOX_RECEIPT_PAGE_SIZE) {
    const { data, error } = await ctx.client
      .from('finance_receipt_inbox')
      .select(RECEIPT_COLUMNS)
      .eq('org_id', ctx.orgId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + INBOX_RECEIPT_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(
      ...page.map((row) => {
        // The stored error text is read here and goes no further: only whether there is one.
        const { extraction_error, ...rest } = row;
        return {
          ...(rest as unknown as InboxReceiptRow),
          size_bytes: numberOrNull(row.size_bytes),
          amount: numberOrNull(row.amount),
          sst_amount: numberOrNull(row.sst_amount),
          extraction_failed: Boolean(extraction_error),
        };
      }),
    );
    if (page.length < INBOX_RECEIPT_PAGE_SIZE) return rows;
  }
}
