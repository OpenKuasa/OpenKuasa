/**
 * Which finance screens each AI-applied finance write refreshes.
 *
 * The finance UI forms revalidate their screens from `src/app/(app)/finance/actions.ts` (its `run()` helper
 * calls `revalidatePath` for every path in the action's list). A write applied by Tuah/Bendahara goes straight
 * through the capability function and never touches those server actions, so without this the finance screens
 * would show stale data after an AI write. The apply paths call `revalidateFinance(action)` after a write
 * returns `ok`, with the same per-action path groupings `actions.ts` uses.
 *
 * The groups below are copied verbatim from `actions.ts`: `RFQ_PATHS` (line 381), `PURCHASE_ORDER_PATHS`
 * (385), `CONVERT_RFQ_PATHS` (387), `ORDER_BILL_PATHS` (390) and `LEDGER_PATHS` (322). Keep them in step.
 *
 * The keys are exactly the id-gated finance write actions (`FINANCE_ID_GATED` ∪ `FINANCE_SAVE_GATED` in
 * finance-id-gate.ts). Their tools arrive in Tasks 7-10, so the names are forward-declared here; a write that
 * is not in this map simply revalidates nothing (see `revalidateFinance`).
 */

import { revalidatePath } from 'next/cache';

/** An RFQ is on its own screen only: a request, not money owed, and no other screen counts or names it. */
const RFQ = ['/finance/rfqs'] as const;
/** A purchase order's own writes refresh its screen and the two that read it: RFQs and Supplier Bills. */
const PO = ['/finance/purchase-orders', '/finance/rfqs', '/finance/supplier-bills'] as const;
/** Making a purchase order from an RFQ adds a draft to Purchase Orders and puts that order in the RFQ's column. */
const CONVERT_RFQ = ['/finance/rfqs', '/finance/purchase-orders'] as const;
/** Raising a bill from an order adds a draft to Supplier Bills and moves the order's billed total. */
const ORDER_BILL = ['/finance/purchase-orders', '/finance/supplier-bills'] as const;
/** Every ledger write touches the three screens that read the books. */
const LEDGER = ['/finance/chart-of-accounts', '/finance/journals', '/finance/reports'] as const;

/** Which `/finance` screens each finance write action refreshes — mirrors the groupings in finance/actions.ts. */
export const FINANCE_REVALIDATE: Record<string, readonly string[]> = {
  saveRfq: RFQ,
  sendRfq: RFQ,
  quoteRfq: RFQ,
  closeRfq: RFQ,
  deleteRfq: RFQ,
  convertRfq: CONVERT_RFQ,
  savePurchaseOrder: PO,
  submitPurchaseOrder: PO,
  decidePurchaseOrder: PO,
  receivePurchaseOrder: PO,
  closePurchaseOrder: PO,
  cancelPurchaseOrder: PO,
  withdrawPurchaseOrder: PO,
  deletePurchaseOrder: PO,
  billFromPurchaseOrder: ORDER_BILL,
  saveJournal: LEDGER,
  postJournal: LEDGER,
  reverseJournal: LEDGER,
  deleteJournal: LEDGER,
};

/**
 * Refreshes the finance screens an applied write changed. Called on both apply paths after the write returns
 * `ok`. Each `revalidatePath` is wrapped: it throws when called outside a request scope (the Task-12 eval
 * harness applies finance writes in a plain Node script, and the apply-path tests), and the write has already
 * succeeded — staleness is cosmetic, so a best-effort no-op there is correct rather than failing the write.
 */
export function revalidateFinance(action: string): void {
  for (const path of FINANCE_REVALIDATE[action] ?? []) {
    try {
      revalidatePath(path);
    } catch {
      /* outside a request scope (eval harness / tests): best-effort, the write already succeeded */
    }
  }
}
