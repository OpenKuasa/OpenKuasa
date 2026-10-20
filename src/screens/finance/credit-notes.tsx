import {
  deleteCreditNoteAction,
  fxSstRateForAction,
  issueCreditNoteAction,
  recordRefundAction,
  saveAndIssueCreditNoteAction,
  saveCreditNoteAction,
  voidCreditNoteAction,
} from '@/app/(app)/finance/actions';
import { type CreditNoteActions, CreditNotesView } from '@/components/finance/credit-notes-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listCreditNotes } from '@/lib/finance/credit-notes';
import { listInvoices } from '@/lib/finance/invoices';
import { listAccounts } from '@/lib/finance/money';
import { listRefunds } from '@/lib/finance/refunds';
import { creditNotesView } from '@/lib/finance/sales-followon-views';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_CREDIT_NOTES, SAMPLE_TODAY } from './sales-sample';

const ACTIONS: CreditNoteActions = {
  save: saveCreditNoteAction,
  saveAndIssue: saveAndIssueCreditNoteAction,
  issue: issueCreditNoteAction,
  voidNote: voidCreditNoteAction,
  remove: deleteCreditNoteAction,
  recordRefund: recordRefundAction,
  fxRate: fxSstRateForAction,
};

export default async function CreditNotesScreen() {
  if (!hasSupabaseEnv()) {
    return <CreditNotesView rows={SAMPLE_CREDIT_NOTES} view={creditNotesView(SAMPLE_CREDIT_NOTES, SAMPLE_TODAY)} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  // The credit note form offers posted invoices; the refund form, opened from a credit note's row, needs the
  // invoices' credit, the refunds that are pending and the accounts. A viewer has no form, so none is read for them.
  const [rows, invoices, refunds, accounts] = await Promise.all([
    listCreditNotes(ctx),
    canEdit ? listInvoices(ctx) : [],
    canEdit ? listRefunds(ctx) : [],
    // Stage 5b: every active account; each form offers ringgit ones and those in its documents' currency.
    canEdit ? listAccounts(ctx) : [],
  ]);
  return (
    <CreditNotesView
      rows={rows}
      view={creditNotesView(rows, todayUtc())}
      writer={canEdit ? { actions: ACTIONS, invoices, refunds, accounts } : undefined}
    />
  );
}
