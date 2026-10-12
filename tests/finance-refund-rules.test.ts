import { describe, expect, it } from 'vitest';
import type { RefundRow } from '@/lib/finance/refunds';
import { REFUND_STATUS_LABELS, isPendingRefund, refundActions, refundName } from '@/lib/finance/sales-followon-views';

const refund = (status: RefundRow['status'], r: Partial<RefundRow> = {}): RefundRow => ({
  allocation_id: 'a-1',
  transaction_id: 't-1',
  number: status === 'posted' || status === 'void' ? 'PV-0004' : null,
  txn_date: '2026-10-07',
  method: 'fpx',
  amount: 30,
  transaction_amount: 30,
  status,
  reference: null,
  reason: 'damaged_goods',
  notes: null,
  account_id: 'bank',
  account_name: 'Main Bank',
  invoice_id: 'invoice-1',
  invoice_no: 'INV-0007',
  credit_note_id: null,
  credit_note_no: null,
  customer_id: 'aisyah',
  customer_name: 'Aisyah Trading',
  ...r,
});

describe('refundActions', () => {
  it('lets a pending refund be marked as paid or deleted, and never voided', () => {
    expect(refundActions(refund('scheduled'))).toEqual(['markPaid', 'delete']);
  });
  it('lets a refund that was paid out be voided, and nothing else: it is locked', () => {
    expect(refundActions(refund('posted'))).toEqual(['void']);
  });
  it('offers nothing on a void refund, nor on one in a state the app never makes', () => {
    // The database marks only a scheduled payment as paid; a draft or one waiting for approval is refused (FIN09).
    for (const status of ['void', 'draft', 'pending_approval', 'rejected'] as const) {
      expect(refundActions(refund(status)), status).toEqual([]);
    }
  });
  it('offers nothing but mark as paid, void and delete on any refund: there is no edit, a pending one is deleted and recorded again', () => {
    const known: string[] = ['markPaid', 'void', 'delete'];
    for (const status of ['scheduled', 'posted', 'void', 'draft', 'pending_approval', 'rejected'] as const) {
      const offered: string[] = refundActions(refund(status));
      expect(offered.filter((action) => !known.includes(action)), status).toEqual([]);
    }
  });
});

describe('refundName', () => {
  it('names a refund by its voucher number and customer, and one not yet paid out as still to be paid', () => {
    expect(refundName(refund('posted'))).toBe('PV-0004 to Aisyah Trading');
    expect(refundName(refund('scheduled'))).toBe('the refund still to be paid to Aisyah Trading');
  });
});

describe('a refund still being written', () => {
  it('counts and reads as to be paid, like a scheduled one', () => {
    expect(isPendingRefund(refund('draft'))).toBe(true);
    expect(REFUND_STATUS_LABELS.draft).toBe(REFUND_STATUS_LABELS.scheduled);
  });
});
