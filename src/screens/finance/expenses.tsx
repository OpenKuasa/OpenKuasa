import {
  approveExpenseAction,
  deleteExpenseAction,
  rejectExpenseAction,
  saveExpenseAction,
} from '@/app/(app)/finance/actions';
import { receiptLinkAction } from '@/app/(app)/finance/receipt-inbox-actions';
import { type ExpenseActions, ExpensesView } from '@/components/finance/expenses-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listContacts } from '@/lib/finance/contacts';
import { canEditExpenses } from '@/lib/finance/expense-form';
import { listExpenseCategories, listExpenses } from '@/lib/finance/expenses';
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
};

/**
 * Every expense. Anyone who may edit can enter one, and change or delete one
 * that is pending or rejected; approving and rejecting are an owner's or
 * admin's (`sign-off-finance`, the same people the database's
 * `finance_may_decide` names), and what they save is approved. A viewer and
 * the demo workspace read.
 */
export default async function ExpensesScreen() {
  if (!hasSupabaseEnv()) {
    return <ExpensesView rows={SAMPLE_EXPENSES} today={SAMPLE_TODAY} followClock={false} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canEdit = canEditExpenses(viewer.role, viewer.isDemo);
  // The form offers contacts and expense categories; anyone without the form has neither read made for them.
  // The receipts tied to an expense show in its row, for everyone who can see it.
  const [rows, attached, contacts, categories] = await Promise.all([
    listExpenses(ctx),
    // Without the paperclips the page still loads: a failed read is logged and shows none.
    attachedReceiptsOrNone(() => listAttachedReceipts(ctx)),
    canEdit ? listContacts(ctx) : [],
    canEdit ? listExpenseCategories(ctx) : [],
  ]);
  return (
    <ExpensesView
      rows={rows}
      today={todayUtc()}
      receipts={receiptsByDocument(attached)}
      receiptLinkOf={receiptLinkAction}
      writer={
        canEdit
          ? {
              actions: ACTIONS,
              // Decided here, on the server, and nowhere else.
              canDecide: can(viewer.role, 'sign-off-finance'),
              // Only what the form reads goes to the browser.
              contacts: contacts.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name })),
              categories,
            }
          : undefined
      }
    />
  );
}
