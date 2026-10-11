import type { ZodType } from 'zod';
import {
  type CapResult,
  type ReachWriteContext,
  createAppointment,
  createAppointmentInput,
  createForm,
  createFormInput,
  promoteLeadToContact,
  promoteLeadToContactInput,
  setAppointmentStatus,
  setAppointmentStatusInput,
  setLeadStage,
  setLeadStageInput,
  updateAppointment,
  updateAppointmentInput,
  updateForm,
  updateFormInput,
} from '@/lib/reach/capabilities';

export type ApplyResult = { ok: true; result: unknown } | { ok: false; error: string };

type Entry = { schema: ZodType; run: (ctx: ReachWriteContext, input: unknown) => Promise<CapResult<unknown>> };
/** Erase the per-capability input type: parse with the schema, hand the parsed value on. */
function entry<I>(schema: ZodType<I>, cap: (ctx: ReachWriteContext, input: I) => Promise<CapResult<unknown>>): Entry {
  return { schema, run: (ctx, input) => cap(ctx, schema.parse(input) as I) };
}

/**
 * The ONLY reach actions the autonomous agent may propose and the queue may apply:
 * non-destructive, reversible, channel-free. No deletes, publishes, go-live or spend.
 */
export const ALLOWED_ACTIONS: Record<string, Entry> = {
  promoteLeadToContact: entry(promoteLeadToContactInput, promoteLeadToContact),
  setLeadStage: entry(setLeadStageInput, setLeadStage),
  createAppointment: entry(createAppointmentInput, createAppointment),
  updateAppointment: entry(updateAppointmentInput, updateAppointment),
  setAppointmentStatus: entry(setAppointmentStatusInput, setAppointmentStatus),
  createForm: entry(createFormInput, createForm),
  updateForm: entry(updateFormInput, updateForm),
};

export const ALLOWED_ACTION_NAMES = Object.keys(ALLOWED_ACTIONS);
export const isAllowedAction = (action: string): boolean => Object.hasOwn(ALLOWED_ACTIONS, action);

/**
 * Re-validate a persisted proposal's input and run its capability under `ctx`
 * (the OWNER's write context). Mirrors the in-chat applyChange re-validation.
 */
export async function runProposalAction(
  ctx: ReachWriteContext,
  action: string,
  input: unknown,
): Promise<ApplyResult> {
  if (!isAllowedAction(action)) return { ok: false, error: 'That action is not allowed.' };
  const found = ALLOWED_ACTIONS[action];
  const parsed = found.schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'That proposed change is no longer valid.' };
  let res: Awaited<ReturnType<typeof found.run>>;
  try {
    res = await found.run(ctx, parsed.data);
  } catch {
    return { ok: false, error: 'That change could not be applied.' };
  }
  return res.ok ? { ok: true, result: res.data } : { ok: false, error: res.error };
}
