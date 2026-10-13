/**
 * The writes of the Receipts Inbox, and its review form's rules. A receipt
 * is recorded for a file the browser has already put in the bucket
 * (`finance_register_receipt`: the database checks the file is really there,
 * in this workspace's folder and less than 30 minutes old, and writes down
 * its type, its size and who uploaded it); its details are typed by a person
 * (`finance_review_receipt`), which takes it out of "To review"; and one that
 * is tied to nothing is deleted. Opening a file starts here too: the path is
 * read and the link signed with the caller's own client, so row-level
 * security and the bucket's rule decide. org_id comes from the context.
 *
 * Client-safe: the review card imports the schema and the form's rules. The
 * half that needs the service client is in `receipt-files-server.ts`.
 */
import { z } from 'zod';
import { LINE_MESSAGES, isIsoDate } from './document-lines';
import { typedNumber } from './format';
import {
  RECEIPT_FILE_MESSAGES,
  RECEIPT_NAME_MAX,
  cleanFileName,
  cleanTypedText,
  isInboxReceiptPath,
  receiptDownloadName,
} from './receipt-files';
import { INBOX_RECEIPT_BUCKET, type InboxReceiptRow, type InboxReceiptType } from './receipts';
import {
  type FinResult,
  type FinanceWriteContext,
  NOT_ALLOWED,
  PG_CHECK,
  PG_FORBIDDEN,
  PG_OUT_OF_RANGE,
  PG_UNIQUE,
  READ_FAILED,
  TOO_LARGE,
  WRITE_FAILED,
  pgCode,
} from './result';

export const RECEIPT_INBOX_MESSAGES = {
  gone: 'That receipt no longer exists.',
  // FIN24, and a path that is not this workspace's: the file is not there to record.
  fileGone: 'That file is no longer waiting to be added: it did not arrive, or it waited more than 30 minutes. Upload it again.',
  notSaved: RECEIPT_FILE_MESSAGES.notSaved,
  vendor: LINE_MESSAGES.tooLong,
  date: LINE_MESSAGES.date,
  future: 'A receipt cannot be dated after today.',
  amount: 'Type the amount in digits, above 0, like 1200.50. Leave it empty if the receipt does not show one.',
  sst: 'Type the SST in digits, 0 or more, like 12.50. Leave it empty if the receipt does not show it.',
  sstOver: 'The SST cannot be more than the amount.',
  sstAlone: 'Enter the amount before its SST.',
  // 23514 from a direct call: the schema refuses everything that could meet a check.
  invalid: 'Check the vendor, the date and the amounts, then try again.',
  // FIN23 from deleting.
  matched: 'This receipt is matched. Untie it from its expense or bill first.',
  noFile: 'This receipt has no file.',
  fileUnavailable: 'That file could not be opened. Please try again.',
  // The stored bytes are not the type the receipt says: nothing is opened.
  notWhatItSays: 'This file is not the kind of file its receipt says it is, so it cannot be opened here.',
} as const;

const M = RECEIPT_INBOX_MESSAGES;

/** FIN23: what a receipt's state does not allow. FIN24: its file. FIN11: it is gone. */
const FIN_STATE = 'FIN23';
const FIN_FILE = 'FIN24';
const FIN_GONE = 'FIN11';

/** How long a signed link to a receipt's file works. */
export const RECEIPT_LINK_SECONDS = 60;

const id = z.string({ error: M.gone }).uuid(M.gone);

export const receiptIdInput = z.object({ id }, { error: M.gone });

/**
 * A file the browser has uploaded, to be recorded: its path in the bucket and
 * the name to show. The path's shape is checked here; that it is in the
 * caller's own workspace is checked against the context, and that the file is
 * there is the database's to say.
 */
export const registerReceiptInput = z.object(
  {
    path: z.string({ error: M.fileGone }).max(120, M.fileGone),
    // Cleaned again here: the browser's own cleaning is a courtesy.
    name: z.string({ error: M.notSaved }).max(1000, M.notSaved).transform(cleanFileName),
  },
  { error: M.notSaved },
);

const round2 = (v: number) => Math.round(v * 100) / 100;
/** numeric(14,2) */
const AMOUNT_MAX = 999_999_999_999.99;

