import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { OrgRole } from '@/lib/auth/current-org';
import { type AttachedReceipt, attachedReceiptsOrNone, offeredContacts, receiptInboxPlan } from '@/lib/finance/receipt-match';

const read = (path: string) => readFileSync(path, 'utf8');

describe('what the Receipts Inbox screen reads and who is given a writer', () => {
  const plan = (role: OrgRole, isDemo = false, hasReceipts = true) => receiptInboxPlan({ role, isDemo }, hasReceipts);

  it('an owner and an admin: a writer who may decide', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(plan(role)).toEqual({ canEdit: true, canDecide: true, readsDocuments: true, readsForms: true });
    }
  });

  it('a member: a writer who may not decide', () => {
    expect(plan('member')).toEqual({ canEdit: true, canDecide: false, readsDocuments: true, readsForms: true });
  });

  it('a viewer: no writer, but the documents are read for the second line', () => {
    expect(plan('viewer')).toEqual({ canEdit: false, canDecide: false, readsDocuments: true, readsForms: false });
  });

  it('the demo is given no writer whatever its role, and may not decide', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(plan(role, true)).toEqual({ canEdit: false, canDecide: false, readsDocuments: true, readsForms: false });
    }
  });

  it('with no receipt nothing is read', () => {
    for (const role of ['owner', 'member', 'viewer'] as const) {
      expect(plan(role, false, false)).toMatchObject({ readsDocuments: false, readsForms: false });
    }
  });
});

describe('which contacts the forms offer', () => {
  const contacts = [
    { id: 'a', name: 'Active supplier', active: true, is_supplier: true },
    { id: 'b', name: 'Archived supplier', active: false, is_supplier: true },
    { id: 'c', name: 'Active customer', active: true, is_supplier: false },
  ];

  it('never an archived one, and the bill form only suppliers', () => {
    const offered = offeredContacts(contacts);
    expect(offered.contacts).toEqual([
      { id: 'a', name: 'Active supplier' },
      { id: 'c', name: 'Active customer' },
    ]);
    expect(offered.suppliers.map((c) => c.id)).toEqual(['a']);
  });
});

describe('a failed read of the paperclips', () => {
  const one: AttachedReceipt = {
    id: 'r1',
    file_name: 'a.png',
    mime_type: 'image/png',
    has_file: true,
    expense_id: 'e1',
    bill_id: null,
  };

  it('gives what was read when it works', async () => {
    const log = vi.fn();
    expect(await attachedReceiptsOrNone(async () => [one], log)).toEqual([one]);
    expect(log).not.toHaveBeenCalled();
  });

  it('gives no paperclips and logs on the server when it throws, so the page still loads', async () => {
    const log = vi.fn();
    const boom = new Error('view unreadable');
    expect(
      await attachedReceiptsOrNone(async () => {
        throw boom;
      }, log),
    ).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][1]).toBe(boom);
  });
});

describe('the inbox loader uses the plan', () => {
  it('gives the writer and the decision only from the plan, reads documents and forms by it, and offers only active contacts', () => {
    const source = read('src/screens/finance/receipts-inbox.tsx');
    expect(source).toContain('receiptInboxPlan(viewer, rows.length > 0)');
    expect(source).toContain('plan.canEdit\n');
    expect(source).toContain('canDecide: plan.canDecide');
    expect(source).toContain('plan.readsDocuments ? listAttachedReceipts(ctx)');
    expect(source).toContain('plan.readsDocuments ? listExpenses(ctx)');
    expect(source).toContain('plan.readsDocuments ? listBills(ctx)');
    expect(source).toContain('plan.readsForms ? listContacts(ctx)');
    expect(source).toContain('offeredContacts(contacts)');
    expect(source).not.toMatch(/can\(viewer\.role/);
  });
});
