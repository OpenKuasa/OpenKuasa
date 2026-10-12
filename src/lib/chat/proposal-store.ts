/**
 * Where the server keeps the changes it has put to a user for approval.
 *
 * A change is recorded when an assistant proposes it. Approving names the
 * record; the server takes it (once), and applies the arguments it kept. What
 * the browser sends back with an approval is used to find the record and for
 * nothing else, so a change that is saved is always one the server proposed,
 * to this person, in this workspace, and not yet answered.
 *
 * Server only. Three stores: the database one the chat routes use, one that
 * keeps nothing (no workspace, or the server cannot reach the table), and one
 * in memory for tests.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errorCodeOf } from '@/lib/ai/call-log';

/** A change as the server kept it. `input` is null once it has been settled or has lapsed. */
export type StoredChange = { id: string; product: string; action: string; input: unknown };

export type NewProposal = {
  /** Chosen by the caller, so it can be reserved before the write is awaited. */
  id?: string;
  /** The model call that proposed it, for an assistant that holds its change tools itself. */
  toolCallId?: string;
  product: string;
  action: string;
  input: unknown;
};

/** How a waiting change is found: by its own id, or by the call that proposed it and exactly what that call carried. */
export type ProposalRef = { id: string } | { toolCallId: string; input: unknown };

export interface ProposalStore {
  /** Keeps a proposed change. Resolves to its id, or null when it could not be kept (then it must not be shown). */
  record(proposal: NewProposal): Promise<string | null>;
  /** What these ids were proposed as, settled or not: this user's, in this workspace. Nothing is taken. */
  peek(ids: string[]): Promise<Map<string, StoredChange>>;
  /** Takes a waiting change for applying. Null when there is none: unknown, another's, lapsed, or already answered. */
  claim(ref: ProposalRef): Promise<StoredChange | null>;
  /** Settles changes the user said no to. Never throws. */
  reject(refs: ProposalRef[]): Promise<void>;
}

/** How long a proposed change waits for its answer. The database sets the same default on the row. */
export const PROPOSAL_TTL_MS = 60 * 60 * 1000;

export const NOT_PREPARED =
  'Changes cannot be prepared right now, so nothing was put up for approval. Tell the user, and suggest trying again in a few minutes.';
export const NOT_WAITING =
  'This change is no longer waiting for approval: it was already answered, it waited more than an hour, or it is not one that was prepared here. ' +
  'Nothing was saved. If the user still wants it, prepare it again.';

/** JSON with its keys in order, so the same arguments always give the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, inner]) => inner !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`;
}

export function inputHash(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A store that keeps nothing: every change is refused before it is shown, and nothing can be approved. */
export const noProposalStore: ProposalStore = {
  record: async () => null,
  peek: async () => new Map(),
  claim: async () => null,
  reject: async () => {},
};

type Scope = { userId: string; orgId: string; threadId: string | null };

/**
 * The store the chat routes use. `service` is the service-role client: the
 * table gives a signed-in user no way to write, so a browser cannot add a
 * proposal of its own. Every call is narrowed to this user and this workspace
 * here, since the service role is not narrowed by row-level security. A table
 * that is not there yet (the migration not applied) or a failed call keeps
 * nothing and approves nothing.
 */