/** An amount a person may leave empty. `z.number` refuses NaN and Infinity by itself. */
const optionalAmount = (message: string, positive: boolean) =>
  z
    .union(
      [
        z
          .number({ error: message })
          .transform(round2)
          .pipe(positive ? z.number().gt(0, message).max(AMOUNT_MAX, message) : z.number().min(0, message).max(AMOUNT_MAX, message)),
        z.null(),
      ],
      { error: message },
    )
    .default(null);

/**
 * What a person typed after looking at a receipt. Every field may be empty:
 * a receipt that shows no amount is still reviewed. The vendor is at most
 * 200 characters; the date is a real one; the amount is above 0 with its SST
 * inside it; the SST is 0 or more, no more than the amount, and not given
 * without one.
 */
export const reviewReceiptInput = z
  .object(
    {
      id,
      vendor: z
        .union([z.string({ error: M.vendor }).transform(cleanTypedText).pipe(z.string().max(RECEIPT_NAME_MAX, M.vendor)), z.null()], { error: M.vendor })
        .transform((v) => (v === null || v === '' ? null : v))
        .default(null),
      receipt_date: z
        .union([z.string({ error: M.date }), z.null()], { error: M.date })
        .transform((v) => (v === null || v === '' ? null : v))
        .refine((v) => v === null || isIsoDate(v), M.date)
        .default(null),
      amount: optionalAmount(M.amount, true),
      sst_amount: optionalAmount(M.sst, false),
    },
    { error: M.invalid },
  )
  .refine((v) => v.sst_amount === null || v.amount !== null, { message: M.sstAlone, path: ['sst_amount'] })
  .refine((v) => v.sst_amount === null || v.amount === null || v.sst_amount <= v.amount, {
    message: M.sstOver,
    path: ['sst_amount'],
  });

const REFUSALS: Record<string, string> = {
  [FIN_GONE]: M.gone,
  [FIN_STATE]: M.matched,
  [PG_CHECK]: M.invalid,
  [PG_FORBIDDEN]: NOT_ALLOWED,
  [PG_OUT_OF_RANGE]: TOO_LARGE,
};

function inboxWriteFailed(fnName: string, error: unknown): { ok: false; error: string } {
  const refusal = REFUSALS[pgCode(error) ?? ''];
  if (refusal) return { ok: false, error: refusal };
  // The code only: the error object can carry a path or a file name.
  console.error(`[finance] ${fnName} failed:`, pgCode(error) ?? 'no code');
  return { ok: false, error: WRITE_FAILED };
}

/* ---- writes ----------------------------------------------------------- */

/**
 * Records an uploaded file as a receipt in review. Safe to call twice for
 * one file: when the first call's answer was lost and the row is there, the
 * second answers with that row.
 */
export async function registerReceipt(
  ctx: FinanceWriteContext,
  input: z.input<typeof registerReceiptInput>,
): Promise<FinResult<{ id: string }>> {
  const parsed = registerReceiptInput.parse(input);
  // Before the database is asked anything: a path outside the caller's own workspace is never recorded.
  if (!isInboxReceiptPath(parsed.path, ctx.orgId)) return { ok: false, error: M.fileGone };
  const { data, error } = await ctx.client.rpc('finance_register_receipt', {
    target_org: ctx.orgId,
    file: { path: parsed.path, name: parsed.name },
  });
  if (!error && typeof data === 'string') return { ok: true, data: { id: data } };
  const code = pgCode(error);
  if (code === FIN_FILE || code === PG_UNIQUE) {
    // "The file is already a receipt" has the same code as "the file is not there". Look: if this
    // workspace has the row, an earlier call made it.
    const existing = await ctx.client
      .from('finance_receipts')
      .select('id')
      .eq('org_id', ctx.orgId)
      .eq('file_path', parsed.path)
      .limit(1);
    if (existing.error) {
      // Not knowing is not the same as the file being gone: trying again records the same path.
      console.error('[finance] registerReceipt look-up failed:', pgCode(existing.error) ?? 'no code');
      return { ok: false, error: M.notSaved };
    }
    const found = existing.data?.[0] as { id: string } | undefined;
    if (found) return { ok: true, data: { id: found.id } };
    return { ok: false, error: M.fileGone };
  }
  if (code === PG_FORBIDDEN) return { ok: false, error: NOT_ALLOWED };
  // A name or a path the table's checks refuse: the schema cleans the name and the path was checked above.
  if (code === PG_CHECK) return { ok: false, error: M.notSaved };
  console.error('[finance] registerReceipt failed:', code ?? 'no code');
  return { ok: false, error: M.notSaved };
}

