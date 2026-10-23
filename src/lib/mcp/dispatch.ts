/**
 * Runs one MCP operation: a read, or a change under Tuah's own gate for that tool. A change gets exactly the
 * refusals Tuah gives, because the gate is Tuah's, asked about a conversation laid out as Tuah's would be (the
 * caller's transcript). Where Tuah's card would carry a note, the change does not run on the first call: it
 * returns the note and a short-lived token, and runs only when the same caller sends the same arguments with it.
 *
 * `Operations` must be built for each request, as Tuah's tool map is: some gates count what they let through
 * in a closure, and a map that outlived a request would refuse the next change as a second one.
 *
 * Nothing here logs arguments or results.
 */

import { randomUUID } from 'node:crypto';
import { asSchema, type ModelMessage } from 'ai';
import { revalidateFinance } from '@/lib/ai/finance-revalidate';
import type { Decision } from '@/lib/ai/hire-deletions';
import { stringsIn } from '@/lib/ai/hire-interview-gate';
import { isHeldCvMessage } from '@/lib/ai/hire-tools';
import { changeHeading, changeRows, type ChangeRow } from '@/lib/chat/change-rows';
import { nameIn, rowIn, type ToolResult } from '@/lib/chat/change-titles';
import { canonicalJson, type Bound } from '@/lib/chat/proposal-store';
import type { Operation, Operations } from '@/lib/mcp/operations';
import type { TranscriptKey, TranscriptStore } from '@/lib/mcp/transcript';

export type DispatchResult =
  | { ok: true; result: unknown; summary?: { heading: string; rows: ChangeRow[] }; cv?: { name: string; mediaType: string; data: Uint8Array } }
  | { ok: false; error: string }
  | { ok: false; needsConfirm: true; note: string; confirm: string };

export type CallerRef = { credentialId: string; userId: string };

/** How long a confirm token waits for the second call. */
export const CONFIRM_TTL_MS = 10 * 60 * 1000;

export const UNKNOWN_READ = 'There is no read operation by that name. List the operations to see what there is.';
export const UNKNOWN_CHANGE = 'There is no change operation by that name. List the operations to see what there is.';
export const CONFIRM_INVALID =
  'That confirm token is not valid for this change: it was already used, it is more than 10 minutes old, or it was ' +
  'given for another change, other arguments or another connection. Nothing was changed. Send the change again without ' +
  'a token to get a new one.';
export const FAILED =
  'The operation could not be completed because of a problem on the server. Check the workspace before trying it again.';

type Pending = { credentialId: string; userId: string; name: string; argsJson: string; toolCallId: string; note: string; bound?: Bound; expires: number };

/** Process-wide: token → the change it confirms. */
const pending = new Map<string, Pending>();

type Run = (input: unknown, options: unknown) => unknown;

const keyOf = (caller: CallerRef): TranscriptKey => `${caller.credentialId}:${caller.userId}`;

/** Parsed as the AI SDK would before a tool runs. The refusal names what is wrong, never the values sent. */
async function validate(op: Operation, args: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const schema = (op.tool as { inputSchema?: unknown }).inputSchema;
  if (!schema) return { ok: true, value: args };
  const check = asSchema(schema as Parameters<typeof asSchema>[0]).validate;
  if (!check) return { ok: true, value: args };
  const out = await check(args);
  if (out.success) return { ok: true, value: out.value };
  const issues = (out.error as { issues?: Array<{ path?: PropertyKey[]; message?: string }> }).issues;
  const words = Array.isArray(issues)
    ? issues.slice(0, 5).map((i) => `${(i.path ?? []).map(String).join('.') || '(input)'}: ${i.message ?? 'invalid'}`).join('; ')
    : 'they do not match the operation\'s input schema';
  return { ok: false, error: `The arguments are not valid for ${op.name}: ${words}. Nothing was run.` };
}

/** Every tool result in the transcript, for naming rows on the summary. */
function resultsIn(messages: readonly ModelMessage[]): ToolResult[] {
  return messages
    .filter((m) => m.role === 'tool' && Array.isArray(m.content))
    .flatMap((m) => m.content as Array<{ type?: unknown; toolName?: unknown; output?: { type?: unknown; value?: unknown } }>)
    .filter((part) => part.type === 'tool-result' && typeof part.toolName === 'string' && part.output?.type === 'json')
    .map((part) => ({ tool: part.toolName as string, output: part.output!.value }));
}

/**
 * Puts the text of the arguments into what the person said this turn, so a meeting link in them counts as given
 * by the person (Tuah's `linkNobodyGave` reads user messages since the last interview card). Only on this copy for
 * the gate: the stored transcript never holds it. The turn's opening message is the last user one; when there is
 * none, a synthetic one is put first.
 */
function withArgsAsSaid(messages: ModelMessage[], args: unknown): ModelMessage[] {
  const text = stringsIn(args).join('\n');
  if (!text) return messages;
  let at = -1;
  messages.forEach((m, i) => {
    if (m.role === 'user' && !isHeldCvMessage(m)) at = i;
  });
  if (at < 0) return [{ role: 'user', content: text }, ...messages];
  const opening = messages[at];
  const merged: ModelMessage =
    typeof opening.content === 'string'
      ? { role: 'user', content: `${opening.content}\n${text}` }
      : ({ role: 'user', content: [...(opening.content as object[]), { type: 'text', text }] } as ModelMessage);
  return [...messages.slice(0, at), merged, ...messages.slice(at + 1)];
}

