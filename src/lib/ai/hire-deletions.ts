// src/lib/ai/hire-deletions.ts
/**
 * The two rules that hold a deletion back whoever prepares it: one deletion a
 * turn, and never from a lookup that said its name fits more than one row. A
 * prompt rule alone was not enough for either, so both are checked in code:
 * here for an agent that holds the tools itself, and in specialists.ts for
 * Tuah's team. A third thing is decided here too: what an approval card must say when two rows share a name.
 */
import type { ModelMessage } from 'ai';
import { isHeldCvMessage } from '@/lib/ai/hire-tools';
import { nameIn, withoutPoolSide } from '@/lib/chat/change-titles';
import { fullDate } from '@/lib/hire/lists';
import { namesakesFromLists, sameText } from '@/lib/hire/namesakes';
import type { HireData, Namesake, Namesakes } from '@/lib/hire/types';

export const HIRE_DELETE_TOOL_NAMES = ['deleteApplication', 'deleteCandidate'] as const;

export const ONE_DELETION = 'One deletion at a time. One is already prepared for approval.';
export const AMBIGUOUS_DELETION =
  // No "look it up again": a later lookup cannot clear this in the same turn, and a model told to try would loop.
  'More than one match was found for that name, so no deletion was prepared. Stop here: say who matches and ask the user which one they mean. ' +
  'Once the user has said who, they can ask for the deletion again.';

/** What each delete tool removes. */
export type DeletionKind = 'application' | 'candidate';
export const kindOfDeletion = (tool: string): DeletionKind => (tool === 'deleteApplication' ? 'application' : 'candidate');

/** The refusal for an id that no lookup returned as this kind of thing. It tells the model which lookup to use. */
export function notLookedUp(kind: DeletionKind, id: unknown): string {
  return kind === 'application'
    ? `You have not looked up ${String(id)} as an application. Never guess an id: use listApplications ` +
        'to find the application and get its real id, then prepare the change again.'
    : `You have not looked up ${String(id)} as a candidate. Never guess an id: use listCandidates ` +
        'to find the candidate and get its real id, then prepare the change again.';
}

/**
 * True for a reason one of the checks in this file gave. A call denied with one
 * never became a card. Some reasons carry a name or an id, so they are known by
 * how they begin; a reason kept with a stored chat is cut at 500 characters,
 * which leaves every beginning whole.
 */
const GATE_REASON_STARTS = [
  'One deletion at a time.',
  'More than one match was found',
  'You have not looked up ',
  'Two candidates called ',
  'Two applications from someone called ',
  'I could not check ',
  'Someone else with the same name appeared ',
  // The talent pool's gate (hire-pool-gate.ts). Its other sentences begin as the ones above do, on purpose.
  'One talent pool change at a time.',
  'This candidate is not in the talent pool',
  'A candidate with the same name appeared ',
  // Not a rule of this file: the change could not be recorded for approval (see proposal-store.ts). No card either.
  'Changes cannot be prepared right now',
];
export function isGateReason(reason: unknown): boolean {
  return typeof reason === 'string' && GATE_REASON_STARTS.some((start) => reason.startsWith(start));
}

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

export type MessagePart = { type?: unknown; toolName?: unknown; toolCallId?: unknown; input?: unknown; output?: unknown };
type Part = MessagePart;
export const partsOf = (message: ModelMessage): Part[] =>
  Array.isArray(message.content) ? (message.content as unknown as Part[]) : [];

/**
 * The turn in progress: everything after the last thing the user said. A CV
 * the assistant fetched also sits in a user message (see `withHeldCvs`), in
 * the middle of a turn: that one is not the user speaking.
 */
export function thisTurn(messages: readonly ModelMessage[]): ModelMessage[] {
  let from = 0;
  messages.forEach((message, index) => {
    if (message.role === 'user' && !isHeldCvMessage(message)) from = index + 1;
  });
  return messages.slice(from);
}

/** What the SDK writes as the result of a denied call whose answer carried no reason. With a reason, it writes the reason. */
const DENIED_WITHOUT_REASON = 'Tool call execution denied.';