/** Saves what a person typed. A receipt in review becomes unmatched; a matched one keeps its document. */
export async function reviewReceipt(
  ctx: FinanceWriteContext,
  input: z.input<typeof reviewReceiptInput>,
): Promise<FinResult<{ id: string }>> {
  const parsed = reviewReceiptInput.parse(input);
  const { error } = await ctx.client.rpc('finance_review_receipt', {
    target_org: ctx.orgId,
    target_receipt: parsed.id,
    details: {
      vendor: parsed.vendor,
      receipt_date: parsed.receipt_date,
      amount: parsed.amount,
      sst_amount: parsed.sst_amount,
    },
  });
  if (error) return inboxWriteFailed('reviewReceipt', error);
  return { ok: true, data: { id: parsed.id } };
}

/**
 * Deletes a receipt that is tied to nothing, and answers with the path of the
 * file it had: the database has queued that file for removal, and the caller
 * removes it (`removeReleasedReceiptFile`). The path goes no further than the
 * server. A matched receipt is refused by the guard (FIN23).
 */
export async function deleteInboxReceipt(
  ctx: FinanceWriteContext,
  input: z.input<typeof receiptIdInput>,
): Promise<FinResult<{ id: string; file_path: string | null }>> {
  const parsed = receiptIdInput.parse(input);
  const { data, error } = await ctx.client
    .from('finance_receipts')
    .delete()
    .eq('org_id', ctx.orgId)
    .eq('id', parsed.id)
    .select('id,file_path');
  if (error) return inboxWriteFailed('deleteInboxReceipt', error);
  const gone = (data ?? [])[0] as { id: string; file_path: string | null } | undefined;
  if (!gone) return { ok: false, error: M.gone };
  return { ok: true, data: { id: gone.id, file_path: gone.file_path } };
}

/* ---- the file --------------------------------------------------------- */

export type ReceiptFile = { path: string; type: InboxReceiptType };

/** Where a receipt's file is and what the receipt says it is, read as the caller. For the server only. */
export async function getReceiptFile(ctx: FinanceWriteContext, receiptId: string): Promise<FinResult<ReceiptFile>> {
  const { data, error } = await ctx.client
    .from('finance_receipts')
    .select('file_path,mime_type')
    .eq('org_id', ctx.orgId)
    .eq('id', receiptId)
    .limit(1);
  if (error) {
    console.error('[finance] getReceiptFile failed:', pgCode(error) ?? 'no code');
    return { ok: false, error: READ_FAILED };
  }
  const row = (data ?? [])[0] as { file_path: string | null; mime_type: InboxReceiptType } | undefined;
  if (!row) return { ok: false, error: M.gone };
  if (!row.file_path || !isInboxReceiptPath(row.file_path, ctx.orgId)) return { ok: false, error: M.noFile };
  return { ok: true, data: { path: row.file_path, type: row.mime_type } };
}

/**
 * A link to the file that works for a minute, signed as the caller, so the
 * bucket's read rule decides. It always carries a download name of ours:
 * storage then serves the file as an attachment, which a browser saves and
 * never draws as a page.
 */
export async function signReceiptLink(ctx: FinanceWriteContext, file: ReceiptFile): Promise<FinResult<{ url: string }>> {
  try {
    const { data, error } = await ctx.client.storage
      .from(INBOX_RECEIPT_BUCKET)
      .createSignedUrl(file.path, RECEIPT_LINK_SECONDS, { download: receiptDownloadName(file.type) });
    if (!error && data?.signedUrl) return { ok: true, data: { url: data.signedUrl } };
  } catch {
    // Reported the same way as a refused link.
  }
  console.error('[finance] a receipt link could not be made.');
  return { ok: false, error: M.fileUnavailable };
}

/** What `receiptLinkAction` answers with. */
export type ReceiptLink = {
  /** Works for a minute, and is always served as a download. */
  url: string;
  type: InboxReceiptType;
  /** Whether the browser may draw it (a JPG or a PNG), from bytes it fetches and checks itself. */
  preview: boolean;
};

