/**
 * Holds a roster, hours, shift type or shift swap change back unless every id it carries came from a lookup of the
 * right kind. The people change tools have no such gate of their own (the database answers "not found"); these do,
 * because a roster change carries many ids at once (a week of cells) and a made-up one would only fail after the
 * person approved it.
 *
 * - Single agent (Ask-Lekiu, Tuah with no team): `guardRosterWrites` sits in the approval chain beside
 *   `guardFinanceWrites` and denies, before any card, a change with an id no lookup of that kind returned anywhere in
 *   this conversation (`lookedUpRoster`).
 * - Team mode: the specialist that prepares the change checks the same ids against its own lookups and the names the
 *   conversation has collected (`rosterIdProblem`, called from specialists.ts), so a proposal with a made-up id is
 *   never recorded.
 */
import type { ModelMessage } from 'ai';
import type { Decision, DeletionGate } from '@/lib/ai/hire-deletions';
import type { ItemKind, NameFinder } from '@/lib/chat/change-titles';
import { isRosterTool } from '@/lib/people/roster-cards';

export type RosterIdKind = Extract<ItemKind, 'employee' | 'shift-type' | 'shift' | 'swap'>;

/** The lookups (and the one change) whose results hand out each kind of id. */
export const ROSTER_READS_BY_KIND: Record<RosterIdKind, readonly string[]> = {
  employee: ['listEmployees', 'getEmployee', 'listMyTeam'],
  'shift-type': ['listShiftTypes', 'saveShiftType'],
  shift: ['listSwapOptions'],
  swap: ['listShiftSwaps', 'requestShiftSwap'],
};

const present = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** Every id a roster change carries, with the kind it must have been looked up as. A pure create carries none. */
export function rosterIds(toolName: string, input: unknown): { kind: RosterIdKind; id: string }[] {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: { kind: RosterIdKind; id: string }[] = [];
  const add = (kind: RosterIdKind, value: unknown) => {
    if (present(value)) out.push({ kind, id: value.trim() });
  };
  switch (toolName) {
    case 'setShifts':
      for (const cell of Array.isArray(i.cells) ? i.cells : []) {
        const c = (cell && typeof cell === 'object' ? cell : {}) as Record<string, unknown>;
        add('employee', c.employee_id);
        add('shift-type', c.shift_type_id);
      }
      break;
    case 'logHours':
      add('employee', i.employee_id);
      break;
    case 'saveShiftType':
    case 'archiveShiftType':
      add('shift-type', i.id);
      break;
    case 'requestShiftSwap':
      add('shift', i.my_shift_id);
      add('shift', i.their_shift_id);
      break;
    case 'replyShiftSwap':
    case 'decideShiftSwap':
    case 'cancelShiftSwap':
      add('swap', i.id);
      break;
  }
  return out;
}

const partsOf = (m: ModelMessage): { type?: unknown; toolName?: unknown; output?: unknown }[] =>
  Array.isArray(m.content) ? (m.content as never[]) : [];

/**
 * True when a lookup of the right kind returned this id anywhere in the conversation (not just this turn: "swap the
 * shift you listed" must work). An id the person typed, the model made up, or that was seen only as another kind's
 * does not pass.
 */
export function lookedUpRoster(messages: readonly ModelMessage[], kind: RosterIdKind, id: string): boolean {
  const reads = ROSTER_READS_BY_KIND[kind];
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    for (const part of partsOf(m)) {
      if (part.type !== 'tool-result' || typeof part.toolName !== 'string' || !reads.includes(part.toolName)) continue;
      const output = part.output as { type?: unknown; value?: unknown } | null | undefined;
      const value = output?.type === 'json' ? output.value : output;
      try {
        if (JSON.stringify(value ?? '').includes(id)) return true;
      } catch {
        /* unstringifiable: skip */
      }
    }
  }
  return false;
}

const KIND_WORDS: Record<RosterIdKind, string> = {
  employee: 'an employee',
  'shift-type': 'a shift type',
  shift: 'a shift that can be swapped',
  swap: 'a shift swap',
};

/** The refusal for an id no lookup returned as this kind. Begins "You have not looked up ", which the chat words for a person. */
export function rosterNotLookedUp(kind: RosterIdKind, id: string): string {
  return `You have not looked up ${id} as ${KIND_WORDS[kind]}. Never guess an id: use ${ROSTER_READS_BY_KIND[kind][0]} to find it and get its real id, then prepare the change again.`;
}

/**
 * Wraps the roster change tools so a change carrying an id no lookup returned is denied before a card. Composes in the
 * single-agent approval chain like `guardFinanceWrites`; every other tool passes through unchanged. A change already
 * denied by an earlier gate stays denied.
 */
export function guardRosterWrites(
  approval: Record<string, 'user-approval' | DeletionGate> | undefined,
): Record<string, 'user-approval' | DeletionGate> | undefined {
  if (!approval) return approval;
  const gated: Record<string, 'user-approval' | DeletionGate> = { ...approval };
  for (const [name, inner] of Object.entries(approval)) {
    if (!isRosterTool(name)) continue;
    gated[name] = async (input, options): Promise<Decision> => {
      for (const { kind, id } of rosterIds(name, input)) {
        if (!lookedUpRoster(options.messages, kind, id)) return { type: 'denied', reason: rosterNotLookedUp(kind, id) };
      }
      return typeof inner === 'function' ? inner(input, options) : inner;
    };
  }
  return gated;
}

/**
 * Team mode: the first id in a roster change that was not looked up as its kind, by this specialist (`find`, over its
 * own lookups) or earlier in the conversation (`known`, the names collected by `kind:id`). Null when every id was.
 */
export function rosterIdProblem(
  toolName: string,
  input: unknown,
  find: NameFinder,
  known: Record<string, string> | undefined,
): string | null {
  for (const { kind, id } of rosterIds(toolName, input)) {
    if (!known?.[`${kind}:${id}`] && !find(id, kind)) return rosterNotLookedUp(kind, id);
  }
  return null;
}
