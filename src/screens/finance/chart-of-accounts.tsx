import {
  createAccountAction,
  deleteAccountAction,
  setAccountActiveAction,
  updateAccountAction,
} from '@/app/(app)/finance/actions';
import { type AccountActions, AccountsView } from '@/components/finance/accounts-view';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { listLedgerAccounts } from '@/lib/finance/ledger';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_LEDGER_ACCOUNTS } from './ledger-sample';

const ACTIONS: AccountActions = {
  create: createAccountAction,
  update: updateAccountAction,
  setActive: setAccountActiveAction,
  remove: deleteAccountAction,
};

export default async function ChartOfAccountsScreen() {
  if (!hasSupabaseEnv()) {
    return <AccountsView accounts={SAMPLE_LEDGER_ACCOUNTS} />;
  }
  const viewer = await getViewer();
  const accounts = await listLedgerAccounts({ client: await createClient(), orgId: viewer.orgId });
  // Changing accounts is an owner's or admin's; a member reads the chart and exports it, a demo visitor too.
  const canSignOff = !viewer.isDemo && can(viewer.role, 'sign-off-finance');
  return <AccountsView accounts={accounts} writer={canSignOff ? { actions: ACTIONS } : undefined} />;
}
