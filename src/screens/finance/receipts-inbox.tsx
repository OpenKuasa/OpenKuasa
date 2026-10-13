import {
  attachReceiptAction,
  deleteReceiptAction,
  detachReceiptAction,
  readReceiptAction,
  receiptLinkAction,
  receiptToBillAction,
  receiptToExpenseAction,
  registerReceiptAction,
  reviewReceiptAction,
} from '@/app/(app)/finance/receipt-inbox-actions';
import type { ReceiptMatchActions } from '@/components/finance/receipt-match-cards';
import { type ReceiptInboxActions, ReceiptsInboxView } from '@/components/finance/receipts-inbox-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listBills } from '@/lib/finance/bills';
import { listContacts } from '@/lib/finance/contacts';
import { listExpenseCategories, listExpenses } from '@/lib/finance/expenses';
import { purchasesCategoryId } from '@/lib/finance/ledger';
import { listProducts } from '@/lib/finance/products';
import {
  attachCandidates,
  listAttachedReceipts,
  matchedDocuments,
  offeredContacts,
  receiptInboxPlan,
} from '@/lib/finance/receipt-match';
import { receiptModelId, workspaceKeyState } from '@/lib/finance/receipt-reader';
import { receiptReadingPlan } from '@/lib/finance/receipt-reading';
import { receiptsInboxView } from '@/lib/finance/receipt-views';
import { listInboxReceipts } from '@/lib/finance/receipts';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_INBOX_RECEIPTS } from './receipts-sample';
import { SAMPLE_TODAY } from './sales-sample';

const ACTIONS: ReceiptInboxActions = {
  register: registerReceiptAction,
  review: reviewReceiptAction,
  remove: deleteReceiptAction,
};

const MATCH_ACTIONS: ReceiptMatchActions = {
  toExpense: receiptToExpenseAction,
  toBill: receiptToBillAction,
  attach: attachReceiptAction,
  detach: detachReceiptAction,
};

/**
 * Every receipt in the inbox. Anyone who may edit adds receipts, reviews
 * them, makes an expense or a draft bill from one, ties one to an expense or
 * a bill that exists, unties it, and deletes one that is tied to nothing; the
 * bucket and the database decide the same again. Untying from an approved
 * expense or a posted bill is an owner's or admin's (`sign-off-finance`, the
 * same people the database's `finance_may_decide` names). Anyone who can see
 * a receipt can download its file. A viewer and the demo workspace read: the
 * demo's guests are anonymous accounts, which the bucket refuses, so they get
 * no upload area and are told why. A session that still owes a second factor
 * never gets this far (`getViewer` sends it to verify first).
 *
 * With no receipt there is nothing to match, so the expenses, the bills and
 * what the forms offer are read only once the inbox holds one.
 *
 * Anyone who may edit is also handed the action that sends a receipt to be
 * read by AI, with what the card needs to ask first: whether this server
 * names a model for receipts, and whether the workspace has an AI key (asked
 * as the caller, and only when some receipt on the page could be read). The
 * page itself reads no receipt and sends nothing: only the card's button does.
 */
export default async function ReceiptsInboxScreen() {
  if (!hasSupabaseEnv()) {
    return (
      <ReceiptsInboxView
        rows={SAMPLE_INBOX_RECEIPTS}
        view={receiptsInboxView(SAMPLE_INBOX_RECEIPTS)}
        today={SAMPLE_TODAY}
        followClock={false}
      />
    );
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const rows = await listInboxReceipts(ctx);
  const plan = receiptInboxPlan(viewer, rows.length > 0);
  const readingPlan = receiptReadingPlan(viewer, rows);
  // How each matched receipt's document stands is shown to everyone; the forms and the picker are a writer's.
  const [attached, expenses, bills, contacts, categories, products, defaultCategoryId, keyState] = await Promise.all([
    plan.readsDocuments ? listAttachedReceipts(ctx) : [],
    plan.readsDocuments ? listExpenses(ctx) : [],
    plan.readsDocuments ? listBills(ctx) : [],
    plan.readsForms ? listContacts(ctx) : [],
    plan.readsForms ? listExpenseCategories(ctx) : [],
    plan.readsForms ? listProducts(ctx) : [],
    plan.readsForms ? purchasesCategoryId(ctx) : null,
    // Not asked: the card shows the question, and the action answers when it is pressed.
    readingPlan.readsKeyState ? workspaceKeyState(ctx.client) : ('unknown' as const),
  ]);
  const offered = offeredContacts(contacts);
  return (
    <ReceiptsInboxView
      rows={rows}
      view={receiptsInboxView(rows)}
      today={todayUtc()}
      linkOf={receiptLinkAction}
      documents={matchedDocuments(attached, expenses, bills)}
      writer={
        plan.canEdit
          ? {
              orgId: viewer.orgId,
              actions: ACTIONS,
              match: {
                actions: MATCH_ACTIONS,
                // Decided here, on the server, and nowhere else.
                canDecide: plan.canDecide,
                // Only what the forms read goes to the browser.
                contacts: offered.contacts,
                categories,
                suppliers: offered.suppliers,
                products: products.filter((p) => p.active),
                defaultCategoryId: defaultCategoryId ?? '',
                candidates: attachCandidates(expenses, bills),
              },
              reading: readingPlan.offered
                ? {
                    read: readReceiptAction,
                    setUp: receiptModelId() !== null,
                    keyState,
                    canManageKey: readingPlan.canManageKey,
                  }
                : undefined,
            }
          : undefined
      }
      demo={viewer.isDemo}
    />
  );
}
