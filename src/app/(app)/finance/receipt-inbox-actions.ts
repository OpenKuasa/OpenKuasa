'use server';

import { revalidatePath } from 'next/cache';
import { can } from '@/lib/auth/permissions';
import { getViewer } from '@/lib/auth/viewer';
import { canPreview } from '@/lib/finance/receipt-files';
import { removeReleasedReceiptFile, storedFileCheck } from '@/lib/finance/receipt-files-server';
import {
  RECEIPT_INBOX_MESSAGES,
  type ReceiptLink,
  deleteInboxReceipt,
  getReceiptFile,
  receiptIdInput,
  registerReceipt,
  registerReceiptInput,
  reviewReceipt,
  reviewReceiptInput,
  signReceiptLink,
} from '@/lib/finance/receipt-inbox';
import {
  RECEIPT_BILL_PATHS,
  RECEIPT_EXPENSE_PATHS,
  RECEIPT_TIE_PATHS,
  attachReceipt,
  attachReceiptInput,
  detachReceipt,
  receiptToBill,
  receiptToBillInput,
  receiptToExpense,
  receiptToExpenseInput,
} from '@/lib/finance/receipt-match';
import { getWorkspaceModelById } from '@/lib/ai/provider';
import { consumeDailyQuota } from '@/lib/ai/rate-limit';
import { readWorkspaceKey } from '@/lib/ai/workspace-key';
import { type ExpenseCategory, type SavedExpense, listExpenseCategories } from '@/lib/finance/expenses';
import {
  getReceiptForReading,
  readReceiptWithModel,
  receiptBytes,
  receiptModelId,
  sendableAs,
  setReceiptExtraction,
  workspaceKeyState,
} from '@/lib/finance/receipt-reader';
import {
  RECEIPT_READING_MESSAGES,
  type ReceiptRead,
  categoryAt,
  offeredCategoryNames,
  pdfTooLarge,
  readableReceiptType,
} from '@/lib/finance/receipt-reading';
import { type FinResult, type FinanceWriteContext, NOT_ALLOWED, pgCode } from '@/lib/finance/result';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';

/**
 * The Receipts Inbox's server actions. They are in a file of their own, not
 * in `actions.ts`, because some of them are not the usual guard → parse →
 * write: opening a file reads and signs, deleting a receipt is followed by
 * removing its file with the service client, and reading a receipt with AI
 * sends its file to a model. The guard is the same one: a viewer and the demo
 * workspace change nothing, and send nothing.
 *
 * No upload passes through here. The browser uploads straight to the private
 * bucket; `registerReceiptAction` is told only where the file is. The one
 * action that holds a receipt's bytes is `readReceiptAction`, which fetches
 * them from the bucket through a link signed as the caller.
 */

const FORBIDDEN: FinResult<never> = { ok: false, error: NOT_ALLOWED };
// Recording, reviewing and deleting touch a receipt that is tied to nothing, which only the inbox shows. The four
// actions that match and untie refresh more: their lists are in receipt-match.ts.
const RECEIPT_INBOX_PATHS = ['/finance/receipts-inbox'];

/** A write context, or null when the viewer may not change this workspace's data. */
async function writeCtx(): Promise<FinanceWriteContext | null> {
  const viewer = await getViewer();
  if (viewer.isDemo || !can(viewer.role, 'edit-data')) return null;
  return { client: await createClient(), orgId: viewer.orgId };
}

function refresh(paths: string[] = RECEIPT_INBOX_PATHS) {
  for (const path of paths) revalidatePath(path);
}

function firstMessage(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? 'That input was not valid.';
}

/** Records a file the browser has just uploaded as a receipt in "To review". */
export async function registerReceiptAction(input: unknown): Promise<FinResult<{ id: string }>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = registerReceiptInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const result = await registerReceipt(ctx, parsed.data);
  refresh();
  return result;
}

/** Saves the details a person typed; a receipt in review becomes unmatched. Anyone who may edit. */
export async function reviewReceiptAction(input: unknown): Promise<FinResult<{ id: string }>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = reviewReceiptInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const result = await reviewReceipt(ctx, parsed.data);
  refresh();
  return result;
}

/**
 * Deletes a receipt that is tied to nothing, then removes its file at once.
 * The receipt is gone whether or not the file could be removed: the database
 * has the path on its list, and the clean-up run takes what is left.
 */
export async function deleteReceiptAction(input: unknown): Promise<FinResult<{ id: string }>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = receiptIdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const result = await deleteInboxReceipt(ctx, parsed.data);
  refresh();
  if (!result.ok) return result;
  if (result.data.file_path) {
    try {
      await removeReleasedReceiptFile(serviceClient(), result.data.file_path);
    } catch {
      // No service key on this server: the clean-up run removes the file.
      console.error('[finance/receipts] a deleted receipt’s file was left for the clean-up run.');
    }
  }
  // The path stays on the server.
  return { ok: true, data: { id: result.data.id } };
}