export function supabaseProposalStore(service: () => SupabaseClient, scope: Scope): ProposalStore {
  const failed = (what: string, error: unknown) => {
    // The code only: the row holds a change's arguments.
    console.error(`[chat] could not ${what} a proposed change:`, errorCodeOf(error));
  };
  const claimArgs = (ref: ProposalRef) =>
    'id' in ref
      ? { p_id: ref.id }
      : { p_tool_call_id: ref.toolCallId, p_input_hash: inputHash(ref.input) };

  return {
    async record(proposal) {
      const id = proposal.id ?? randomUUID();
      try {
        const { error } = await service().rpc('record_chat_proposal', {
          p_id: id,
          p_user_id: scope.userId,
          p_org_id: scope.orgId,
          p_thread_id: scope.threadId,
          p_tool_call_id: proposal.toolCallId ?? null,
          p_product: proposal.product,
          p_action: proposal.action,
          p_input: proposal.input ?? null,
          p_input_hash: inputHash(proposal.input),
        });
        if (error) {
          failed('keep', error);
          return null;
        }
        return id;
      } catch (error) {
        failed('keep', error);
        return null;
      }
    },

    async peek(ids) {
      const known = new Map<string, StoredChange>();
      const wanted = [...new Set(ids)].filter((id) => UUID.test(id)).slice(0, 100);
      if (wanted.length === 0) return known;
      try {
        const { data, error } = await service()
          .from('chat_proposals')
          .select('id,product,action,input')
          .eq('user_id', scope.userId)
          .eq('org_id', scope.orgId)
          .in('id', wanted);
        if (error) {
          failed('read', error);
          return known;
        }
        for (const row of (data ?? []) as StoredChange[]) known.set(row.id, row);
      } catch (error) {
        failed('read', error);
      }
      return known;
    },

    async claim(ref) {
      if ('id' in ref && !UUID.test(ref.id)) return null;
      try {
        const { data, error } = await service().rpc('claim_chat_proposal', {
          p_user_id: scope.userId,
          p_org_id: scope.orgId,
          ...claimArgs(ref),
        });
        if (error) {
          failed('take', error);
          return null;
        }
        const row = (Array.isArray(data) ? data[0] : data) as StoredChange | null | undefined;
        return row && typeof row.id === 'string' ? row : null;
      } catch (error) {
        failed('take', error);
        return null;
      }
    },

    async reject(refs) {
      const ids = refs.flatMap((ref) => ('id' in ref && UUID.test(ref.id) ? [ref.id] : []));
      const calls = refs.flatMap((ref) =>
        'id' in ref ? [] : [{ tool_call_id: ref.toolCallId, input_hash: inputHash(ref.input) }],
      );
      if (ids.length === 0 && calls.length === 0) return;
      try {
        const { error } = await service().rpc('reject_chat_proposals', {
          p_user_id: scope.userId,
          p_org_id: scope.orgId,
          p_ids: ids,
          p_calls: calls,
        });
        if (error) failed('settle', error);
      } catch (error) {
        failed('settle', error);
      }
    },
  };
}

type MemoryRow = StoredChange & {
  toolCallId: string | null;
  hash: string;
  status: 'pending' | 'approved' | 'rejected';
  expiresAt: number;
};

/**
 * The same rules, kept in memory: single use, lapse after an hour, found by id
 * or by call and arguments. For tests, and as the store of an agent run that
 * was given none (then it lives for that one request, so nothing proposed in
 * it can be approved later).
 */
export function memoryProposalStore(now: () => number = Date.now): ProposalStore & { rows: MemoryRow[] } {
  const rows: MemoryRow[] = [];
  const waiting = (ref: ProposalRef) =>
    rows
      .filter((row) => row.status === 'pending' && row.expiresAt > now())
      .filter((row) => ('id' in ref ? row.id === ref.id : row.toolCallId === ref.toolCallId && row.hash === inputHash(ref.input)))
      .at(-1);
  return {
    rows,
    async record(proposal) {
      const id = proposal.id ?? randomUUID();
      if (rows.some((row) => row.id === id)) return null;
      rows.push({
        id,
        toolCallId: proposal.toolCallId ?? null,
        product: proposal.product,
        action: proposal.action,
        // Kept as it was when proposed: a later change to the caller's object must not reach it.
        input: structuredClone(proposal.input ?? null),
        hash: inputHash(proposal.input),
        status: 'pending',
        expiresAt: now() + PROPOSAL_TTL_MS,
      });
      return id;
    },
    async peek(ids) {
      return new Map(
        rows.filter((row) => ids.includes(row.id)).map((row) => [row.id, { id: row.id, product: row.product, action: row.action, input: row.input }]),
      );
    },
    async claim(ref) {
      const row = waiting(ref);
      if (!row) return null;
      const taken = { id: row.id, product: row.product, action: row.action, input: row.input };
      row.status = 'approved';
      row.input = null;
      return taken;
    },
    async reject(refs) {
      for (const ref of refs) {
        const row = waiting(ref);
        if (!row) continue;
        row.status = 'rejected';
        row.input = null;
      }
    },
  };
}
