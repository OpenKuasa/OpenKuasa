import { can } from '@/lib/auth/permissions';
import type { OrgRole } from '@/lib/auth/current-org';

/**
 * Who is given what on Banking. Decided on the server, once, and handed to the view as data: the view offers
 * only what it is given, and the actions and the database still answer for themselves.
 *
 * - `canEdit`: a writer (add or change an account, "New receipt"); reads the account numbers. Never the demo
 *   workspace, never a viewer.
 * - `canSignOff`: an owner or admin who may edit; sets an opening balance.
 * - `canTransfer`: the same people, and only they are handed the two transfer actions.
 */
export function bankingAccess(role: OrgRole, isDemo: boolean): { canEdit: boolean; canSignOff: boolean; canTransfer: boolean; readsNumbers: boolean } {
  const canEdit = !isDemo && can(role, 'edit-data');
  const canSignOff = canEdit && can(role, 'sign-off-finance');
  return { canEdit, canSignOff, canTransfer: canSignOff, readsNumbers: canEdit };
}
