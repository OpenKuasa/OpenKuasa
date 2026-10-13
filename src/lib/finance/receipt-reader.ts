import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type LanguageModel, Output, generateText } from 'ai';
import { logModelCall, modelErrorCode } from '@/lib/ai/call-log';
import { cachedInstructions } from '@/lib/ai/prompt-cache';
import { isInboxReceiptPath, sniffReceiptType } from './receipt-files';
import {
  RECEIPT_READING_MESSAGES,
  RECEIPT_READING_STORED_ERROR,
  RECEIPT_READ_SYSTEM,
  RECEIPT_READ_USER,
  type ReceiptKeyState,
  type ReceiptReadingFields,
  categoryListText,
  normalizeReading,
  readableReceiptType,
  receiptReadingSchema,
} from './receipt-reading';
import { INBOX_RECEIPT_MAX_BYTES, INBOX_RECEIPT_TYPES, type InboxReceiptStatus, type InboxReceiptType } from './receipts';
import { type FinResult, type FinanceWriteContext, READ_FAILED, pgCode } from './result';

/**
 * The server's half of reading a receipt with a model: which model, whether
 * the workspace has a key, the receipt as the caller may read it, fetching
 * the stored file, the one call, and writing down what came back.
 *
 * The call carries the instructions, one sentence, the workspace's expense
 * category names as a numbered list, and the file, as a file part of the
 * user's message (the AI SDK's `{ type: 'file', mediaType, data }`; see
 * node_modules/ai/docs/02-foundations/03-prompts.mdx, "File Parts"). A file
 * inside a tool result is dropped by some models; there is no tool here at
 * all. There is no history and nothing else of the workspace in it, so text
 * on a receipt has nothing to act through; the answer is five fields, checked
 * by `normalizeReading`.
 *
 * Nothing of the receipt is logged: not its name, its vendor or its bytes. A
 * failed call logs a status code only (`modelErrorCode`); a provider's error
 * object carries the request, and the request carries the file.
 */

type EnvLike = Record<string, string | undefined>;

/**
 * The model that reads receipts: `OPENKUASA_MODEL_RECEIPTS`, else the worker
 * model `OPENKUASA_MODEL_WORKER`, else null. There is no id in code: with
 * neither set, reading is refused and says so.
 */
export function receiptModelId(env: EnvLike = process.env): string | null {
  return env.OPENKUASA_MODEL_RECEIPTS?.trim() || env.OPENKUASA_MODEL_WORKER?.trim() || null;
}

/** How long a reading may take before it counts as failed. */
export const RECEIPT_READ_TIMEOUT_MS = 45_000;
/**
 * How OpenRouter reads a PDF. `native` is the model's own PDF input and costs only the model's tokens. The others
 * (`mistral-ocr`, and `pdf-text`) are OpenRouter's own parsers, one of which is billed per page to the account even
 * when the model is free; OpenRouter picks one of them when a model has no PDF input and none is named. Naming this
 * one means a model that cannot take a PDF answers with an error instead (see `unsupported`), and nothing is billed.
 */
export const RECEIPT_PDF_ENGINE = 'native';
/** The most a reading may say back: five short fields. */
export const RECEIPT_READ_MAX_OUTPUT_TOKENS = 300;
/** How long fetching the stored file may take. */
const FILE_FETCH_TIMEOUT_MS = 15_000;

/**
 * Whether the caller's workspace has an AI key, asked as the caller
 * (`org_ai_key_status` answers for the session's own workspace, and for
 * nobody who owes a second factor). The key itself is not read here.
 */
export async function workspaceKeyState(client: SupabaseClient): Promise<ReceiptKeyState> {
  try {
    const { data, error } = await client.rpc('org_ai_key_status');
    if (error) {
      console.error('[finance/receipts] the workspace key’s state could not be read:', pgCode(error) ?? 'no code');
      return 'unknown';
    }
    return (Array.isArray(data) ? data.length > 0 : Boolean(data)) ? 'set' : 'none';
  } catch {
    console.error('[finance/receipts] the workspace key’s state could not be read: the call failed');
    return 'unknown';
  }
}