/* ---- the review form -------------------------------------------------- */

/** The review card's fields, as text. */
export type ReceiptReviewForm = { vendor: string; date: string; amount: string; sst: string };

/** The form for a receipt: what it holds now, or empty boxes. */
export function reviewFormOf(row: Pick<InboxReceiptRow, 'vendor' | 'receipt_date' | 'amount' | 'sst_amount'>): ReceiptReviewForm {
  return {
    vendor: row.vendor ?? '',
    date: row.receipt_date ?? '',
    amount: row.amount === null ? '' : row.amount.toFixed(2),
    sst: row.sst_amount === null ? '' : row.sst_amount.toFixed(2),
  };
}

/** An empty box is nothing; anything else is the number typed, or NaN, which the schema refuses with the box's sentence. */
const typedOrNull = (text: string): number | null => (text.trim() === '' ? null : (typedNumber(text) ?? Number.NaN));

/** What the form sends to `reviewReceiptAction`. */
export function reviewFormInput(receiptId: string, form: ReceiptReviewForm): z.input<typeof reviewReceiptInput> {
  return {
    id: receiptId,
    vendor: form.vendor,
    receipt_date: form.date,
    amount: typedOrNull(form.amount),
    sst_amount: typedOrNull(form.sst),
  };
}

/**
 * The first thing wrong with the form, as the sentence the server would give,
 * or null. `today` is the person's own date: a receipt dated after it is
 * refused here, and only here (the server's day can be the day before).
 */
export function reviewFormProblem(receiptId: string, form: ReceiptReviewForm, today: string): string | null {
  const parsed = reviewReceiptInput.safeParse(reviewFormInput(receiptId, form));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? M.invalid;
  if (parsed.data.receipt_date !== null && parsed.data.receipt_date > today) return M.future;
  return null;
}

/** The review card's sentence over a receipt whose reading failed: now there is somewhere to type. */
export const INBOX_READING_FAILED_REVIEW = 'This receipt could not be read automatically. Type the details in.';

/* ---- what was just written, when the list does not show it ------------- */

/** What the screen last did: files added to the inbox, or one receipt reviewed. */
export type InboxWritten = { kind: 'added'; ids: string[] } | { kind: 'reviewed'; ids: string[] };

/**
 * A sentence for when what was just written is not among the rows on the
 * screen, or null when all of it is. A new receipt is in "To review" and
 * newest, so only a status filter, a search or the wait for the list to
 * refresh hides it; a reviewed receipt leaves "To review" for "Unmatched".
 * `listed` is every receipt the screen has; `shown` is the rows drawn.
 */
export function inboxHiddenNote(
  written: InboxWritten,
  listed: { id: string }[],
  shown: { id: string }[],
  filter: 'all' | 'review' | 'matched' | 'unmatched',
): string | null {
  const drawn = new Set(shown.map((r) => r.id));
  const known = new Set(listed.map((r) => r.id));
  // A row the list has not caught up with yet is not "hidden": it will appear with the refresh.
  const hidden = written.ids.filter((id) => known.has(id) && !drawn.has(id));
  if (hidden.length === 0) return null;
  if (written.kind === 'reviewed') {
    return filter === 'review'
      ? 'Saved. The receipt is now under Unmatched: choose Unmatched or All receipts in the status filter to see it.'
      : 'Saved. Clear the search or choose View all to see the receipt.';
  }
  const what = hidden.length === 1 ? '1 receipt was added and is' : `${hidden.length} receipts were added and are`;
  return filter === 'matched' || filter === 'unmatched'
    ? `${what} under To review: choose To review or All receipts in the status filter.`
    : `${what} not in the rows below: clear the search or choose View all.`;
}

/**
 * Whether a key press closes the review card: Escape pressed inside the card,
 * not while a save is on its way, and not the Escape that ends text
 * composition (an input method's candidate list uses it too).
 */
export function escapeClosesCard(key: { key: string; keyCode?: number; isComposing?: boolean }, saving: boolean): boolean {
  return key.key === 'Escape' && !saving && key.isComposing !== true && key.keyCode !== 229;
}
