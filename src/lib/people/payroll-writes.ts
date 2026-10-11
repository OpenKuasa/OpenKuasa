/**
 * The app's write path for payroll. Every change is one call to a database
 * function (`hr_run_payroll`, `hr_save_payslip_line`, ...): the three payroll
 * tables take no direct writes, and the functions decide who may do what, work
 * out every figure on a payslip and refuse a change to a paid run. This file
 * only checks the shape of an input, makes the call and turns a refusal into a
 * sentence. No payslip figure is worked out here.
 *
 * Money crosses this boundary as integer cents. A refusal arrives as a Postgres
 * error whose message is a bare code, for example `PAYROLL_NOT_DRAFT`. The
 * workspace is an argument only for a new run, and there it comes from the
 * session's context, never from the input. Nothing typed (a line's name) and
 * no amount is ever logged: only the database's code and the function's name.
 */
import { z } from 'zod';
import {
  type CapResult,
  type PeopleWriteContext,
  refuse,
  writeFailed,
} from './capabilities';
import { blank } from './loose-input';
import { PAYROLL_REFUSALS } from './payroll-refusals';
import { STATUTORY_FIELDS } from './statutory-fields';
import type { StatutoryField } from './types';

// ---- Sentences ---------------------------------------------------------------

export { PAYROLL_REFUSALS };

type DbError = { code?: string; message?: string } | null | undefined;

/** The whole message when it is one bare upper-case code, else null. A message that merely mentions a code is not a refusal. */
const bareCode = (message: string | undefined): string | null => /^[A-Z][A-Z_]+$/.exec(message ?? '')?.[0] ?? null;

/** A known code is answered with its sentence; anything else is logged, code and message only, and answered generically. */
function failed(fn: string, error: DbError): CapResult<never> {
  const code = bareCode(error?.message);
  if (code && Object.hasOwn(PAYROLL_REFUSALS, code)) return refuse(PAYROLL_REFUSALS[code]);
  return writeFailed(fn, error);
}

// ---- Inputs --------------------------------------------------------------------

// Any Postgres uuid: `.uuid()` would refuse ids that are valid but not RFC-versioned.
const guid = (what: string) => z.guid().describe(what);

/** The database accepts 1 to 100,000,000,000 cents on a line (RM 1,000,000,000). */
const MAX_LINE_CENTS = 100_000_000_000;

const month = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'The month must be a real month, as YYYY-MM.')
  .refine((value) => value >= '2000-01', 'The month cannot be before the year 2000.');

const STATUTORY: readonly StatutoryField[] = STATUTORY_FIELDS;

// An empty string from a model means "no line": the same helper reads it for the card and for the save.
// Anything else that is not text (a number, an object) is refused, never read as "add a line".
const lineId = z
  .preprocess(
    (value) => (value === undefined || value === null || typeof value === 'string' ? blank(value) : value),
    guid('The line to change, by its id. Leave out to add one.').nullable(),
  )
  .optional();

export const runPayrollInput = z.object({ month });
export const runIdInput = z.object({ run_id: guid('The payroll run, by its id.') });
export const savePayslipLineInput = z.object({
  payslip_id: guid('The payslip, by its id.'),
  line_id: lineId,
  kind: z.enum(['earning', 'deduction']),
  label: z.string().trim().min(1, 'Give the line a name.').max(80, 'Keep the name to 80 characters.'),
  amount_cents: z
    .number()
    .int('The amount must be whole cents.')
    .min(1, 'The amount must be above zero.')
    .max(MAX_LINE_CENTS, 'That amount is too large.'),
});
export const lineIdInput = z.object({ line_id: guid('The line, by its id.') });
export const setStatutoryInput = z.object({
  payslip_id: guid('The payslip, by its id.'),
  field: z.enum(STATUTORY as [StatutoryField, ...StatutoryField[]]),
  // Null puts the figure back to the proposed amount. A missing amount is refused, not read as null.
  amount_cents: z
    .number()
    .int('The amount must be whole cents.')
    .min(0, 'The amount cannot be below zero.')
    .max(MAX_LINE_CENTS, 'That amount is too large.')
    .nullable(),
});
export const payslipIdInput = z.object({ payslip_id: guid('The payslip, by its id.') });

function parse<S extends z.ZodType>(schema: S, input: unknown): CapResult<z.infer<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return refuse(parsed.error.issues[0]?.message ?? 'That input was not valid.');
}

// ---- Calls -----------------------------------------------------------------------

export type RunResult = {
  run_id: string;
  /** `YYYY-MM`. */
  month: string;
  /** The run's payslips after the call. */
  payslips: number;
  /** Overtime lines in the run for work dated before the run's month (paid late). */
  earlier_overtime: number;
  /** Recalculating only: how many of them are new. */
  added?: number;
  skipped: { employee_id: string; name: string; reason: 'no_salary' }[];
};

