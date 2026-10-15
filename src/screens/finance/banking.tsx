import {
  createBankAccountAction,
  recordTransferAction,
  setBankAccountActiveAction,
  updateBankAccountAction,
  voidTransferAction,
} from '@/app/(app)/finance/actions';
import { type BankingActions, BankingView, type TransferActions } from '@/components/finance/banking-view';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { bankingAccess } from '@/lib/finance/banking-access';
import { listBankAccountNumbers } from '@/lib/finance/bank-accounts';
import { listBankAccounts, listBankTransactions } from '@/lib/finance/banking';
import { malaysiaClock } from '@/lib/finance/fx-dates';
import { workspaceUsesForeignCurrency } from '@/lib/finance/fx-card-gate';
import { type FxLatestRate, listLatestFxRates } from '@/lib/finance/fx-rates';
import { todayUtc } from '@/lib/finance/view-helpers';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_BANK_ACCOUNTS, SAMPLE_BANK_TRANSACTIONS } from './banking-sample';
import { SAMPLE_TODAY } from './sales-sample';

const ACTIONS: BankingActions = {
  create: createBankAccountAction,
  update: updateBankAccountAction,
  setActive: setBankAccountActiveAction,
};
const TRANSFERS: TransferActions = { record: recordTransferAction, void: voidTransferAction };

/**
 * Accounts, balances and every movement of money. Anyone who may edit adds,
 * changes, archives and restores an account; its opening balance is an
 * owner's or admin's (`sign-off-finance`), as the database enforces. Account
 * numbers are read only for someone who may edit: the database gives nobody
 * else a row. Recording and voiding a transfer are an owner's or admin's
 * too: only they are handed those two actions, so only they are offered
 * "Transfer" and "Void transfer". A viewer and the demo workspace read.
 */
export default async function BankingScreen() {
  if (!hasSupabaseEnv()) {
    return <BankingView accounts={SAMPLE_BANK_ACCOUNTS} rows={SAMPLE_BANK_TRANSACTIONS} today={SAMPLE_TODAY} followClock={false} />;
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const access = bankingAccess(viewer.role, viewer.isDemo);
  const [accounts, rows, numbers, fxRates] = await Promise.all([
    listBankAccounts(ctx),
    listBankTransactions(ctx),
    access.readsNumbers ? listBankAccountNumbers(ctx) : {},
    // The rates are a side card, drawn only for a workspace that deals in another currency: a
    // ringgit-only workspace's Banking does not read them. If they cannot be read, Banking still opens and the
    // card says so.
    workspaceUsesForeignCurrency(ctx.client, ctx.orgId).then((uses) =>
      uses
        ? listLatestFxRates(ctx.client).catch((error: unknown): FxLatestRate[] | null => {
            console.error('[finance] the exchange rates could not be read:', error);
            return null;
          })
        : undefined,
    ),
  ]);
  return (
    <BankingView
      accounts={accounts}
      rows={rows}
      today={todayUtc()}
      fxRates={fxRates}
      fxToday={malaysiaClock(new Date()).date}
      writer={
        access.canEdit
          ? { actions: ACTIONS, canSignOff: access.canSignOff, transfers: access.canTransfer ? TRANSFERS : undefined, numbers }
          : undefined
      }
    />
  );
}
