import { describe, expect, it } from 'vitest';
import { overtimeAmountText, overtimeCalculated, overtimeCancelOffered, overtimeModel, overtimePaidText, paidOvertimeById } from '@/lib/people/overtime';
import { createSeedPeopleData } from '@/lib/people/seed';
import type { OvertimeRecord } from '@/lib/people/types';

const NOW = new Date('2026-10-09T04:00:00Z');
const TODAY = '2026-10-09';
const data = createSeedPeopleData(NOW);

const record = (over: Partial<OvertimeRecord>): OvertimeRecord => ({
  id: 'r', employee_id: 'e1', employee_name: 'E', work_date: '2026-10-02', hours: 1, rate_multiplier: 1.5,
  amount_cents: 3750, hourly_rate_cents: 2500, day_kind: null, reason: null, decision_note: null, status: 'approved', created_at: '2026-10-02T00:00:00Z', paid_month: null, ...over,
});

describe('overtimeModel on the sample data', () => {
  it('splits this month into approved and pending, and counts the queue across all dates', async () => {
    const model = overtimeModel(await data.listOvertime(), await data.listEmployees(), TODAY);
    expect(model.month.approved_hours).toBe(9);
    expect(model.month.pending_hours).toBe(4);
    expect(model.month.pending_count).toBe(1);
    expect(model.month.hours).toBe(13);
    expect(model.people_with_overtime).toBe(5);
    expect(model.month.amount_cents).toBe(48750);
  });

  it('has six months of hours, oldest first, with the rejected record left out', async () => {
    const model = overtimeModel(await data.listOvertime(), await data.listEmployees(), TODAY);
    expect(model.by_month.map((b) => b.label)).toEqual(['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    expect(model.by_month.at(-1)!.value).toBe(13);
    // September: 2 + 5 + 2.5 + 4 + 3 + 2.5 hours; the 3 rejected hours are not in it.
    expect(model.by_month.find((b) => b.label === 'Sep')!.value).toBe(19);
  });

  it('lists only the rates present', async () => {
    const model = overtimeModel(await data.listOvertime(), await data.listEmployees(), TODAY);
    expect(model.by_rate.map((r) => r.label)).toEqual(['1.5x', '2x']);
    const hours = model.by_rate.reduce((total, r) => total + r.hours, 0);
    expect(hours).toBe(model.by_month.reduce((total, b) => total + b.value, 0));
  });

  it("puts the pending hours under the employee's department", async () => {
    const model = overtimeModel(await data.listOvertime(), await data.listEmployees(), TODAY);
    expect(model.by_department).toEqual([{ department: 'Operations', hours: 4 }]);
  });

  it("has no departments when the records are one person's", async () => {
    const model = overtimeModel(await data.listOvertime(), [], TODAY);
    expect(model.by_department).toEqual([]);
    expect(model.month.pending_hours).toBe(4);
  });
});

describe('overtimeModel on other rows', () => {
  it('is all zeros and empty lists on no rows', () => {
    const model = overtimeModel([], [], TODAY);
    expect(model.month).toEqual({ hours: 0, amount_cents: 0, approved_hours: 0, pending_hours: 0, pending_count: 0 });
    expect(model.by_month).toHaveLength(6);
    expect(model.by_month.every((b) => b.value === 0)).toBe(true);
    expect(model.by_rate).toEqual([]);
    expect(model.by_department).toEqual([]);
    expect(model.people_with_overtime).toBe(0);
    expect(JSON.stringify(model)).not.toContain('null');
  });

  it('feeds nothing from rejected or cancelled records', () => {
    const model = overtimeModel(
      [record({ status: 'rejected', hours: 9 }), record({ status: 'cancelled', hours: 9 })],
      [],
      TODAY,
    );
    expect(model.month.hours).toBe(0);
    expect(model.by_rate).toEqual([]);
    expect(model.people_with_overtime).toBe(0);
  });

  it('counts a pending record from an earlier month in the queue but not in the month', () => {
    const model = overtimeModel([record({ status: 'pending', work_date: '2026-08-14', hours: 3 })], [], TODAY);
    expect(model.month).toMatchObject({ hours: 0, pending_hours: 3, pending_count: 1 });
    expect(model.by_month.find((b) => b.label === 'Aug')!.value).toBe(3);
  });
});

describe('overtimeCalculated', () => {
  it('is false only when there is no rate and no amount', () => {
    expect(overtimeCalculated({ hourly_rate_cents: null, amount_cents: 0 })).toBe(false);
    expect(overtimeCalculated({ hourly_rate_cents: null, amount_cents: 7500 })).toBe(true);
    expect(overtimeCalculated({ hourly_rate_cents: 2500, amount_cents: 7500 })).toBe(true);
    expect(overtimeCalculated({ hourly_rate_cents: 0, amount_cents: 0 })).toBe(true);
  });

  it('words the amount: a row made before the rate was stored keeps its amount', () => {
    expect(overtimeAmountText(record({ hourly_rate_cents: null, amount_cents: 7500 }))).toBe('RM 75.00');
    expect(overtimeAmountText(record({ hourly_rate_cents: null, amount_cents: 0 }))).toBe('Not calculated');
  });
});

describe('a record a paid payroll run took', () => {
  it('reads "Paid" with the month, and nothing when no paid run took it', () => {
    expect(overtimePaidText({ paid_month: '2026-10' })).toBe('Paid, October 2026');
    expect(overtimePaidText({ paid_month: '2026-01' })).toBe('Paid, January 2026');
    expect(overtimePaidText({ paid_month: null })).toBeNull();
  });

  it('maps only the paid records by id', () => {
    const map = paidOvertimeById([
      record({ id: 'a', paid_month: '2026-09' }),
      record({ id: 'b', paid_month: null }),
    ]);
    expect([...map]).toEqual([['a', 'Paid, September 2026']]);
  });

  it('offers no Cancel on a paid record, even one whose status would allow it', () => {
    expect(overtimeCancelOffered(true, 'Paid, October 2026')).toBe(false);
    expect(overtimeCancelOffered(true, null)).toBe(true);
    expect(overtimeCancelOffered(true, undefined)).toBe(true);
    expect(overtimeCancelOffered(false, null)).toBe(false);
  });
});