/**
 * A short link to a receipt's file, for anyone who can see the receipt
 * (viewers too: the bucket's read rule is membership). The path is read and
 * the link signed as the caller. Before the link is handed out the server
 * reads the file's first bytes: a file that is not what its receipt says is
 * not opened.
 */
export async function receiptLinkAction(input: unknown): Promise<FinResult<ReceiptLink>> {
  const viewer = await getViewer();
  const parsed = receiptIdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const file = await getReceiptFile(ctx, parsed.data.id);
  if (!file.ok) return file;
  const link = await signReceiptLink(ctx, file.data);
  if (!link.ok) return link;
  const stored = await storedFileCheck(link.data.url, file.data.type);
  if (stored === 'unreadable') return { ok: false, error: RECEIPT_INBOX_MESSAGES.fileUnavailable };
  if (stored === 'mismatch') {
    console.error('[finance/receipts] a stored file is not the type its receipt says.');
    return { ok: false, error: RECEIPT_INBOX_MESSAGES.notWhatItSays };
  }
  return { ok: true, data: { url: link.data.url, type: file.data.type, preview: canPreview(file.data.type) } };
}

/* ---- matching ---------------------------------------------------------- */

/**
 * Makes an expense from a receipt and ties the receipt to it. Anyone who may edit: the database approves the
 * expense in the same call when an owner or admin is saving and leaves it pending otherwise, and the answer says
 * which. Refreshes what saving an expense refreshes.
 */
export async function receiptToExpenseAction(input: unknown): Promise<FinResult<SavedExpense>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = receiptToExpenseInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const result = await receiptToExpense(ctx, parsed.data);
  refresh(RECEIPT_EXPENSE_PATHS);
  return result;
}

/**
 * Makes a draft supplier bill from a receipt and ties the receipt to it. Anyone who may edit: a draft is not a
 * sign-off. Nothing here posts, and there is no action that makes a bill from a receipt and posts it.
 */
export async function receiptToBillAction(input: unknown): Promise<FinResult<{ id: string }>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = receiptToBillInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const result = await receiptToBill(ctx, parsed.data);
  refresh(RECEIPT_BILL_PATHS);
  return result;
}

/** Ties a receipt that is tied to nothing to an expense or a bill of the workspace. Anyone who may edit. */
export async function attachReceiptAction(input: unknown): Promise<FinResult<{ id: string }>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = attachReceiptInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const result = await attachReceipt(ctx, parsed.data);
  refresh(RECEIPT_TIE_PATHS);
  return result;
}

/**
 * Unties a matched receipt. Anyone who may edit, except from an approved expense or a posted bill, which only an
 * owner or admin unties: the receipt's own guard decides that (FIN14), since only the database knows how the
 * document stands at that moment.
 */
export async function detachReceiptAction(input: unknown): Promise<FinResult<{ id: string }>> {
  const ctx = await writeCtx();
  if (!ctx) return FORBIDDEN;
  const parsed = receiptIdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstMessage(parsed.error) };
  const result = await detachReceipt(ctx, parsed.data);
  refresh(RECEIPT_TIE_PATHS);
  return result;
}

/* ---- reading with AI --------------------------------------------------- */

const R = RECEIPT_READING_MESSAGES;
const refused = (error: string): FinResult<never> => ({ ok: false, error });

/**
 * Sends one receipt's file to a model to be read, on the workspace's own AI
 * key, and stores what came back in the receipt's four boxes as a suggestion.
 * Called by one button, after the person has been told what is sent; nothing
 * else in the app calls it. Anyone who may edit, never a viewer or the demo.
 *
 * The order matters: every refusal comes before anything is counted or sent.
 * The receipt and the workspace's categories are read as the caller, the file
 * is fetched through a link signed as the caller and its first bytes checked,
 * and the daily allowance is counted last, immediately before the one call.
 * The platform's key and the free chat questions are never used. The model is
 * given no tool; its answer is checked field by field (`normalizeReading`) and
 * the category it picked is a number in the list of names it was shown, which
 * is turned back into a category here. Only the four details are written, by
 * `finance_set_receipt_extraction`, which writes only while the receipt is
 * still in review; the category goes back to the screen and is stored nowhere.
 */
