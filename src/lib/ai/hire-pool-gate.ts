// src/lib/ai/hire-pool-gate.ts
/**
 * The rules that hold a talent pool change back whoever prepares it: one a
 * turn, only for an id a lookup really returned, never from a lookup that said
 * its name fits more than one person, and no move to the pipeline for someone
 * who is not in the pool. A prompt rule alone was not enough for the first
 * three, so all are checked in code: here for an agent that holds the tools
 * itself, and in specialists.ts for Tuah's team.
 *
 * Two people with one name are handled exactly as for a deletion, with that
 * file's own code (hire-deletions.ts): the person is read on the server by id,
 * and when someone else has the name the Approve card is given a line that says
 * which of them it is about. Only two rows that would give the same line are
 * refused. That line can hold an email: it travels on the approval request,
 * which goes to the browser and is left out of what any model is sent.
 *
 * Every sentence here begins as one of the starts in hire-deletions.ts
 * (`GATE_REASON_STARTS`): that is how a call this gate denied is told from one
 * the user rejected, when the turn is read back.
 */
import type { ModelMessage } from 'ai';
import {
  NAMESAKE_APPEARED, ambiguousLookup, cardCheck, cardDecision, cardShown, deniedHere, partsOf, thisTurn,
  type CardCheck, type Decision, type DeletionGate,
} from '@/lib/ai/hire-deletions';
import { nameIn, type ItemKind } from '@/lib/chat/change-titles';
import { namesakesFromLists } from '@/lib/hire/namesakes';
import type { HireData } from '@/lib/hire/types';

export const HIRE_POOL_TOOL_NAMES = ['setPoolStatus', 'moveToPipeline'] as const;

// Each refusal leaves the person another way. It is said beside the sentence, and where the person reads it.

/** The other way: ask for the next one once the card is answered (the next message is a new turn), or use the Talent Pool screen. */
export const ONE_POOL_CHANGE = 'One talent pool change at a time. One is already prepared for approval.';
/** The other way: say which person is meant; the assistant asks. */
export const AMBIGUOUS_POOL_CHANGE =
  // No "look it up again": a later lookup cannot clear this in the same turn, and a model told to try would loop.
  'More than one match was found for that name, so no talent pool change was prepared. Stop here: say who matches and ask the user which one they mean. ' +
  'Once the user has said who, they can ask for the change again.';

/** The refusal for an id that no lookup returned as a candidate. It tells the model which lookups to use; the person need do nothing. */
export const poolNotLookedUp = (id: unknown) =>
  `You have not looked up ${String(id)} as a candidate. Never guess an id: use listCandidates or listTalentPool ` +
  'to find the candidate and get its real id, then prepare the change again.';
/** The same for a move's job. The words are the ones an add-candidate with an unknown job is refused with. */
export const jobNotLookedUp = (id: unknown) =>
  `You have not looked up ${String(id)} as a job. Never guess an id: use listJobs ` +
  'to find the job and get its real id, then prepare the change again.';

/** The other way: add them to the pool first (the model is told to offer it), or add them to the job from the Candidates board. */
export const NOT_IN_POOL_MOVE =
  'This candidate is not in the talent pool, so no move to the pipeline was prepared. Say so, and offer to add them to the talent pool first.';
/**
 * The other way is in the sentence, and is the whole of it: the Talent Pool screen, where each member's row has its
 * own status menu, "Move to pipeline" and "Remove from pool", and "Add to Pool" lists each person on file who is not
 * in it; and the Candidates board, for someone with an application. Nothing here counts on "Edit candidate" to make
 * two such people tell apart: it is offered on the board and in the Applications panel only, so a pool member with
 * no application cannot be reached by it.
 */
export const lookTheSameInPool = (name: string) =>
  `Two candidates called ${name} look the same from here, so I cannot tell them apart. Nothing was changed. ` +
  'Change the right one from the Talent Pool screen or the Candidates board.';
/** The other way: try again; the screens do not depend on this read. */
export const POOL_CHECK_FAILED = 'I could not check this candidate just now, so no talent pool change was prepared. Try again in a moment.';
/** The other way: ask again; the new card says which one it is. */
export const POOL_NAMESAKE_APPEARED =
  'A candidate with the same name appeared after this was shown for approval, so a last check stopped it. Nothing was changed. ' +
  'Prepare it again: the card will then say which one it is.';

const isPoolChange = (name: unknown): boolean =>
  typeof name === 'string' && (HIRE_POOL_TOOL_NAMES as readonly string[]).includes(name);

/**
 * Why a pool change an agent has just called must not become a card, or null.
 * `messages` is the conversation as the agent has it; the call itself may or
 * may not be in it yet, so it is told apart by its id.
 */
export function poolChangeProblem(
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
          isPoolChange(part.toolName) &&
          // Itself: the same call id for the same person.
          !(part.toolCallId === call.toolCallId && (part.input as { id?: unknown } | null | undefined)?.id === call.id) &&
          !denied.has(part.toolCallId),
      ),
  );
  if (another) return ONE_POOL_CHANGE;
  const lookups = turn
    .filter((message) => message.role === 'tool')
    .flatMap(partsOf)
    .filter((part) => part.type === 'tool-result');
  return ambiguousLookup(lookups, call.id) ? AMBIGUOUS_POOL_CHANGE : null;
}

