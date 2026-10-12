/**
 * The helpers both write paths (`performance-writes.ts` and `announcement-writes.ts`) share: input ids, parsing,
 * reply shapes, and the one function that makes a database call and turns a refusal into a sentence. A leaf: it
 * imports from neither write path. A refusal arrives as a Postgres error whose message is a bare code. Only the
 * database's code is ever logged: a message can quote what was typed.
 */
import { z } from 'zod';
import {
  type CapResult,
  type PeopleWriteContext,
  refuse,
  writeFailed,
} from './capabilities';
import { blank } from './loose-input';
import { PERFORMANCE_REFUSALS } from './performance-refusals';

type DbError = { code?: string; message?: string } | null | undefined;

/** The whole message when it is one bare upper-case code, else null. A message that merely mentions a code is not a refusal. */
const bareCode = (message: string | undefined): string | null => /^[A-Z][A-Z_]+$/.exec(message ?? '')?.[0] ?? null;

/** A known code is answered with its sentence; anything else is logged (the code only) and answered generically. */
export function failed(fn: string, error: DbError): CapResult<never> {
  const code = bareCode(error?.message);
  if (code && Object.hasOwn(PERFORMANCE_REFUSALS, code)) return refuse(PERFORMANCE_REFUSALS[code]);
  return writeFailed(fn, { code: error?.code });
}

// Any Postgres uuid: `.uuid()` would refuse ids that are valid but not RFC-versioned.
export const guid = (what: string) => z.guid().describe(what);

/**
 * An id that may be left out to mean "add". An empty string (from a model) is none; anything else that is not text
 * (a number, an object) is refused, never read as "add".
 */
export const optionalGuid = (what: string) =>
  z
    .preprocess(
      (value) => (value === undefined || value === null || typeof value === 'string' ? blank(value) : value),
      guid(what).nullable(),
    )
    .optional();

export function parse<S extends z.ZodType>(schema: S, input: unknown): CapResult<z.infer<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return refuse(parsed.error.issues[0]?.message ?? 'That input was not valid.');
}

export type Row = Record<string, unknown>;
export const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
export const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
export const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** One database function. `pick` shapes its reply, or returns null for a reply that is not what was promised. */
export async function call<T>(
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