/** A receipt as the reading needs it: how it stands, where its file is, and what its four boxes hold now. */
export type ReceiptForReading = {
  status: InboxReceiptStatus;
  /** Null when the receipt has no file, or its path is not this workspace's. The path stays on the server. */
  file: { path: string; type: InboxReceiptType } | null;
  details: { vendor: string | null; receipt_date: string | null; amount: number | null; sst_amount: number | null };
  /** When a reading was last stored; null when no model has read this receipt. A failed new reading leaves such a reading alone. */
  extractedAt: string | null;
  /** The stored file's size, set by the database from the object; null when not recorded. */
  sizeBytes: number | null;
};

const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** Reads one receipt as the caller, so row-level security decides whether it is theirs to see. */
export async function getReceiptForReading(ctx: FinanceWriteContext, receiptId: string): Promise<FinResult<ReceiptForReading>> {
  const { data, error } = await ctx.client
    .from('finance_receipts')
    .select('status,file_path,mime_type,vendor,receipt_date,amount,sst_amount,extracted_at,size_bytes')
    .eq('org_id', ctx.orgId)
    .eq('id', receiptId)
    .limit(1);
  if (error) {
    console.error('[finance] getReceiptForReading failed:', pgCode(error) ?? 'no code');
    return { ok: false, error: READ_FAILED };
  }
  const row = (data ?? [])[0] as
    | {
        status: InboxReceiptStatus;
        file_path: string | null;
        mime_type: InboxReceiptType;
        vendor: string | null;
        receipt_date: string | null;
        amount: unknown;
        sst_amount: unknown;
        extracted_at?: string | null;
        size_bytes?: unknown;
      }
    | undefined;
  if (!row) return { ok: false, error: RECEIPT_READING_MESSAGES.gone };
  const held = row.file_path && isInboxReceiptPath(row.file_path, ctx.orgId) ? { path: row.file_path, type: row.mime_type } : null;
  return {
    ok: true,
    data: {
      status: row.status,
      file: held,
      details: {
        vendor: row.vendor,
        receipt_date: row.receipt_date,
        amount: numberOrNull(row.amount),
        sst_amount: numberOrNull(row.sst_amount),
      },
      extractedAt: row.extracted_at ?? null,
      sizeBytes: numberOrNull(row.size_bytes),
    },
  };
}

/** The four boxes of a receipt, as `finance_set_receipt_extraction` takes them. */
export type ReceiptDetails = ReceiptForReading['details'];

/**
 * Writes a reading, or a failed one, as the caller. The database writes only
 * while the receipt is still in review and answers whether it did:
 * `written: false` means someone reviewed or matched it meanwhile, and
 * nothing changed.
 *
 * The function sets all four boxes from what it is given, error or not. So a
 * failed reading is written with `keep`, the values the receipt held before
 * the call: an error sent alone would clear what a person had typed.
 */
export async function setReceiptExtraction(
  ctx: FinanceWriteContext,
  receiptId: string,
  outcome: { read: ReceiptDetails } | { failed: true; keep: ReceiptDetails },
): Promise<FinResult<{ written: boolean }>> {
  const details =
    'read' in outcome
      ? { vendor: outcome.read.vendor, receipt_date: outcome.read.receipt_date, amount: outcome.read.amount, sst_amount: outcome.read.sst_amount }
      : {
          vendor: outcome.keep.vendor,
          receipt_date: outcome.keep.receipt_date,
          amount: outcome.keep.amount,
          sst_amount: outcome.keep.sst_amount,
          error: RECEIPT_READING_STORED_ERROR,
        };
  const { data, error } = await ctx.client.rpc('finance_set_receipt_extraction', {
    target_org: ctx.orgId,
    target_receipt: receiptId,
    details,
  });
  if (error || typeof data !== 'boolean') {
    // The code only: the error can quote the values it refused, and those are the receipt's.
    console.error('[finance] setReceiptExtraction failed:', pgCode(error) ?? 'no code');
    return { ok: false, error: RECEIPT_READING_MESSAGES.notSaved };
  }
  return { ok: true, data: { written: data } };
}

/**
 * The whole stored file, through a link signed as the caller, or null when it
 * could not be fetched or is larger than a receipt may be; an empty file
 * answers empty. The bytes are
 * counted as they arrive, so a store that served something huge is cut off.
 */