/**
 * True when a lookup anywhere in the conversation returned this id as this
 * kind of thing. The whole conversation, not the turn: "mark the one you
 * listed" must work. A real id comes only from a lookup's result, so one typed
 * by the user, made up, or seen only as another kind of row does not pass.
 */
export function lookedUpAs(messages: readonly ModelMessage[], kind: ItemKind, id: unknown): boolean {
  if (typeof id !== 'string' || !id) return false;
  const results = messages
    .filter((message) => message.role === 'tool')
    .flatMap(partsOf)
    .filter((part) => part.type === 'tool-result' && typeof part.toolName === 'string')
    .map((part) => {
      const output = part.output as { type?: unknown; value?: unknown } | null | undefined;
      return { tool: part.toolName as string, output: output?.type === 'json' ? output.value : null };
    });
  return nameIn(results)(id, kind) !== null;
}

/** Asks the server about a pool change's person. The same answer as a deletion's check. Never throws. */
export type PoolCheck = (tool: string, id: unknown) => Promise<CardCheck>;

export function poolCheckFor(data: Pick<HireData, 'listCandidates' | 'namesakes' | 'poolStatusOf'>): PoolCheck {
  return async (tool, id) => {
    try {
      if (tool === 'moveToPipeline') {
        // A provider over a database reads the one row. One that holds every row (the sample data) is asked for its list.
        const status = data.poolStatusOf
          ? await data.poolStatusOf(id)
          : ((await data.listCandidates()).find((c) => c.id === id)?.pool_status ?? null);
        // Refused here, before any card: the database would refuse it only after the user had approved. A person who is not there is left to the database to report.
        if (status === 'none') return { ok: false, refusal: NOT_IN_POOL_MOVE };
      }
      const found = data.namesakes
        ? await data.namesakes('candidate', id)
        : namesakesFromLists('candidate', id, await data.listCandidates(), []);
      const check = cardCheck(found);
      // The deletion's rule as it is; only the words of its one refusal are the pool's own.
      return check.ok ? check : { ok: false, refusal: lookTheSameInPool(found.target?.name.trim() ?? '') };
    } catch {
      // Nothing of the error is logged: its words can hold a name or an email.
      console.error('[lekir] the check before a talent pool change could not read the rows');
      return { ok: false, refusal: POOL_CHECK_FAILED };
    }
  };
}

/**
 * The gate's answer once nothing else refused the call: 3c's decision (a card, with the identifying line as the
 * request's reason when the name is shared), with the pool's own words when a namesake appeared after the card.
 */
export function poolCardDecision(check: CardCheck, shown: { note: string | null } | null): Decision {
  const decision = cardDecision(check, shown);
  return typeof decision === 'object' && decision.type === 'denied' && decision.reason === NAMESAKE_APPEARED
    ? { type: 'denied', reason: POOL_NAMESAKE_APPEARED }
    : decision;
}

/**
 * An agent's approval map with the two pool tools gated: the first pool change
 * of a request goes to the user as a card, and any other is denied before a
 * card exists. Built once per request, so the count starts at zero each time;
 * a pool change earlier in the same turn is found in the messages. Whatever
 * the map already holds for another tool (a deletion's gate) is kept as it is:
 * the two limits are counted apart.
 *
 * The SDK calls a gate once per call, in the order the model made them, and
 * once more for a call the user approved, at the start of the request that
 * carries their answer: that call is let through again and is then that
 * request's one.
 */
export function guardPoolChanges(
  approval: Record<string, 'user-approval' | DeletionGate> | undefined,
  /** The server read: is a move's person in the pool, and does anyone share the name. Asked last, and only for a call nothing else refused. */
  check?: PoolCheck,
): Record<string, 'user-approval' | DeletionGate> | undefined {
  if (!approval) return undefined;
  const names = HIRE_POOL_TOOL_NAMES.filter((name) => name in approval);
  if (names.length === 0) return approval;
  let asked = 0;
  // One gate per tool, because the SDK does not say which tool it is asking about; one count between them.
  const gateFor = (tool: string): DeletionGate => async (input, { toolCallId, messages }) => {
    const { id, job_id: jobId } = (input ?? {}) as { id?: unknown; job_id?: unknown };
    // In this order: one a turn, then ids that were really looked up, then a lookup that was not ambiguous.
    const inTurn = asked > 0 ? ONE_POOL_CHANGE : poolChangeProblem(messages, { toolCallId, id });
    const problem =
      inTurn === ONE_POOL_CHANGE
        ? inTurn
        : ((lookedUpAs(messages, 'candidate', id) ? null : poolNotLookedUp(id))
          ?? (tool === 'moveToPipeline' && !lookedUpAs(messages, 'job', jobId) ? jobNotLookedUp(jobId) : null)
          ?? inTurn);
    if (problem) return { type: 'denied', reason: problem };
    // The SDK waits for each call's answer before asking about the next, so the count is safe across this read.
    const decision = check ? poolCardDecision(await check(tool, id), cardShown(messages, toolCallId)) : 'user-approval';
    if (typeof decision === 'object' && decision.type === 'denied') return decision;
    asked += 1;
    return decision;
  };
  return { ...approval, ...Object.fromEntries(names.map((name) => [name, gateFor(name)])) };
}