/**
 * The calls in these messages that the user approved and a gate's last check then stopped, by call id. Such a call
 * never ran. The SDK asks a gate again about an approved call when the user's yes arrives; when the gate then says
 * no, the browser is told only that the call was denied, and it keeps the user's yes on the part. So on the next
 * request the call reads: a card of its own (not an automatic one), the user's answer to that card with
 * `approved: true`, and a result that is a denial. Three other things look near it and are not it:
 * - the user said no: the answer says `approved: false`;
 * - the change ran: its result is the change's own output, not a denial;
 * - a gate refused it before any card: its card is an automatic one, which no user answered.
 *
 * All three parts are parts of the conversation's structure, written by the SDK from the tool part's state. Text
 * cannot make one: a name, a CV, a cover letter or a message from the user is only ever a string inside a part.
 *
 * What a denial reads as, from the browser: the SDK writes the result of a denied call as the reason on the user's
 * answer, or as its own words when the answer has none (`convertToModelMessages`, the `output-denied` case). The
 * chat sends no reason with a yes today, but this does not count on that: the result is compared with whatever the
 * answer itself says. A change that ran and threw has an error text of its own, which is neither.
 */
export function stoppedAfterApproval(turn: readonly ModelMessage[]): Set<unknown> {
  const cardOf = new Map<unknown, unknown>();
  /** Each approved call, with what the SDK writes as its result if it was then denied. */
  const approved = new Map<unknown, unknown>();
  const ids = new Set<unknown>();
  type Wide = MessagePart & { approvalId?: unknown; approved?: unknown; isAutomatic?: unknown; reason?: unknown };
  for (const message of turn) {
    for (const part of partsOf(message) as Wide[]) {
      if (message.role === 'assistant' && part.type === 'tool-approval-request' && part.isAutomatic !== true) {
        cardOf.set(part.approvalId, part.toolCallId);
      } else if (message.role === 'tool' && part.type === 'tool-approval-response' && part.approved === true && cardOf.has(part.approvalId)) {
        approved.set(cardOf.get(part.approvalId), part.reason ?? DENIED_WITHOUT_REASON);
      } else if (message.role === 'tool' && part.type === 'tool-result' && approved.has(part.toolCallId)) {
        const output = part.output as { type?: unknown; reason?: unknown; value?: unknown } | null | undefined;
        // In the request that stopped it the result is a denial outright: the user had said yes, so only a gate
        // can have denied it. From the browser it is an error whose text is the answer's reason, or the SDK's words.
        const denial =
          output?.type === 'execution-denied' || (output?.type === 'error-text' && output.value === approved.get(part.toolCallId));
        if (denial) ids.add(part.toolCallId);
      }
    }
  }
  return ids;
}

/**
 * The calls in these messages that the gate below denied itself, by call id.
 * Such a call never became a card, so it is not the turn's one deletion: the
 * SDK asks the gate about an approved call again in the request that carries
 * the user's answer, and the denied call beside it is then in the messages.
 * Known by its reason, which is all that comes back in every form: in the same
 * request as `execution-denied`, from the browser as `error-text`.
 */
