// src/lib/ai/hire-deletions.ts
/**
 * The two rules that hold a deletion back whoever prepares it: one deletion a
 * turn, and never from a lookup that said its name fits more than one row. A
 * prompt rule alone was not enough for either, so both are checked in code:
 * here for an agent that holds the tools itself, and in specialists.ts for
 * Tuah's team. No model, no database.
 */
import type { ModelMessage } from 'ai';
import { isHeldCvMessage } from '@/lib/ai/hire-tools';

export const HIRE_DELETE_TOOL_NAMES = ['deleteApplication', 'deleteCandidate'] as const;

export const ONE_DELETION = 'One deletion at a time. One is already prepared for approval.';
export const AMBIGUOUS_DELETION =
  // No "look it up again": a later lookup cannot clear this in the same turn, and a model told to try would loop.
  'More than one match was found for that name, so no deletion was prepared. Stop here: say who matches and ask the user which one they mean. ' +
  'Once the user has said who, they can ask for the deletion again.';

const isDeletion = (name: unknown): boolean =>
  typeof name === 'string' && (HIRE_DELETE_TOOL_NAMES as readonly string[]).includes(name);

/** True when a lookup result that holds this id also says its name matched several rows. */
export function ambiguousLookup(outputs: unknown[], id: unknown): boolean {
  if (typeof id !== 'string' || !id) return false;
  return outputs.some((output) => {
    let written: string;
    try {
      written = JSON.stringify(output) ?? '';
    } catch {
      return false;
    }
    return written.includes('"several_match"') && written.includes(id);
  });
}

/** Team mode: nothing else prepared in this delegation, and no deletion prepared earlier in this turn. */
export function oneDeletionRefusal(preparedHere: number, deletionsThisTurn: number): string | null {
  return preparedHere > 0 || deletionsThisTurn > 0 ? ONE_DELETION : null;
}

type Part = { type?: unknown; toolName?: unknown; toolCallId?: unknown; input?: unknown; output?: unknown };
const partsOf = (message: ModelMessage): Part[] =>
  Array.isArray(message.content) ? (message.content as unknown as Part[]) : [];

/**
 * The turn in progress: everything after the last thing the user said. A CV
 * the assistant fetched also sits in a user message (see `withHeldCvs`), in
 * the middle of a turn: that one is not the user speaking.
 */
function thisTurn(messages: readonly ModelMessage[]): ModelMessage[] {
  let from = 0;
  messages.forEach((message, index) => {
    if (message.role === 'user' && !isHeldCvMessage(message)) from = index + 1;
  });
  return messages.slice(from);
}

/**
 * The calls in these messages that the gate below denied itself, by call id.
 * Such a call never became a card, so it is not the turn's one deletion: the
 * SDK asks the gate about an approved call again in the request that carries
 * the user's answer, and the denied call beside it is then in the messages.
 * Known by its reason, which is all that comes back in every form: in the same
 * request as `execution-denied`, from the browser as `error-text`.
 */
function deniedHere(turn: readonly ModelMessage[]): Set<unknown> {
  const ids = new Set<unknown>();
  for (const message of turn) {
    if (message.role !== 'tool') continue;
    for (const part of partsOf(message)) {
      if (part.type !== 'tool-result') continue;
      const output = part.output as { type?: unknown; reason?: unknown; value?: unknown } | null | undefined;
      const reason =
        output?.type === 'execution-denied' ? output.reason : output?.type === 'error-text' ? output.value : undefined;
      if (reason === ONE_DELETION || reason === AMBIGUOUS_DELETION) ids.add(part.toolCallId);
    }
  }
  return ids;
}

/**
 * Why a deletion an agent has just called must not become a card, or null.
 * `messages` is the conversation as the agent has it; the call itself may or
 * may not be in it yet, so it is told apart by its id.
 */
export function deletionProblem(
  messages: readonly ModelMessage[],
  call: { toolCallId: string; id: unknown },
): string | null {
  const turn = thisTurn(messages);
  const denied = deniedHere(turn);
  const another = turn.some(
    (message) =>
      message.role === 'assistant' &&
      partsOf(message).some(
        (part) =>
          part.type === 'tool-call' &&
          isDeletion(part.toolName) &&
          // Itself: the same call id for the same row. A provider that reused a call id for another row would not pass.
          !(part.toolCallId === call.toolCallId && (part.input as { id?: unknown } | null | undefined)?.id === call.id) &&
          !denied.has(part.toolCallId),
      ),
  );
  if (another) return ONE_DELETION;
  const lookups = turn
    .filter((message) => message.role === 'tool')
    .flatMap(partsOf)
    .filter((part) => part.type === 'tool-result');
  return ambiguousLookup(lookups, call.id) ? AMBIGUOUS_DELETION : null;
}

type Decision = 'user-approval' | { type: 'denied'; reason: string };
/** The approval function both delete tools share (the SDK's per-tool approval function). */
export type DeletionGate = (input: unknown, options: { toolCallId: string; messages: ModelMessage[] }) => Decision;

/**
 * An agent's approval map with the two delete tools gated: the first deletion
 * of a request goes to the user as a card, and any other is denied before a
 * card exists. Built once per request, so the count starts at zero each time;
 * a deletion earlier in the same turn is found in the messages.
 *
 * The SDK calls the gate once per call, one after the other in the order the
 * model made them, with the messages that led to the step (the step's own
 * calls are not among them, hence the count). It calls it once more for a call
 * the user approved, at the start of the request that carries their answer:
 * that call is let through again and is then that request's one.
 */
export function guardDeletions(
  approval: Record<string, 'user-approval'> | undefined,
): Record<string, 'user-approval' | DeletionGate> | undefined {
  if (!approval) return undefined;
  const names = HIRE_DELETE_TOOL_NAMES.filter((name) => name in approval);
  if (names.length === 0) return approval;
  let asked = 0;
  const gate: DeletionGate = (input, { toolCallId, messages }) => {
    const id = (input as { id?: unknown } | null)?.id;
    const problem = asked > 0 ? ONE_DELETION : deletionProblem(messages, { toolCallId, id });
    if (problem) return { type: 'denied', reason: problem };
    asked += 1;
    return 'user-approval';
  };
  return { ...approval, ...Object.fromEntries(names.map((name) => [name, gate])) };
}