function issueToken(entry: Omit<Pending, 'expires'>): string {
  const at = Date.now();
  for (const [token, held] of pending) if (held.expires <= at) pending.delete(token);
  const token = randomUUID();
  pending.set(token, { ...entry, expires: at + CONFIRM_TTL_MS });
  return token;
}

/** Takes the token (once, whatever the outcome) and returns its change when it is this one. */
function takeToken(token: string, credentialId: string, userId: string, name: string, argsJson: string): Pending | null {
  const held = pending.get(token);
  if (!held) return null;
  pending.delete(token);
  if (held.expires <= Date.now()) return null;
  if (held.credentialId !== credentialId || held.userId !== userId || held.name !== name || held.argsJson !== argsJson) return null;
  return held;
}

async function execute(op: Operation, input: unknown, options: object): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const run = (op.tool as { execute?: Run }).execute;
  if (!run) return { ok: false, error: FAILED };
  try {
    return { ok: true, result: await run.call(op.tool, input, options) };
  } catch {
    // The error may name a table, a path or a person: only the operation is logged.
    console.error(`[mcp] ${op.name} failed`);
    return { ok: false, error: FAILED };
  }
}

export async function runRead(ops: Operations, store: TranscriptStore, caller: CallerRef, name: string, args: unknown): Promise<DispatchResult> {
  const op = ops.byName.get(name);
  if (!op || op.kind !== 'read') return { ok: false, error: UNKNOWN_READ };
  const parsed = await validate(op, args);
  if (!parsed.ok) return parsed;
  const key = keyOf(caller);
  const toolCallId = `mcp_${randomUUID()}`;
  const shelved = ops.cvShelf?.length ?? 0;
  const ran = await execute(op, parsed.value, { toolCallId, messages: store.messages(key) });
  if (!ran.ok) return ran;
  store.recordCall(key, { toolCallId, toolName: name, input: parsed.value, output: ran.result });
  // A CV the read fetched goes back as a file, beside the result; never inside it.
  const held = ops.cvShelf && ops.cvShelf.length > shelved ? ops.cvShelf[ops.cvShelf.length - 1] : undefined;
  if (!held) return { ok: true, result: ran.result };
  return {
    ok: true,
    result: ran.result,
    cv: { name: `CV - ${held.candidate} - ${held.job}.pdf`, mediaType: 'application/pdf', data: held.bytes },
  };
}

export async function runChange(
  ops: Operations,
  store: TranscriptStore,
  caller: CallerRef,
  name: string,
  args: unknown,
  confirm?: string,
): Promise<DispatchResult> {
  const op = ops.byName.get(name);
  if (!op || op.kind !== 'write') return { ok: false, error: UNKNOWN_CHANGE };
  const parsed = await validate(op, args);
  if (!parsed.ok) return parsed;
  const input = parsed.value;
  const key = keyOf(caller);
  const argsJson = canonicalJson(args);

  // A token is checked first and used up whatever happens next. A bad one never turns into a new token.
  const confirming = confirm === undefined ? null : takeToken(confirm, caller.credentialId, caller.userId, name, argsJson);
  if (confirm !== undefined && !confirming) return { ok: false, error: CONFIRM_INVALID };
  const toolCallId = confirming?.toolCallId ?? `mcp_${randomUUID()}`;
  // The card the person was shown, as Tuah's conversation would hold it, so the gate's `cardShown` finds it.
  if (confirming) store.recordNote(key, { toolCallId, toolName: name, input, note: confirming.note });
  // Every way out that records no result ends the turn when a note was recorded, so the note never counts as a
  // change still shown to the person.
  const leave = (out: DispatchResult): DispatchResult => {
    if (confirming) store.endTurn(key);
    return out;
  };

  const gate = ops.gates?.[name];
  const messages = store.messages(key);
  let decided: Decision = 'user-approval';
  if (typeof gate === 'function') {
    try {
      decided = await gate(input, { toolCallId, messages: withArgsAsSaid(messages, args) });
    } catch {
      // As with a tool's own error: only the operation is logged.
      console.error(`[mcp] ${name} check failed`);
      return leave({ ok: false, error: FAILED });
    }
  }
  if (typeof decided === 'object' && decided.type === 'denied') return leave({ ok: false, error: decided.reason });
  const note = typeof decided === 'object' ? decided.reason : undefined;
  // A note the person has not seen (none yet, or not the one their token was given for) goes back to them first.
  if (note && note !== confirming?.note) {
    const bound = typeof decided === 'object' ? decided.bound : undefined;
    const token = issueToken({ credentialId: caller.credentialId, userId: caller.userId, name, argsJson, toolCallId, note, ...(bound ? { bound } : {}) });
    return leave({ ok: false, needsConfirm: true, note, confirm: token });
  }
  // What was bound when the note was shown, as `bindApprovals` keeps it on the proposal; else what the gate bound now.
  const bound = confirming ? confirming.bound : typeof decided === 'object' ? decided.bound : undefined;

  const ran = await execute(op, input, { toolCallId, messages, ...(bound ? { bound } : {}) });
  if (!ran.ok) return leave(ran);
  store.recordCall(key, { toolCallId, toolName: name, input, output: ran.result });
  store.endTurn(key);
  const succeeded = (ran.result as { ok?: unknown } | null)?.ok;
  if (op.product === 'finance' && succeeded) revalidateFinance(name);
  const results = resultsIn(messages);
  return {
    ok: true,
    result: ran.result,
    ...(succeeded === false ? {} : { summary: { heading: changeHeading(name), rows: changeRows(name, input, nameIn(results), rowIn(results)) } }),
  };
}
