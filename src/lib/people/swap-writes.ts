/**
 * The app's write path for shift swaps. Each step is one call to a database function (`hr_request_shift_swap`,
 * `hr_reply_shift_swap`, `hr_decide_shift_swap`, `hr_cancel_shift_swap`): the table takes no direct writes, and
 * the functions decide who may do what. This file only validates the shape of an input, makes the call and turns
 * a refusal (a Postgres error whose message begins with a code such as `SWAP_CLASH`) into a sentence.
 */
import { z } from 'zod';
import { type CapResult, type PeopleWriteContext, refuse, writeFailed } from './capabilities';
import { SWAP_REFUSALS } from './swap-refusals';
import type { SwapStatus } from './swaps';

export { SWAP_REFUSALS };

type DbError = { code?: string; message?: string } | null | undefined;

const leadingCode = (message: string | undefined): string | null => /^SWAP_[A-Z_]+/.exec(message ?? '')?.[0] ?? null;

function failed(fn: string, error: DbError): CapResult<never> {
  const code = leadingCode(error?.message);
  if (code && Object.hasOwn(SWAP_REFUSALS, code)) return refuse(SWAP_REFUSALS[code]);
  return writeFailed(fn, error);
}

// ---- Inputs --------------------------------------------------------------------

const guid = z.guid();
const note = z.string().trim().max(500, 'Keep the note to 500 characters.').nullish();

export const requestShiftSwapInput = z
  .object({ my_shift_id: guid, their_shift_id: guid, note })
  .refine((v) => v.my_shift_id !== v.their_shift_id, 'Pick a colleague\'s shift, not your own.');
export const replyShiftSwapInput = z.object({ id: guid, accept: z.boolean() });
export const decideShiftSwapInput = z.object({ id: guid, approve: z.boolean(), note });
export const cancelShiftSwapInput = z.object({ id: guid });

function parse<S extends z.ZodType>(schema: S, input: unknown): CapResult<z.infer<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return refuse(parsed.error.issues[0]?.message ?? 'That input was not valid.');
}

// ---- Calls -----------------------------------------------------------------------

export type SwapSaved = { id: string; status: SwapStatus };

const STATUSES = new Set<string>(['requested', 'accepted', 'declined', 'approved', 'rejected', 'cancelled']);

function reply(fn: string, data: unknown): CapResult<SwapSaved> {
  const row = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  if (!row || typeof row.id !== 'string' || typeof row.status !== 'string' || !STATUSES.has(row.status)) {
    return writeFailed(fn, { message: 'unexpected reply' });
  }
  return { ok: true, data: { id: row.id, status: row.status as SwapStatus } };
}

const blankToNull = (value: string | null | undefined) => (value ? value : null);

/** Asks a colleague to swap: one of the caller's own future shifts for one of theirs. */
export async function requestShiftSwap(ctx: PeopleWriteContext, input: z.infer<typeof requestShiftSwapInput>): Promise<CapResult<SwapSaved>> {
  const parsed = parse(requestShiftSwapInput, input);
  if (!parsed.ok) return parsed;
  const { data, error } = await ctx.client.rpc('hr_request_shift_swap', {
    p_my_shift: parsed.data.my_shift_id,
    p_their_shift: parsed.data.their_shift_id,
    p_note: blankToNull(parsed.data.note),
  });
  if (error) return failed('requestShiftSwap', error);
  return reply('requestShiftSwap', data);
}

/** The colleague accepts or declines. */
export async function replyShiftSwap(ctx: PeopleWriteContext, input: z.infer<typeof replyShiftSwapInput>): Promise<CapResult<SwapSaved>> {
  const parsed = parse(replyShiftSwapInput, input);
  if (!parsed.ok) return parsed;
  const { data, error } = await ctx.client.rpc('hr_reply_shift_swap', { p_swap: parsed.data.id, p_accept: parsed.data.accept });
  if (error) return failed('replyShiftSwap', error);
  return reply('replyShiftSwap', data);
}

/** An owner, an admin or a manager of both approves (the shifts are exchanged) or rejects. */
export async function decideShiftSwap(ctx: PeopleWriteContext, input: z.infer<typeof decideShiftSwapInput>): Promise<CapResult<SwapSaved>> {
  const parsed = parse(decideShiftSwapInput, input);
  if (!parsed.ok) return parsed;
  const { data, error } = await ctx.client.rpc('hr_decide_shift_swap', {
    p_swap: parsed.data.id,
    p_approve: parsed.data.approve,
    p_note: parsed.data.approve ? null : blankToNull(parsed.data.note),
  });
  if (error) return failed('decideShiftSwap', error);
  return reply('decideShiftSwap', data);
}

/** Either of the two people cancels, before a decision. */
export async function cancelShiftSwap(ctx: PeopleWriteContext, input: z.infer<typeof cancelShiftSwapInput>): Promise<CapResult<SwapSaved>> {
  const parsed = parse(cancelShiftSwapInput, input);
  if (!parsed.ok) return parsed;
  const { data, error } = await ctx.client.rpc('hr_cancel_shift_swap', { p_swap: parsed.data.id });
  if (error) return failed('cancelShiftSwap', error);
  return reply('cancelShiftSwap', data);
}