/** A payslip as the functions hand it back. It carries no employee name, no run id and no lines. */
export type SavedPayslip = {
  id: string;
  employee_id: string;
  /** `YYYY-MM-DD`, the first of the month. */
  period_month: string;
  basic_cents: number;
  gross_cents: number;
  epf_cents: number;
  socso_cents: number;
  eis_cents: number;
  pcb_cents: number;
  other_deductions_cents: number;
  net_cents: number;
  set_by_hr: StatutoryField[];
  status: 'pending' | 'paid';
};

export type SavedLine = {
  id: string;
  kind: 'earning' | 'deduction';
  source: string;
  label: string;
  amount_cents: number;
};

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const cents = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) ? value : null);

/** One database function. `pick` shapes its reply, or returns null for a reply that is not what was promised. */
async function call<T>(
  ctx: PeopleWriteContext,
  fn: string,
  rpc: string,
  args: Row,
  pick: (row: Row) => T | null,
): Promise<CapResult<T>> {
  const { data, error } = await ctx.client.rpc(rpc, args);
  if (error) return failed(fn, error);
  const picked = isRow(data) ? pick(data) : null;
  if (picked === null) return writeFailed(fn, { message: 'unexpected reply' });
  return { ok: true, data: picked };
}

function pickRunResult(row: Row): RunResult | null {
  const run = row.run;
  const payslips = count(row.payslips);
  if (!isRow(run) || payslips === null || !Array.isArray(row.skipped)) return null;
  const runId = text(run.id);
  const periodMonth = text(run.period_month);
  if (!runId || !periodMonth || !/^\d{4}-\d{2}-\d{2}$/.test(periodMonth)) return null;
  const skipped: RunResult['skipped'] = [];
  for (const entry of row.skipped) {
    if (!isRow(entry)) return null;
    const employeeId = text(entry.employee_id);
    const name = text(entry.name);
    if (!employeeId || !name || entry.reason !== 'no_salary') return null;
    skipped.push({ employee_id: employeeId, name, reason: 'no_salary' });
  }
  const earlier = count(row.earlier_overtime);
  if (earlier === null) return null;
  const result: RunResult = { run_id: runId, month: periodMonth.slice(0, 7), payslips, earlier_overtime: earlier, skipped };
  if (row.added !== undefined) {
    const added = count(row.added);
    if (added === null) return null;
    result.added = added;
  }
  return result;
}

function pickPayslip(value: unknown): SavedPayslip | null {
  if (!isRow(value)) return null;
  const id = text(value.id);
  const employeeId = text(value.employee_id);
  const periodMonth = text(value.period_month);
  const status = value.status === 'pending' || value.status === 'paid' ? value.status : null;
  const figures = {
    basic_cents: cents(value.basic_cents),
    gross_cents: cents(value.gross_cents),
    epf_cents: cents(value.epf_cents),
    socso_cents: cents(value.socso_cents),
    eis_cents: cents(value.eis_cents),
    pcb_cents: cents(value.pcb_cents),
    other_deductions_cents: cents(value.other_deductions_cents),
    net_cents: cents(value.net_cents),
  };
  if (!id || !employeeId || !periodMonth || !status) return null;
  if (!Array.isArray(value.set_by_hr)) return null;
  const marked = value.set_by_hr;
  if (marked.some((field) => !STATUTORY.includes(field as StatutoryField))) return null;
  // The database keeps the four in a fixed order; this keeps that order whatever it sent.
  const set_by_hr = STATUTORY.filter((field) => marked.includes(field));
  if (Object.values(figures).some((figure) => figure === null)) return null;
  return { id, employee_id: employeeId, period_month: periodMonth, ...(figures as Record<keyof typeof figures, number>), set_by_hr, status };
}

const pickPayslipReply = (row: Row): SavedPayslip | null => pickPayslip(row.payslip);

const pickRunStatus = (row: Row): { id: string; period_month: string } | null => {
  const id = text(row.id);
  const periodMonth = text(row.period_month);
  return id && periodMonth ? { id, period_month: periodMonth } : null;
};

/** Creates the draft run for a month (`YYYY-MM`) and its payslips. The workspace is the session's. */
export async function runPayroll(
  ctx: PeopleWriteContext,
  input: z.infer<typeof runPayrollInput>,
): Promise<CapResult<RunResult>> {
  const parsed = parse(runPayrollInput, input);
  if (!parsed.ok) return parsed;
  return call(
    ctx,
    'runPayroll',
    'hr_run_payroll',
    { p_org: ctx.orgId, p_month: `${parsed.data.month}-01` },
    pickRunResult,
  );
}

