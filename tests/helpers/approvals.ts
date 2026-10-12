/**
 * For tests that are about something other than how an approval is tied to
 * the server's record of a change (wording, gates, what a tool saves).
 *
 * A real request is answered from the store the route keeps: a change can be
 * approved only if the server recorded proposing it, in an earlier request.
 * These tests write that earlier request's conversation by hand, or run it in
 * a separate call, so the helpers here build the store that request would
 * have left behind: every change call the conversation holds, recorded as
 * proposed. `tests/chat-proposal-binding.test.ts` is where the tie itself is
 * tested, with stores it fills (or leaves empty) on purpose.
 */
import type { ModelMessage } from 'ai';
import { CRM_WRITE_TOOL_NAMES } from '@/lib/ai/crm-tools';
import { FINANCE_WRITE_TOOL_NAMES } from '@/lib/ai/finance-tools';
import {
  HIRE_WRITE_TOOL_NAMES,
  PEOPLE_WRITE_TOOL_NAMES,
  REACH_WRITE_TOOL_NAMES,
  approvalBinding,
  type ApprovalBinding,
} from '@/lib/ai/products';
import { memoryProposalStore, type ProposalStore } from '@/lib/chat/proposal-store';

const PRODUCT_OF = new Map<string, string>([
  ...REACH_WRITE_TOOL_NAMES.map((name) => [name, 'reach'] as const),
  ...CRM_WRITE_TOOL_NAMES.map((name) => [name, 'crm'] as const),
  ...HIRE_WRITE_TOOL_NAMES.map((name) => [name, 'hire'] as const),
  ...PEOPLE_WRITE_TOOL_NAMES.map((name) => [name, 'people'] as const),
  ...FINANCE_WRITE_TOOL_NAMES.map((name) => [name, 'finance'] as const),
]);

type Prepared = { id: string; product: string; action: string; input: unknown };

/** A store holding these prepared changes, as if a specialist had prepared each in an earlier request. */
export function storeOf(prepared: Iterable<Prepared> = []): ProposalStore {
  const store = memoryProposalStore();
  // The memory store keeps a record before its first pause, so these are in place when this returns.
  for (const p of prepared) void store.record({ id: p.id, product: p.product, action: p.action, input: p.input });
  return store;
}

/**
 * The binding an earlier request would have left for this conversation: each
 * change call in it recorded as proposed, and each change a specialist
 * prepared (`prepared`) recorded under its id.
 */
export function proposedBefore(messages: readonly ModelMessage[], prepared: Iterable<Prepared> = []): ApprovalBinding {
  const store = storeOf(prepared);
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content as { type?: string; toolCallId?: string; toolName?: string; input?: unknown }[]) {
      const product = part.type === 'tool-call' && part.toolName ? PRODUCT_OF.get(part.toolName) : undefined;
      if (!product || !part.toolCallId || !part.toolName) continue;
      void store.record({ toolCallId: part.toolCallId, product, action: part.toolName, input: part.input });
    }
  }
  return approvalBinding(store, messages);
}

type Orchestrator = typeof import('@/lib/ai/agents/orchestrator');
type Agent = 'runJebat' | 'runKasturi' | 'runLekir' | 'runLekiu' | 'runTuah';

/** An agent's arguments, with the binding above put in its place unless the test passed its own. */
function bound<K extends Agent>(slot: number, teamSlot?: number) {
  return (...args: Parameters<Orchestrator[K]>): Parameters<Orchestrator[K]> => {
    const padded = [...args] as unknown[];
    while (padded.length <= slot) padded.push(undefined);
    if (padded[slot] === undefined) {
      const team = teamSlot === undefined ? null : (padded[teamSlot] as { proposals?: Map<string, Prepared> } | null | undefined);
      padded[slot] = proposedBefore(padded[0] as ModelMessage[], team?.proposals?.values() ?? []);
    }
    return padded as Parameters<Orchestrator[K]>;
  };
}

export const withJebat = bound<'runJebat'>(4);
export const withKasturi = bound<'runKasturi'>(5);
export const withLekir = bound<'runLekir'>(4);
export const withLekiu = bound<'runLekiu'>(4);
export const withTuah = bound<'runTuah'>(10, 6);
