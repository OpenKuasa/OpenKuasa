/**
 * What Tuah's specialists hand back. Tuah asks a specialist (Jebat, Kasturi)
 * to look things up or to prepare a change; the specialist's work travels in
 * the chat message as the result of that request, so the chat can show its
 * progress and a later turn can find a change that was prepared.
 */

import { collectNames, type KnownNames } from '@/lib/chat/change-titles';

/** The request tools Tuah has, one per specialist: `askJebat`, `askKasturi`. */
export const ASK_PREFIX = 'ask';
/** The one tool that carries out a prepared change, behind an approval. */
export const APPLY_TOOL = 'applyChange';

/** One lookup a specialist ran, or one change it prepared. */
export type AgentStep = { tool: string; done: boolean };

/** A change a specialist prepared. Nothing is saved until the user approves it. */
export type Proposal = {
  id: string;
  /** The product the change belongs to, as a route segment (`reach`, `crm`). */
  product: string;
  /** The name of the change, such as `createDeal`. */
  action: string;
  input: unknown;
  /** The question the approval card asks. */
  title: string;
  /** A warning under it, for changes that cannot be undone. */
  detail: string | null;
};

/** A specialist's work so far, or finished. */
export type Delegation = {
  /** The specialist's name, as shown: Jebat, Kasturi. */
  agent: string;
  product: string;
  status: 'working' | 'done' | 'failed';
  steps: AgentStep[];
  /** What the specialist reported back to Tuah. */
  answer: string;
  proposals: Proposal[];
  /** Names of the rows it came across, so a later change can be worded with them. */
  names?: KnownNames;
  /** Ids a lookup of its returned while saying the name fits several rows: held back from deletion for the rest of the turn. */
  ambiguous?: string[];
};

function isProposal(value: unknown): value is Proposal {
  const p = value as Partial<Proposal> | null;
  return (
    !!p &&
    typeof p === 'object' &&
    typeof p.id === 'string' &&
    typeof p.product === 'string' &&
    typeof p.action === 'string' &&
    typeof p.title === 'string'
  );
}

export function isDelegation(value: unknown): value is Delegation {
  const d = value as Partial<Delegation> | null;
  return (
    !!d &&
    typeof d === 'object' &&
    typeof d.agent === 'string' &&
    typeof d.status === 'string' &&
    Array.isArray(d.steps) &&
    Array.isArray(d.proposals)
  );
}

type PartLike = { type?: unknown; output?: unknown };

const isAskPart = (part: PartLike) =>
  typeof part.type === 'string' && part.type.startsWith(`tool-${ASK_PREFIX}`);

/** Every change prepared in a conversation, by id. Later ones win. */
export function proposalsIn(messages: { parts: unknown[] }[]): Map<string, Proposal> {
  const found = new Map<string, Proposal>();
  for (const message of messages) {
    for (const part of message.parts as PartLike[]) {
      if (!part || !isAskPart(part) || !isDelegation(part.output)) continue;
      for (const proposal of part.output.proposals) {
        if (isProposal(proposal)) found.set(proposal.id, proposal);
      }
    }
  }
  return found;
}

/**
 * The names of rows a conversation has come across: those the specialists
 * saw, and those of changes that were carried out.
 */
export function namesIn(messages: { parts: unknown[] }[]): KnownNames {
  const names: KnownNames = {};
  const proposals = proposalsIn(messages);
  for (const message of messages) {
    for (const part of message.parts as (PartLike & { input?: unknown })[]) {
      if (!part) continue;
      if (isAskPart(part) && isDelegation(part.output)) {
        Object.assign(names, part.output.names ?? {});
      } else if (part.type === `tool-${APPLY_TOOL}` && part.output !== undefined) {
        const id = (part.input as { proposalId?: unknown } | null)?.proposalId;
        const proposal = typeof id === 'string' ? proposals.get(id) : undefined;
        if (proposal) collectNames([{ tool: proposal.action, output: part.output }], names);
      }
    }
  }
  return names;
}

/** True when a conversation's latest answer was produced by Tuah and its specialists. */
export function usesSpecialists(message: { parts: unknown[] } | undefined): boolean {
  if (!message) return false;
  return (message.parts as PartLike[]).some(
    (part) => !!part && (isAskPart(part) || part.type === `tool-${APPLY_TOOL}`),
  );
}

/**
 * Whether a turn is answered by Tuah with its team (the default) or by the
 * single agent that holds every tool itself.
 *
 * A turn that resumes an answer (the user tapped Approve or Reject) has no
 * say in the matter: it must be finished by whichever one started it, since
 * the change it is waiting on only exists there. A new question goes to the
 * team unless the chat asked not to (`team: false`).
 */
export function answersWithTeam(
  asked: unknown,
  last: { role: string; parts: unknown[] },
): boolean {
  if (last.role === 'assistant') return usesSpecialists(last);
  return asked !== false;
}

/** The words of a conversation, for a specialist that only sees its own task. */
export function transcriptOf(
  messages: { role: string; parts: unknown[] }[],
  maxChars = 2_000,
): string {
  const lines: string[] = [];
  for (const message of messages) {
    const text = (message.parts as { type?: unknown; text?: unknown }[])
      .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) lines.push(`${message.role === 'user' ? 'User' : 'Tuah'}: ${text}`);
  }
  const all = lines.join('\n');
  return all.length > maxChars ? `…${all.slice(-maxChars)}` : all;
}
