import { describe, expect, it } from 'vitest';
import { bankingAccess } from '@/lib/finance/banking-access';

describe('bankingAccess: who is given what on Banking', () => {
  it('gives an owner and an admin a writer, the right to transfer and the account numbers', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(bankingAccess(role, false)).toEqual({ canEdit: true, canSignOff: true, canTransfer: true, readsNumbers: true });
    }
  });

  it('gives a member a writer and the account numbers, but no transfers and no sign-off', () => {
    expect(bankingAccess('member', false)).toEqual({ canEdit: true, canSignOff: false, canTransfer: false, readsNumbers: true });
  });

  it('gives a viewer nothing that writes and no account numbers', () => {
    expect(bankingAccess('viewer', false)).toEqual({ canEdit: false, canSignOff: false, canTransfer: false, readsNumbers: false });
  });

  it('gives the demo workspace nothing that writes, whatever its role', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(bankingAccess(role, true)).toEqual({ canEdit: false, canSignOff: false, canTransfer: false, readsNumbers: false });
    }
  });
});
