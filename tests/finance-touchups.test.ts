import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteBill, getBill, isIsoDate, postBill, saveBill, saveBillInput, voidBill } from '@/lib/finance/bills';
import { typedNumber } from '@/lib/finance/format';
import {
  deleteScheduledPayment,
  markPaymentPaid,
  recordPaymentOut,
  recordPaymentOutInput,
  voidPayment,
} from '@/lib/finance/money';
import type { FinanceWriteContext } from '@/lib/finance/result';

const ID = '33333333-3333-4333-8333-333333333333';
const SUPPLIER = '44444444-4444-4444-8444-444444444444';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';

/** Answers every request with the same canned result and counts the requests. */
function fakeClient(answer: { data: unknown; error: unknown }) {
  let requests = 0;
  const builder = {
    select: () => builder,
    update: () => builder,
    delete: () => builder,
    eq: () => builder,
    order: () => builder,
    // The payment writes ask the payments-out view for one row before they write.
    limit: () => builder,
    maybeSingle: async () => answer,
    then: (resolve: (value: typeof answer) => void) => resolve(answer),
  };
  const client = {
    rpc: async () => {
      requests += 1;
      return answer;
    },
    from: () => {
      requests += 1;
      return builder;
    },
  };
  return { ctx: { client: client as never, orgId: 'org-1' } satisfies FinanceWriteContext, requests: () => requests };
}

const line = { description: 'Gloves', quantity: 10, unit_price: 12.5 };
const bill = { supplier_id: SUPPLIER, bill_date: '2026-10-01', due_date: '2026-10-31', lines: [line] };
const payment = {
  account_id: ACCOUNT,
  txn_date: '2026-10-05',
  method: 'fpx' as const,
  allocations: [{ bill_id: ID, amount: 100 }],
};

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logged.mockRestore();
});

describe('isIsoDate', () => {
  it('accepts real dates from 1900 to 2200', () => {
    expect(isIsoDate('1900-01-01')).toBe(true);
    expect(isIsoDate('2026-10-11')).toBe(true);
    expect(isIsoDate('2200-12-31')).toBe(true);
  });
  it('refuses a year a slipped key produces', () => {
    expect(isIsoDate('0202-10-11')).toBe(false);
    expect(isIsoDate('1899-12-31')).toBe(false);
    expect(isIsoDate('2201-01-01')).toBe(false);
    expect(isIsoDate('9999-12-31')).toBe(false);
  });
  it('still refuses dates that are not on the calendar', () => {
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('11/10/2026')).toBe(false);
    expect(isIsoDate('')).toBe(false);
  });
  it('is the rule for bill dates and payment dates alike', () => {
    expect(saveBillInput.safeParse({ ...bill, bill_date: '0202-10-01' }).error?.issues[0]?.message).toBe('Enter a valid date.');
    expect(recordPaymentOutInput.safeParse({ ...payment, txn_date: '2201-01-01' }).error?.issues[0]?.message).toBe(
      'Enter a valid date.',
    );
  });
});

describe('a product id on a bill line', () => {
  const first = (product_id: unknown) =>
    saveBillInput.safeParse({ ...bill, lines: [{ ...line, product_id }] }).error?.issues[0]?.message;

  it('says what to do when it is not an id', () => {
    expect(first('not-an-id')).toBe('Choose a product from the list, or leave it empty.');
    expect(first(42)).toBe('Choose a product from the list, or leave it empty.');
  });
  it('still takes an id, an empty string or nothing', () => {
    expect(first(ID)).toBeUndefined();
    expect(first('')).toBeUndefined();
    expect(first(null)).toBeUndefined();
    expect(first(undefined)).toBeUndefined();
  });
});

describe('getBill', () => {
  it('answers null for an id that is not an id, without asking the database', async () => {
    const { ctx, requests } = fakeClient({ data: null, error: { code: '22P02' } });
    expect(await getBill(ctx, 'not-an-id')).toBeNull();
    expect(await getBill(ctx, '')).toBeNull();
    expect(requests()).toBe(0);
  });
  it('answers null when the bill is not in this workspace', async () => {
    const { ctx, requests } = fakeClient({ data: null, error: null });
    expect(await getBill(ctx, ID)).toBeNull();
    expect(requests()).toBe(1);
  });
});

describe('refusals every finance write can meet', () => {
  const cases: [string, string][] = [
    ['42501', 'You do not have permission to make changes here.'],
    ['22003', 'That amount is too large.'],
  ];

  it('become sentences on bills', async () => {
    for (const [code, message] of cases) {
      const { ctx } = fakeClient({ data: null, error: { code } });
      expect(await saveBill(ctx, bill), code).toEqual({ ok: false, error: message });
      expect(await postBill(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await voidBill(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await deleteBill(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
    }
    expect(logged).not.toHaveBeenCalled();
  });

  it('become sentences on payments', async () => {
    for (const [code, message] of cases) {
      const { ctx } = fakeClient({ data: null, error: { code } });
      expect(await recordPaymentOut(ctx, payment), code).toEqual({ ok: false, error: message });
      expect(await markPaymentPaid(ctx, { id: ID, paid_on: '2026-10-09' }), code).toEqual({ ok: false, error: message });
      expect(await voidPayment(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
      expect(await deleteScheduledPayment(ctx, { id: ID }), code).toEqual({ ok: false, error: message });
    }
    expect(logged).not.toHaveBeenCalled();
  });
});

describe('typedNumber', () => {
  it('reads plain numbers', () => {
    expect(typedNumber('1200.50')).toBe(1200.5);
    expect(typedNumber(' 12 ')).toBe(12);
    expect(typedNumber('0')).toBe(0);
    expect(typedNumber('.5')).toBe(0.5);
    expect(typedNumber('5.')).toBe(5);
    expect(typedNumber('-3')).toBe(-3);
  });
  it('refuses an amount typed with a comma instead of reading part of it', () => {
    expect(typedNumber('1,200.50')).toBeNull();
    expect(typedNumber('1,5')).toBeNull();
  });
  it('refuses an empty box and anything that is not a plain number', () => {
    expect(typedNumber('')).toBeNull();
    expect(typedNumber('   ')).toBeNull();
    expect(typedNumber('RM 12')).toBeNull();
    expect(typedNumber('1e3')).toBeNull();
    expect(typedNumber('0x10')).toBeNull();
    expect(typedNumber('Infinity')).toBeNull();
    expect(typedNumber('.')).toBeNull();
  });
});
