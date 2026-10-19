/**
 * Holds a finance write back unless the row id it acts on is legitimate — structurally, not by prompt (issue
 * #225). The two Tuah execution paths enforce this differently, so there are two halves here:
 *
 * - Single agent (`runBendahara`, `runTuah` with no team): `guardFinanceWrites` wraps the gated write tools in
 *   the approval chain and denies an id no read returned earlier in this conversation (`lookedUpFinance`), before a
 *   card is drawn. Modelled on hire-deletions.ts, but simpler: finance has no namesake/one-a-turn rules, only "was
 *   this id looked up as this kind?".
 * - Team mode (`runTuah` with a team): the finance row id lives in the server-side proposal, not in the messages
 *   the gate sees, so `lookedUpFinance` cannot run. `makeFinanceIdCheck` is the analogous server-side existence
 *   check (it composes the existing getters); specialists.ts calls it on the stored proposal's id and denies a
 *   hallucinated or foreign id before a card.
 */
import type { ModelMessage } from 'ai';
import type { Decision, DeletionGate } from '@/lib/ai/hire-deletions';
import { getRfq } from '@/lib/finance/rfqs';
import { getPurchaseOrder } from '@/lib/finance/purchase-orders';
import { getJournal } from '@/lib/finance/ledger';
import type { FinanceWriteContext } from '@/lib/finance/result';

export type FinanceIdKind = 'rfq' | 'purchase-order' | 'journal' | 'ledger-account';

/** The read tools that return each kind of id. */
export const READ_TOOLS_BY_KIND: Record<FinanceIdKind, readonly string[]> = {
  rfq: ['listRfqs', 'getRfq', 'getRfqGroup'],
  'purchase-order': ['listPurchaseOrders', 'getPurchaseOrder'],
  journal: ['listJournals', 'getJournal'],
  // Unused today: no write acts on a ledger account by id through this gate. Kept so the kind map is complete.
  'ledger-account': ['listLedgerAccounts'],
};

/** Write tools gated on the `id` field, with the kind that id must have been looked up as. */
export const FINANCE_ID_GATED: Record<string, FinanceIdKind> = {
  sendRfq: 'rfq', quoteRfq: 'rfq', convertRfq: 'rfq', closeRfq: 'rfq', deleteRfq: 'rfq',
  submitPurchaseOrder: 'purchase-order', decidePurchaseOrder: 'purchase-order',
  receivePurchaseOrder: 'purchase-order', billFromPurchaseOrder: 'purchase-order',
  closePurchaseOrder: 'purchase-order', cancelPurchaseOrder: 'purchase-order',
  withdrawPurchaseOrder: 'purchase-order', deletePurchaseOrder: 'purchase-order',
  postJournal: 'journal', reverseJournal: 'journal', deleteJournal: 'journal',
};
/** Create-or-replace tools: gated only when the input carries an id (editing an existing row). */
export const FINANCE_SAVE_GATED: Record<string, FinanceIdKind> = {
  saveRfq: 'rfq', savePurchaseOrder: 'purchase-order', saveJournal: 'journal',
};

const partsOf = (m: ModelMessage): { type?: unknown; toolName?: unknown; output?: unknown }[] =>
  Array.isArray(m.content) ? (m.content as never[]) : [];

/**
 * True when a read of the right kind returned this id anywhere in the conversation. The whole conversation, not
 * the turn: "post the journal you listed" must work. A real id comes only from a read's result, so one the user
 * typed, the model made up, or saw only as another kind's row does not pass.
 */
export function lookedUpFinance(messages: readonly ModelMessage[], kind: FinanceIdKind, id: unknown): boolean {
  if (typeof id !== 'string' || !id) return false;
  const reads = READ_TOOLS_BY_KIND[kind];
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    for (const part of partsOf(m)) {
      if (part.type !== 'tool-result' || typeof part.toolName !== 'string' || !reads.includes(part.toolName)) continue;
      const output = part.output as { type?: unknown; value?: unknown } | null | undefined;
      const value = output?.type === 'json' ? output.value : output;
      try { if (JSON.stringify(value ?? '').includes(id)) return true; } catch { /* unstringifiable: skip */ }
    }
  }
  return false;
}

/** The refusal for an id that no read returned as this kind. It names the read that would find it. */
export function notLookedUpFinance(kind: FinanceIdKind, id: unknown): string {
  const read = READ_TOOLS_BY_KIND[kind][0];
  return `You have not looked up ${String(id)} as a ${kind.replace('-', ' ')}. Never guess an id: use ${read} to find it and get its real id, then prepare the change again.`;
}

/**
 * Wrap the gated finance write tools so an un-looked-up id is denied before a card. `approval` and the return are
 * the same shape the hire gates use (`'user-approval' | DeletionGate`), so this composes in the single-agent
 * approval chain beside `guardDeletions`/`guardPoolChanges`/`guardInterviewChanges`. Only finance tool names are
 * touched; everything else is passed through unchanged.
 */
export function guardFinanceWrites(
  approval: Record<string, 'user-approval' | DeletionGate> | undefined,
): Record<string, 'user-approval' | DeletionGate> | undefined {
  if (!approval) return approval;
  const gateFor =
    (kind: FinanceIdKind, requireId: boolean): DeletionGate =>
    (input, { messages }): Decision => {
      const id = (input as { id?: unknown } | null)?.id;
      if (!requireId && (id === undefined || id === null || id === '')) return 'user-approval'; // pure create
      return lookedUpFinance(messages, kind, id) ? 'user-approval' : { type: 'denied', reason: notLookedUpFinance(kind, id) };
    };
  const gated: Record<string, 'user-approval' | DeletionGate> = { ...approval };
  for (const [name, kind] of Object.entries(FINANCE_ID_GATED)) if (name in approval) gated[name] = gateFor(kind, true);
  for (const [name, kind] of Object.entries(FINANCE_SAVE_GATED)) if (name in approval) gated[name] = gateFor(kind, false);
  return gated;
}

/**
 * Team mode cannot use `lookedUpFinance`: the finance row id lives in the server-side proposal, not in the
 * messages the apply gate sees. Instead this reads the row by id with the caller's own session client (so RLS
 * applies and it is never the service role). A hallucinated or foreign id fails this read before a card is drawn.
 * It composes the existing getters only — no new capability logic. Never throws.
 */
export function makeFinanceIdCheck(ctx: FinanceWriteContext) {
  return async (action: string, id: unknown): Promise<boolean> => {
    const kind = FINANCE_ID_GATED[action] ?? FINANCE_SAVE_GATED[action];
    if (!kind) return true; // not an id-gated finance action
    if (typeof id !== 'string' || !id) return action in FINANCE_SAVE_GATED; // pure create = ok; act-on-existing needs an id
    try {
      if (kind === 'rfq') return (await getRfq(ctx, id)) != null;
      if (kind === 'purchase-order') return (await getPurchaseOrder(ctx, id)) != null;
      if (kind === 'journal') return (await getJournal(ctx, id)) != null;
      return true; // ledger-account: no write acts on it
    } catch {
      return false;
    }
  };
}
