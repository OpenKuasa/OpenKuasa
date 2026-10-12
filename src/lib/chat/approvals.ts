/**
 * What a chat route hands its agent so that an approval is answered from the
 * server's own record of the change (see `proposal-store.ts`). Server only.
 *
 * Every chat route calls `chatApprovals` once per request and passes the
 * result to the agent it runs.
 */

import 'server-only';
import type { ModelMessage, UIMessage } from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { approvalBinding, type ApprovalBinding } from '@/lib/ai/products';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { APPLY_TOOL, proposalsIn, type Proposal } from '@/lib/chat/delegation';
import { noProposalStore, supabaseProposalStore, type ProposalRef, type ProposalStore } from '@/lib/chat/proposal-store';
import { serviceClient } from '@/lib/supabase/service';

type ToolPart = { type?: unknown; state?: unknown; toolCallId?: unknown; input?: unknown; approval?: { approved?: unknown } | null };

/**
 * The changes the user has just said no to: tool parts on the newest
 * assistant message whose approval was answered with a no. A change one of
 * Tuah's specialists prepared is named by its proposal id; any other by the
 * call that proposed it and what that call carried.
 */
export function rejectedIn(messages: readonly { role: string; parts: readonly unknown[] }[]): ProposalRef[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return [];
  const refs: ProposalRef[] = [];
  for (const part of last.parts as ToolPart[]) {
    if (!part || typeof part.type !== 'string' || !part.type.startsWith('tool-')) continue;
    if (part.state !== 'approval-responded' || part.approval?.approved !== false) continue;
    if (part.type === `tool-${APPLY_TOOL}`) {
      const id = (part.input as { proposalId?: unknown } | null)?.proposalId;
      if (typeof id === 'string') refs.push({ id });
    } else if (typeof part.toolCallId === 'string') {
      refs.push({ toolCallId: part.toolCallId, input: part.input });
    }
  }
  return refs;
}

type Chat = { userId: string; threadId: string | null; uiMessages: UIMessage[]; messages: ModelMessage[] };

/**
 * The binding for one chat request. In a workspace, proposals are kept in the
 * database through the service role (the table gives a signed-in user no way
 * to write to it). With no workspace there are no change tools, and the store
 * keeps nothing. A change the user has just rejected is settled here, before
 * the agent runs, so it can never be approved afterwards.
 *
 * `service` is for tests; a route leaves it out.
 */
export async function chatApprovals(
  chat: Chat,
  orgId: string | null,
  service: () => SupabaseClient = serviceClient,
): Promise<ApprovalBinding> {
  const store: ProposalStore =
    orgId && hasSupabaseEnv()
      ? supabaseProposalStore(service, { userId: chat.userId, orgId, threadId: chat.threadId })
      : noProposalStore;
  const rejected = rejectedIn(chat.uiMessages);
  if (rejected.length > 0) await store.reject(rejected);
  return approvalBinding(store, chat.messages);
}

/**
 * The changes prepared earlier in a team conversation, as the server recorded
 * them. The conversation says which ids to look for and how each card was
 * worded; what each change is (product, tool, arguments) comes from the
 * record alone. An id the server has no record of is left out: it cannot be
 * applied, so it is not offered to the gate either.
 */
export async function recordedProposals(
  store: ProposalStore,
  messages: readonly { parts: unknown[] }[],
): Promise<Map<string, Proposal>> {
  const described = proposalsIn([...messages]);
  const recorded = await store.peek([...described.keys()]);
  const known = new Map<string, Proposal>();
  for (const [id, stored] of recorded) {
    const shown = described.get(id);
    known.set(id, {
      id,
      product: stored.product,
      action: stored.action,
      input: stored.input,
      title: shown?.title ?? '',
      detail: shown?.detail ?? null,
    });
  }
  return known;
}