/** Rebuilds a draft from what is on file now. Lines and figures an owner or admin wrote are kept. */
export async function recalculatePayroll(
  ctx: PeopleWriteContext,
  input: z.infer<typeof runIdInput>,
): Promise<CapResult<RunResult>> {
  const parsed = parse(runIdInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'recalculatePayroll', 'hr_recalculate_payroll', { p_run: parsed.data.run_id }, pickRunResult);
}

/** Adds a line to a draft payslip (no `line_id`) or changes one an owner or admin wrote. */
export async function savePayslipLine(
  ctx: PeopleWriteContext,
  input: z.input<typeof savePayslipLineInput>,
): Promise<CapResult<SavedPayslip & { line: SavedLine }>> {
  const parsed = parse(savePayslipLineInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return call(
    ctx,
    'savePayslipLine',
    'hr_save_payslip_line',
    {
      p_payslip: v.payslip_id,
      p_line: v.line_id ?? null,
      p_kind: v.kind,
      p_label: v.label,
      p_amount_cents: v.amount_cents,
    },
    (row) => {
      const payslip = pickPayslip(row.payslip);
      const line = isRow(row.line) ? row.line : null;
      if (!payslip || !line) return null;
      const id = text(line.id);
      const label = text(line.label);
      const amount = cents(line.amount_cents);
      const kind = line.kind === 'earning' || line.kind === 'deduction' ? line.kind : null;
      if (!id || !label || amount === null || !kind) return null;
      return { ...payslip, line: { id, kind, source: text(line.source) ?? 'hr', label, amount_cents: amount } };
    },
  );
}

/** Removes a line an owner or admin wrote. */
export async function deletePayslipLine(
  ctx: PeopleWriteContext,
  input: z.infer<typeof lineIdInput>,
): Promise<CapResult<SavedPayslip>> {
  const parsed = parse(lineIdInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'deletePayslipLine', 'hr_delete_payslip_line', { p_line: parsed.data.line_id }, pickPayslipReply);
}

/** Types over one of EPF, SOCSO, EIS or PCB, or (a null amount) puts it back to the proposed amount. */
export async function setPayslipStatutory(
  ctx: PeopleWriteContext,
  input: z.infer<typeof setStatutoryInput>,
): Promise<CapResult<SavedPayslip>> {
  const parsed = parse(setStatutoryInput, input);
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  return call(
    ctx,
    'setPayslipStatutory',
    'hr_set_statutory',
    { p_payslip: v.payslip_id, p_field: v.field, p_amount_cents: v.amount_cents },
    pickPayslipReply,
  );
}

/** Takes one payslip out of a draft. Its overtime is released. */
export async function removePayslip(
  ctx: PeopleWriteContext,
  input: z.infer<typeof payslipIdInput>,
): Promise<CapResult<{ run_id: string; employee_id: string }>> {
  const parsed = parse(payslipIdInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'removePayslip', 'hr_remove_payslip', { p_payslip: parsed.data.payslip_id }, (row) => {
    const runId = text(row.run_id);
    const employeeId = text(row.employee_id);
    return runId && employeeId ? { run_id: runId, employee_id: employeeId } : null;
  });
}

/** Deletes a draft run and its payslips. */
export async function deletePayrollRun(
  ctx: PeopleWriteContext,
  input: z.infer<typeof runIdInput>,
): Promise<CapResult<{ id: string }>> {
  const parsed = parse(runIdInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'deletePayrollRun', 'hr_delete_payroll_run', { p_run: parsed.data.run_id }, (row) => {
    const id = text(row.id);
    return id ? { id } : null;
  });
}

/** Marks the run and every payslip in it paid. `period_month` is `YYYY-MM-DD`. */
export async function markPayrollPaid(
  ctx: PeopleWriteContext,
  input: z.infer<typeof runIdInput>,
): Promise<CapResult<{ id: string; period_month: string }>> {
  const parsed = parse(runIdInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'markPayrollPaid', 'hr_mark_payroll_paid', { p_run: parsed.data.run_id }, pickRunStatus);
}

/** Puts a paid run back to a draft. `period_month` is `YYYY-MM-DD`. */
export async function unmarkPayrollPaid(
  ctx: PeopleWriteContext,
  input: z.infer<typeof runIdInput>,
): Promise<CapResult<{ id: string; period_month: string }>> {
  const parsed = parse(runIdInput, input);
  if (!parsed.ok) return parsed;
  return call(ctx, 'unmarkPayrollPaid', 'hr_unmark_payroll_paid', { p_run: parsed.data.run_id }, pickRunStatus);
}