export async function receiptBytes(
  url: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = FILE_FETCH_TIMEOUT_MS,
): Promise<Uint8Array | null> {
  try {
    const res = await fetcher(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > INBOX_RECEIPT_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    // Empty is returned as empty, not as a failed fetch: the caller says a different thing about a file that will never open.
    if (total === 0) return new Uint8Array(0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Whether these bytes may be sent as `type`: they are that type by their
 * first bytes (what the receipt's row says is the uploader's word), and the
 * type is one that is sent. `mismatch` and `heic` send nothing.
 */
export function sendableAs(bytes: Uint8Array, type: InboxReceiptType): 'ok' | 'mismatch' | 'heic' {
  if (!readableReceiptType(type)) return 'heic';
  return sniffReceiptType(bytes) === type ? 'ok' : 'mismatch';
}

export type ReceiptReading =
  | ({ ok: true } & ReceiptReadingFields)
  /**
   * `nothing`: the model answered and no field survived the checks. `key`: the provider refused the key (401).
   * `credit`: it says there is no credit (402). `failed`: the model answered and the answer was not the five fields.
   * `unavailable`: the provider could not do it just now (busy, down, a model that takes no file, no connection, a
   * timeout): nothing is known about the receipt, so nothing is stored about it.
   */
  | { ok: false; reason: 'nothing' | 'key' | 'credit' | 'failed' | 'unavailable' | 'unsupported' };

/** An error that is the model's answer not fitting the schema, as opposed to the call not going through. */
const ANSWER_NOT_FIT = /NoObjectGenerated|TypeValidation|JSONParse|NoOutput/;

/**
 * One call to the model, with the file. `model` is built by the caller from
 * the workspace's own key; `modelId` is only for the log line. Never throws.
 * `today` is the server's date, for the check that a receipt is not dated in
 * the future. `categoryNames` are names only, in the order the caller will
 * read the answer's number back against.
 */
export async function readReceiptWithModel(input: {
  model: LanguageModel;
  modelId: string;
  bytes: Uint8Array;
  mediaType: InboxReceiptType;
  today: string;
  categoryNames?: string[];
  timeoutMs?: number;
}): Promise<ReceiptReading> {
  const names = input.categoryNames ?? [];
  const list = categoryListText(names);
  try {
    const result = await generateText({
      model: input.model,
      // The same words on every call, so they are marked for the provider's cache like every other prompt.
      system: cachedInstructions(RECEIPT_READ_SYSTEM),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: RECEIPT_READ_USER },
            ...(list === null ? [] : [{ type: 'text' as const, text: list }]),
            // A name of ours: the person's file name is not sent.
            { type: 'file', mediaType: input.mediaType, data: input.bytes, filename: `receipt.${INBOX_RECEIPT_TYPES[input.mediaType]}` },
          ],
        },
      ],
      output: Output.object({ schema: receiptReadingSchema }),
      // Only a PDF has a parser to choose, and it is never a paid one.
      ...(input.mediaType === 'application/pdf'
        ? { providerOptions: { openrouter: { plugins: [{ id: 'file-parser', pdf: { engine: RECEIPT_PDF_ENGINE } }] } } }
        : {}),
      maxOutputTokens: RECEIPT_READ_MAX_OUTPUT_TOKENS,
      // One press is one call: a retry would spend the workspace's credit twice without the person asking.
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(input.timeoutMs ?? RECEIPT_READ_TIMEOUT_MS),
      onLanguageModelCallEnd: logModelCall('receipt-reader', input.modelId),
    });
    const fields = normalizeReading(result.output, input.today, names.length);
    return fields ? { ok: true, ...fields } : { ok: false, reason: 'nothing' };
  } catch (error) {
    const failure = modelErrorCode(error);
    console.error('[ai] receipt-reader model call failed:', failure);
    if (failure.code === 401) return { ok: false, reason: 'key' };
    if (failure.code === 402) return { ok: false, reason: 'credit' };
    // The request itself was refused: this model takes no such file. A retry cannot help.
    if (failure.code === 400 || failure.code === 404 || failure.code === 422) return { ok: false, reason: 'unsupported' };
    if (typeof failure.code === 'string' && ANSWER_NOT_FIT.test(failure.code)) return { ok: false, reason: 'failed' };
    return { ok: false, reason: 'unavailable' };
  }
}
