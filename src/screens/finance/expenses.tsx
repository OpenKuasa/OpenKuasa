import {
  approveExpenseAction,
  deleteExpenseAction,
  markExpensePaidAction,
  rejectExpenseAction,
  saveExpenseAction,
} from '@/app/(app)/finance/actions';
import { receiptLinkAction } from '@/app/(app)/finance/receipt-inbox-actions';
import { type ExpenseActions, ExpensesView } from '@/components/finance/expenses-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listContacts } from '@/lib/finance/contacts';
import { expensesScreenPlan } from '@/lib/finance/expense-form';
import { listExpenseCategories, listExpenses } from '@/lib/finance/expenses';
import { listAccounts } from '@/lib/finance/money';
import { attachedReceiptsOrNone, listAttachedReceipts, receiptsByDocument } from '@/lib/finance/receipt-match';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_EXPENSES } from './cash-book-sample';
import { SAMPLE_TODAY } from './sales-sample';

const ACTIONS: ExpenseActions = {
  save: saveExpenseAction,
  approve: approveExpenseAction,
  reject: rejectExpenseAction,
  remove: deleteExpenseAction,
  pay: markExpensePaidAction,
};

/**
 * Every expense. Anyone who may edit can enter one, and change or delete one
 * that is pending or rejected; approving and rejecting are an owner's or
 * admin's (`sign-off-finance`, the same people the database's
 * `finance_may_decide` names), and what they save is approved. They also mark
 * an approved expense paid, from an account: the same people, as paying is a
 * sign-off. A viewer and the demo workspace read.
 */
export default async function ExpensesScreen() {
  if (!hasSupabaseEnv()) {
    return <ExpensesView rows={SAMPLE_EXPENSES} today={SAMPLE_TODAY} followClock={false} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  // Decided here, on the server, and nowhere else (a function of its own, so a test can pin it).
  const plan = expensesScreenPlan(viewer.role, viewer.isDemo);
  // The form offers contacts and expense categories; anyone without the form has neither read made for them.
  // The receipts tied to an expense show in its row, for everyone who can see it.
  // The accounts are for Mark paid, which only someone who may decide is given.
  const [rows, attached, contacts, categories, accounts] = await Promise.all([
    listExpenses(ctx),
    // Without the paperclips the page still loads: a failed read is logged and shows none.
    attachedReceiptsOrNone(() => listAttachedReceipts(ctx)),
    plan.readsContacts ? listContacts(ctx) : [],
    plan.readsCategories ? listExpenseCategories(ctx) : [],
    plan.readsAccounts ? listAccounts(ctx) : [],
  ]);
  return (
    <ExpensesView
      rows={rows}
      today={todayUtc()}
      receipts={receiptsByDocument(attached)}
      receiptLinkOf={receiptLinkAction}
      writer={
        plan.canEdit
          ? {
              actions: ACTIONS,
              canDecide: plan.canDecide,
              // Only what the form reads goes to the browser.
              contacts: contacts.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name })),
              categories,
              // Active accounts only, and only for someone who may pay; empty for everyone else.
              accounts,
            }
          : undefined
      }
    />
  );
}