export async function readReceiptAction(input: unknown): Promise<FinResult<ReceiptRead>> {
  const viewer = await getViewer();
  if (viewer.isDemo || !can(viewer.role, 'edit-data')) return FORBIDDEN;
  const parsed = receiptIdInput.safeParse(input);
  if (!parsed.success) return refused(firstMessage(parsed.error));
  const { id } = parsed.data;
  const modelId = receiptModelId();
  if (!modelId) return refused(R.notSetUp);

  const ctx: FinanceWriteContext = { client: await createClient(), orgId: viewer.orgId };
  const receipt = await getReceiptForReading(ctx, id);
  if (!receipt.ok) return receipt;
  if (receipt.data.status !== 'review') return refused(R.notInReview);
  const file = receipt.data.file;
  if (!file) return refused(R.noFile);
  if (!readableReceiptType(file.type)) return refused(R.heic);
  // A PDF over the bound is refused on its stored size, before a key is opened, a file fetched or a turn counted.
  if (pdfTooLarge(file.type, receipt.data.sizeBytes)) return refused(R.pdfTooBig);

  // The workspace's own key, or nothing. Whether there is one is asked as the caller; the sealed key is opened on
  // the server for the session's own workspace, as chat does.
  const keyState = await workspaceKeyState(ctx.client);
  if (keyState === 'unknown') return refused(R.keyUnknown);
  if (keyState === 'none') return refused(can(viewer.role, 'manage-ai-key') ? R.noKeyCanAdd : R.noKey);
  let model: ReturnType<typeof getWorkspaceModelById>;
  try {
    const stored = await readWorkspaceKey(serviceClient(), viewer.orgId);
    // A key is known to be set, so finding none here is a mismatch to refuse, never a reason to use another key.
    if (stored.status !== 'ok') return refused(R.keyUnusable);
    model = getWorkspaceModelById(modelId, stored.apiKey);
  } catch {
    // No service key on this server.
    console.error('[finance/receipts] the workspace key could not be read on the server.');
    return refused(R.keyUnusable);
  }

  const link = await signReceiptLink(ctx, file);
  if (!link.ok) return refused(R.fileUnavailable);
  const bytes = await receiptBytes(link.data.url);
  if (!bytes) return refused(R.fileUnavailable);
  if (bytes.length === 0) return refused(R.fileEmpty);
  // No size was recorded: the bytes themselves decide, still before anything is counted or sent.
  if (pdfTooLarge(file.type, bytes.length)) return refused(R.pdfTooBig);
  if (sendableAs(bytes, file.type) !== 'ok') {
    console.error('[finance/receipts] a stored file is not the type its receipt says.');
    return refused(R.notWhatItSays);
  }

  // The categories the forms offer, read as the caller. Without them the receipt is still read; no category is suggested.
  let categories: ExpenseCategory[] = [];
  try {
    categories = await listExpenseCategories(ctx);
  } catch (error) {
    console.error('[finance/receipts] the expense categories could not be read:', pgCode(error) ?? 'no code');
  }

  // Counted last, so no refusal above uses a turn of the person's daily allowance on the workspace's key.
  const quota = await consumeDailyQuota(ctx.client);
  if (!quota.allowed) return refused(quota.reason === 'limit' ? R.dailyLimit : R.limitUnavailable);

  const reading = await readReceiptWithModel({
    model,
    modelId,
    bytes,
    mediaType: file.type,
    today: todayUtc(),
    categoryNames: offeredCategoryNames(categories),
  });
  // The provider turned the key away: the receipt was not found unreadable, so nothing is written about it.
  if (!reading.ok && reading.reason === 'key') return refused(R.keyRefused);
  if (!reading.ok && reading.reason === 'credit') return refused(R.noCredit);
  // The call did not get through: the receipt was not found unreadable, so nothing is written about it. The turn
  // counted above is not given back: a chat turn that fails is not either, and the provider may have received and billed the request.
  if (!reading.ok && reading.reason === 'unavailable') return refused(R.unavailable);
  // The model does not take this file: nothing is known about the receipt, so nothing is written, and a retry cannot help.
  if (!reading.ok && reading.reason === 'unsupported') return refused(R.unsupported);
  if (!reading.ok && receipt.data.extractedAt !== null) {
    // A reading already stands: a failed new one writes nothing, so its figures, its mark and the caution above the forms stay.
    return refused(R.failedAgain);
  }
  if (!reading.ok) {
    // The values the receipt held go back with the error: the function would otherwise clear what a person typed.
    await setReceiptExtraction(ctx, id, { failed: true, keep: receipt.data.details });
    refresh();
    return refused(R.failed);
  }
  const wrote = await setReceiptExtraction(ctx, id, { read: reading });
  refresh();
  if (!wrote.ok) return wrote;
  // Someone reviewed or matched the receipt while the model was reading: their work stands and the reading is dropped.
  if (!wrote.data.written) return refused(R.notInReview);
  return { ok: true, data: { id, category: categoryAt(categories, reading.category_index) } };
}
