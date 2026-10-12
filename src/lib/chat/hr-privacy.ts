/**
 * Keeping HR out of Tuah's shared surfaces.
 *
 * Ask-Lekiu (`/api/people/chat`) saves nothing, because HR answers carry pay,
 * NRIC, bank and medical detail. When Tuah can reach HR too, a Tuah turn that
 * touched HR must be held to the same standard: it is never written to chat
 * history, and it is never passed to the other specialists as background. These
 * helpers spot such a turn from its message parts.
 */

import { ALL_PEOPLE_TOOL_NAMES } from '@/lib/ai/products';
import { APPLY_TOOL, type Proposal } from '@/lib/chat/delegation';

/** Tuah's delegation tool for HR; in team mode the HR tools themselves run inside the sub-agent. */
const ASK_LEKIU = 'askLekiu';

type PartLike = { type?: unknown; input?: unknown };
type Proposals = ReadonlyMap<string, Proposal>;

/**
 * An `applyChange` whose proposal is an HR change. This catches the case the
 * tool name alone misses: Tuah applying a Lekiu-prepared change from an earlier
 * turn, when the message has no `askLekiu` of its own.
 */
function isPeopleApply(part: PartLike, proposals?: Proposals): boolean {
  if (part?.type !== `tool-${APPLY_TOOL}` || !proposals) return false;
  const id = (part.input as { proposalId?: unknown } | null)?.proposalId;
  const proposal = typeof id === 'string' ? proposals.get(id) : undefined;
  return proposal?.product === 'people';
}

/**
 * True when a message's parts show HR was used: `askLekiu` in team mode, an HR
 * tool directly in single-agent mode, or an `applyChange` on an HR proposal
 * (pass `proposals` from `proposalsIn` to catch a cross-turn apply). A part's
 * type is `tool-<name>`.
 */
export function touchedPeople(parts: readonly unknown[], proposals?: Proposals): boolean {
  for (const part of parts as PartLike[]) {
    const type = part?.type;
    if (typeof type === 'string' && type.startsWith('tool-')) {
      const name = type.slice('tool-'.length);
      if (name === ASK_LEKIU || ALL_PEOPLE_TOOL_NAMES.has(name)) return true;
    }
    if (isPeopleApply(part, proposals)) return true;
  }
  return false;
}

/**
 * Drops every HR turn from a list of messages: the assistant message that used
 * HR, and the user message that prompted it, so neither its question nor its
 * answer reaches the shared transcript. Pass `proposals` so a cross-turn HR
 * apply is recognised too.
 */
export function withoutPeopleTurns<T extends { role: string; parts: readonly unknown[] }>(
  messages: readonly T[],
  proposals?: Proposals,
): T[] {
  const drop = new Set<number>();
  messages.forEach((message, i) => {
    if (message.role === 'user' || !touchedPeople(message.parts, proposals)) return;
    drop.add(i);
    for (let j = i - 1; j >= 0; j--) {
      if (messages[j].role === 'user') {
        drop.add(j);
        break;
      }
    }
  });
  return messages.filter((_, i) => !drop.has(i));
}
