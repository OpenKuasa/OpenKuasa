import {
  deleteJournalAction,
  getJournalAction,
  postJournalAction,
  reverseJournalAction,
  saveAndPostJournalAction,
  saveJournalAction,
} from '@/app/(app)/finance/actions';
import { type JournalActions, JournalsView } from '@/components/finance/journals-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listJournals, listLedgerAccounts, listLedgerLines } from '@/lib/finance/ledger';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_LEDGER_ACCOUNTS, SAMPLE_LEDGER_LINES } from './ledger-sample';

const ACTIONS: JournalActions = {
  save: saveJournalAction,
  saveAndPost: saveAndPostJournalAction,
  post: postJournalAction,
  reverse: reverseJournalAction,
  remove: deleteJournalAction,
  get: getJournalAction,
};

export default async function JournalsScreen() {
  if (!hasSupabaseEnv()) {
    return <JournalsView lines={SAMPLE_LEDGER_LINES} accounts={SAMPLE_LEDGER_ACCOUNTS} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  // Changing journals is an owner's or admin's; a member reads the ledger, filters it and exports it, a demo visitor too.
  const canSignOff = !viewer.isDemo && can(viewer.role, 'sign-off-finance');
  // Drafts, and which posted journals are already reversed, are for someone who can act on them.
  const [lines, accounts, journals] = await Promise.all([
    listLedgerLines(ctx),
    listLedgerAccounts(ctx),
    canSignOff ? listJournals(ctx) : [],
  ]);
  return <JournalsView lines={lines} accounts={accounts} journals={journals} writer={canSignOff ? { actions: ACTIONS } : undefined} />;
}