export function deniedHere(turn: readonly ModelMessage[]): Set<unknown> {
  // A call stopped after the user's yes is over too: it never ran, and what replaces it must be able to reach a card.
  const ids = stoppedAfterApproval(turn);
  for (const message of turn) {
    if (message.role !== 'tool') continue;
    for (const part of partsOf(message)) {
      if (part.type !== 'tool-result') continue;
      const output = part.output as { type?: unknown; reason?: unknown; value?: unknown } | null | undefined;
      const reason =
        output?.type === 'execution-denied' ? output.reason : output?.type === 'error-text' ? output.value : undefined;
      if (isGateReason(reason)) ids.add(part.toolCallId);
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

/**
 * True when a lookup anywhere in the conversation returned this id as this
 * kind of thing. The whole conversation, not the turn: "delete the one you
 * listed" must work. A real id comes only from a lookup's result, so one typed
 * by the user, made up, or seen only as another kind of row does not pass. A
 * chat opened again whose listing was too long to keep needs a new lookup.
 */
export function lookedUp(messages: readonly ModelMessage[], kind: DeletionKind, id: unknown): boolean {
  if (typeof id !== 'string' || !id) return false;
  const results = messages
    .filter((message) => message.role === 'tool')
    .flatMap(partsOf)
    .filter((part) => part.type === 'tool-result' && typeof part.toolName === 'string')
    .map((part) => {
      const output = part.output as { type?: unknown; value?: unknown } | null | undefined;
      return { tool: part.toolName as string, output: output?.type === 'json' ? output.value : null };
    });
  // A candidate to delete must have come from a lookup of everyone on file. The pool lookup sees pool members only:
  // by a first name it can find one person when two on file have that name, and so never asks "which one?".
  // The other way for the person: the Talent Pool row's own "Delete candidate", or ask again, and the assistant
  // looks the candidate up with listCandidates first (the refusal sends it there).
  return nameIn(kind === 'candidate' ? withoutPoolSide(results) : results)(id, kind) !== null;
}

/*
 * Two rows with one name. A card names a person (and, for an application, the job); when another row shares that,
 * the card alone could not show a wrong id. So when a deletion is asked for, the row and its namesakes are read on
 * the server by the row's id (never from what the model looked up or passed in), and the card is given one more
 * line that says which of them this is. Only when that line would be the same for two of them is the deletion
 * refused. The line can hold an email: it travels on the approval request, which goes to the browser and is left
 * out of what any model is sent, and it is never logged or put in a tool's result.
 */
export const sharedNameCandidate = (name: string, line: string) =>
  `More than one candidate is called ${name}. This one: ${line}.`;
export const sharedNameApplication = (name: string, job: string, line: string) =>
  `More than one application is from someone called ${name} for ${job}. This one: ${line}.`;
export const lookTheSameCandidates = (name: string) =>
  `Two candidates called ${name} look the same from here, so I cannot tell them apart. Nothing was deleted.`;
export const lookTheSameApplications = (name: string, job: string) =>
  `Two applications from someone called ${name} for ${job} look the same from here, so I cannot tell them apart. Nothing was deleted.`;
export const DELETION_CHECK_FAILED =
  'I could not check whether someone else has the same name just now, so no deletion was prepared. Try again in a moment.';
/** A namesake turned up between the card and the user's yes, and the card they saw did not say which one it was. */
export const NAMESAKE_APPEARED =
  'Someone else with the same name appeared after this was shown for approval, so a last check stopped it. Nothing was deleted. ' +
  'Prepare it again: the card will then say which one it is.';

/**
 * What tells one row from its namesakes: the email when there is one, else the location and the headline that
 * exist, and always the day it was added (for an application, made), in Kuala Lumpur.
 */
export function identifyingLine(row: Namesake): string {
  const details = row.email?.trim() ? [row.email.trim()] : [row.location, row.headline].map((v) => v?.trim()).filter(Boolean);
  const when = `${row.job === null ? 'added' : 'applied'} ${fullDate(row.added_at)}`;
  return details.length > 0 ? `${details.join(' · ')} · ${when}` : when.charAt(0).toUpperCase() + when.slice(1);
}

/** What the server found about a deletion's row, for whatever shows its card. */
export type CardCheck =
  | { ok: false; refusal: string }
  /** `note` is the line the card must carry, or null when nobody shares the name. `namesakes` are the rows that do. */
  | { ok: true; note: string | null; namesakes: Namesake[] };

/** Decides from the row and its namesakes. A row that is not there is left to the database to report. */
export function cardCheck(found: Namesakes): CardCheck {
  const { target, others, cut } = found;
  if (!target || (others.length === 0 && !cut)) return { ok: true, note: null, namesakes: [] };
  const name = target.name.trim();
  const line = identifyingLine(target);
  // More namesakes than were read: one of the unread could look the same, so nothing can be promised.
  const alike = cut || others.some((other) => sameText(identifyingLine(other)) === sameText(line));
  if (alike) {
    return { ok: false, refusal: target.job === null ? lookTheSameCandidates(name) : lookTheSameApplications(name, target.job.trim()) };
  }
  return {
    ok: true,
    note: target.job === null ? sharedNameCandidate(name, line) : sharedNameApplication(name, target.job.trim(), line),
    namesakes: others,
  };
}

/** Asks the server about a deletion's row. Never throws. */
export type DeletionCheck = (tool: string, id: unknown) => Promise<CardCheck>;

export function deletionCheckFor(data: Pick<HireData, 'listCandidates' | 'listApplications' | 'namesakes'>): DeletionCheck {
  return async (tool, id) => {
    const kind = kindOfDeletion(tool);
    try {
      // A provider over a database reads by id and by name. One that holds every row (the sample data) is asked for its lists.
      const found = data.namesakes
        ? await data.namesakes(kind, id)
        : namesakesFromLists(kind, id, await data.listCandidates(), await data.listApplications());
      return cardCheck(found);
    } catch {
      // Nothing of the error is logged: its words can hold a name.
      console.error('[lekir] the same-name check before a deletion could not read the rows');
      return { ok: false, refusal: DELETION_CHECK_FAILED };
    }
  };
}

/**
 * The approval request already made for this call in this turn, if any: the SDK is then asking a second time,
 * because the user approved. `note` is the line that card carried.
 */
export function cardShown(messages: readonly ModelMessage[], toolCallId: string): { note: string | null } | null {
  const turn = thisTurn(messages);
  // A call that already has its result is over: a new call under the same id is a new call, with no card yet.
  const answered = turn.some(
    (message) => message.role === 'tool' && partsOf(message).some((part) => part.type === 'tool-result' && part.toolCallId === toolCallId),
  );
  if (answered) return null;
  for (const message of turn) {
    if (message.role !== 'assistant') continue;
    for (const part of partsOf(message) as (Part & { reason?: unknown; isAutomatic?: unknown })[]) {
      if (part.type === 'tool-approval-request' && part.toolCallId === toolCallId && part.isAutomatic !== true) {
        return { note: typeof part.reason === 'string' && part.reason ? part.reason : null };
      }
    }
  }
  return null;
}

/**
 * The gate's answer once nothing else refused the call: a card, with the identifying line when the name is shared.
 * When the user has already approved a card that had no such line and a namesake has turned up since, it is stopped.
 */
export function cardDecision(check: CardCheck, shown: { note: string | null } | null): Decision {
  if (!check.ok) return { type: 'denied', reason: check.refusal };
  if (shown && check.note && !shown.note) return { type: 'denied', reason: NAMESAKE_APPEARED };
  return check.note ? { type: 'user-approval', reason: check.note } : 'user-approval';
}

export type Decision = 'user-approval' | { type: 'user-approval'; reason: string } | { type: 'denied'; reason: string };
/** The approval function both delete tools share (the SDK's per-tool approval function). */
export type DeletionGate = (
  input: unknown,
  options: { toolCallId: string; messages: ModelMessage[] },
) => Decision | Promise<Decision>;

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
  approval: Record<string, 'user-approval' | DeletionGate> | undefined,
  /** The server read that says whether another row shares the name. Asked last, and only for a call nothing else refused. */
  check?: DeletionCheck,
): Record<string, 'user-approval' | DeletionGate> | undefined {
  if (!approval) return undefined;
  const names = HIRE_DELETE_TOOL_NAMES.filter((name) => name in approval);
  if (names.length === 0) return approval;
  let asked = 0;
  // One gate per tool, because the SDK does not say which tool it is asking about; one count between them.
  const gateFor = (tool: string): DeletionGate => async (input, { toolCallId, messages }) => {
    const id = (input as { id?: unknown } | null)?.id;
    const kind = kindOfDeletion(tool);
    // In this order: one a turn, then an id that was really looked up, then a lookup that was not ambiguous.
    const inTurn = asked > 0 ? ONE_DELETION : deletionProblem(messages, { toolCallId, id });
    const problem =
      inTurn === ONE_DELETION ? inTurn : ((lookedUp(messages, kind, id) ? null : notLookedUp(kind, id)) ?? inTurn);
    if (problem) return { type: 'denied', reason: problem };
    // The SDK waits for each call's answer before asking about the next, so the count is safe across this read.
    const decision = check ? cardDecision(await check(tool, id), cardShown(messages, toolCallId)) : 'user-approval';
    if (typeof decision === 'object' && decision.type === 'denied') return decision;
    asked += 1;
    return decision;
  };
  return { ...approval, ...Object.fromEntries(names.map((name) => [name, gateFor(name)])) };
}
