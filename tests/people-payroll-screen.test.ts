import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DRAFT_BANNER,
  PROPOSED_NOTE,
  centsToField,
  deleteDraftSentence,
  deductionsOf,
  earlierOvertimeLine,
  monthInRange,
  markPaidSentence,
  paidLine,
  payslipDetailModel,
  removePayslipSentence,
  runControls,
  runIdFromParam,
  runMonthChoice,
  runPayrollSentence,
  skippedRows,
  undoPaidSentence,
} from '@/lib/people/payroll';
import type { Payslip, PayslipLine } from '@/lib/people/types';

const line = (over: Partial<PayslipLine>): PayslipLine => ({
  id: 'l1',
  payslip_id: 'p1',
  kind: 'earning',
  source: 'hr',
  label: 'Bonus',
  amount_cents: 50_000,
  ...over,
});

const slip = (over: Partial<Payslip> = {}): Payslip => ({
  id: 'p1',
  employee_id: 'e1',
  employee_name: 'Aisyah',
  payroll_run_id: 'r1',
  period_month: '2026-10-01',
  basic_cents: 600_000,
  gross_cents: 650_000,
  epf_cents: 71_500,
  socso_cents: 1_000,
  eis_cents: 500,
  pcb_cents: 20_000,
  other_deductions_cents: 6_000,
  net_cents: 551_000,
  set_by_hr: ['pcb'],
  lines: [
    line({ id: 'a', source: 'joiner', kind: 'unpaid', label: 'Joined 21 Oct 2026', amount_cents: 10_000 }),
    line({ id: 'b', source: 'overtime', label: 'Overtime, 5 Oct 2026, 2 h', amount_cents: 60_000 }),
    line({ id: 'c', source: 'hr', kind: 'deduction', label: 'Uniform', amount_cents: 6_000 }),
  ],
  status: 'pending',
  ...over,
});

describe('runControls', () => {
  it('offers recalculate, mark paid and delete on a draft with payslips', () => {
    expect(runControls({ status: 'draft', headcount: 3 }, { isDemo: false })).toEqual({
      runPayroll: true, recalculate: true, markPaid: true, deleteDraft: true, undoPaid: false,
    });
  });
  it('does not offer mark paid on an empty draft (it cannot be paid), but still offers delete and recalculate', () => {
    const c = runControls({ status: 'draft', headcount: 0 }, { isDemo: false });
    expect(c.markPaid).toBe(false);
    expect(c.deleteDraft).toBe(true);
    expect(c.recalculate).toBe(true);
  });
  it('offers only Undo paid on a paid run', () => {
    expect(runControls({ status: 'paid', headcount: 3 }, { isDemo: false })).toEqual({
      runPayroll: true, recalculate: false, markPaid: false, deleteDraft: false, undoPaid: true,
    });
  });
  it('offers nothing in the demo, with or without a run', () => {
    const none = { runPayroll: false, recalculate: false, markPaid: false, deleteDraft: false, undoPaid: false };
    expect(runControls({ status: 'draft', headcount: 3 }, { isDemo: true })).toEqual(none);
    expect(runControls({ status: 'paid', headcount: 3 }, { isDemo: true })).toEqual(none);
    expect(runControls(null, { isDemo: true })).toEqual(none);
  });
  it('with no run only offers Run payroll', () => {
    expect(runControls(null, { isDemo: false })).toEqual({
      runPayroll: true, recalculate: false, markPaid: false, deleteDraft: false, undoPaid: false,
    });
  });
});

describe('confirmation sentences', () => {
  it('says what Run payroll does', () => {
    expect(runPayrollSentence('October 2026')).toBe(
      "Creates a draft for October 2026. Nobody is paid and employees can't see it yet.",
    );
  });
  it('says what Mark as paid does, singular and plural', () => {
    expect(markPaidSentence(12)).toBe('Marks 12 payslips as paid. Employees will see them.');
    expect(markPaidSentence(1)).toBe('Marks 1 payslip as paid. The employee will see it.');
  });
  it('says what Undo paid, Delete draft and Remove payslip do', () => {
    expect(undoPaidSentence(12)).toBe('Puts 12 payslips back to draft. Employees will no longer see them.');
    expect(undoPaidSentence(1)).toBe('Puts 1 payslip back to draft. The employee will no longer see it.');
    expect(deleteDraftSentence('October 2026', 12)).toBe(
      'Deletes the October 2026 draft and its 12 payslips, with any lines and figures set by hand.',
    );
    expect(deleteDraftSentence('October 2026', 0)).toBe('Deletes the empty October 2026 draft.');
    expect(removePayslipSentence('Aisyah', 'October 2026')).toBe(
      "Removes Aisyah's payslip from the October 2026 draft. Recalculate would bring it back.",
    );
  });
  it('has the draft banner and the proposed note verbatim', () => {
    expect(DRAFT_BANNER).toBe("Draft: employees can't see this yet");
    expect(PROPOSED_NOTE).toBe('Proposed figures. Check them before marking the run as paid.');
  });
});

describe('paidLine', () => {
  it('shows the date in Malaysia time, and the name only when there is one', () => {
    expect(paidLine({ paid_at: '2026-10-09T17:30:00Z', paid_by_name: null })).toBe('Marked as paid on 10 Oct 2026');
    expect(paidLine({ paid_at: '2026-10-09T05:00:00Z', paid_by_name: 'Nora' })).toBe(
      'Marked as paid on 09 Oct 2026 by Nora',
    );
  });
  it('is empty without a paid date', () => {
    expect(paidLine({ paid_at: null, paid_by_name: 'Nora' })).toBe('');
  });
});

describe('skippedRows', () => {
  it('names each person with the reason', () => {
    expect(skippedRows([{ employee_id: 'e', name: 'Ali', reason: 'no_salary' }])).toEqual([
      { id: 'e', name: 'Ali', reason: 'No base salary recorded' },
    ]);
    expect(skippedRows([])).toEqual([]);
  });
});

describe('runIdFromParam', () => {
  it('takes one string, ignores arrays, blanks and nothing', () => {
    expect(runIdFromParam('abc')).toBe('abc');
    expect(runIdFromParam(' abc ')).toBe('abc');
    expect(runIdFromParam(['a', 'b'])).toBe('a');
    expect(runIdFromParam('')).toBeNull();
    expect(runIdFromParam(undefined)).toBeNull();
    expect(runIdFromParam([])).toBeNull();
  });
});

describe('centsToField', () => {
  it('writes a form field value without RM or commas, in integer arithmetic', () => {
    expect(centsToField(120_050)).toBe('1200.50');
    expect(centsToField(5)).toBe('0.05');
    expect(centsToField(0)).toBe('0.00');
    expect(centsToField(100)).toBe('1.00');
  });
});

describe('payslipDetailModel', () => {
  it('carries the row figures as they are, with a deductions total of gross minus net', () => {
    const m = payslipDetailModel(slip());
    expect(m.basic_cents).toBe(600_000);
    expect(m.gross_cents).toBe(650_000);
    expect(m.net_cents).toBe(551_000);
    expect(m.deductions_cents).toBe(99_000);
  });
  it('puts earning and unpaid lines before gross and deduction lines after the four figures, signed', () => {
    const m = payslipDetailModel(slip());
    expect(m.pay_lines.map((l) => [l.label, l.signed_cents])).toEqual([
      ['Joined 21 Oct 2026', -10_000],
      ['Overtime, 5 Oct 2026, 2 h', 60_000],
    ]);
    expect(m.deduction_lines.map((l) => [l.label, l.signed_cents])).toEqual([['Uniform', -6_000]]);
  });
  it('marks system lines as not editable and HR lines as editable', () => {
    const m = payslipDetailModel(slip());
    const all = [...m.pay_lines, ...m.deduction_lines];
    expect(all.map((l) => l.editable)).toEqual([false, false, true]);
    expect(all.map((l) => l.system_note)).toEqual(['Worked out by the system', 'Worked out by the system', null]);
  });
  it('lists EPF, SOCSO, EIS, PCB in order with the set-by-HR mark', () => {
    const m = payslipDetailModel(slip());
    expect(m.figures.map((f) => [f.field, f.label, f.amount_cents, f.set_by_hr])).toEqual([
      ['epf', 'EPF', 71_500, false],
      ['socso', 'SOCSO', 1_000, false],
      ['eis', 'EIS', 500, false],
      ['pcb', 'PCB', 20_000, true],
    ]);
  });
  it('keeps the payslip other deductions as recorded', () => {
    expect(payslipDetailModel(slip()).other_cents).toBe(6_000);
  });
  it('handles a payslip with no lines', () => {
    const m = payslipDetailModel(slip({ lines: [], set_by_hr: [] }));
    expect([m.pay_lines, m.deduction_lines]).toEqual([[], []]);
  });
});

describe('runMonthChoice', () => {
  const run = (period_month: string) => ({ period_month });
  it('lets a workspace with no run choose any month up to this one, starting on this one', () => {
    expect(runMonthChoice([], '2026-10-09')).toEqual({
      kind: 'choose',
      first: '2000-01',
      last: '2026-10',
      default: '2026-10',
    });
  });
  it('fixes the month after the latest run once there is one', () => {
    expect(runMonthChoice([run('2026-08-01'), run('2026-09-01')], '2026-10-09')).toEqual({
      kind: 'fixed',
      month: '2026-10',
    });
  });
  it('fixes a month in the past when the workspace has fallen behind', () => {
    expect(runMonthChoice([run('2026-06-01')], '2026-10-09')).toEqual({ kind: 'fixed', month: '2026-07' });
  });
  it('crosses a year boundary', () => {
    expect(runMonthChoice([run('2026-12-01')], '2027-01-05')).toEqual({ kind: 'fixed', month: '2027-01' });
  });
  it('has nothing to run when the latest run is this month or later', () => {
    expect(runMonthChoice([run('2026-10-01')], '2026-10-09')).toBeNull();
    expect(runMonthChoice([run('2026-11-01')], '2026-10-09')).toBeNull();
  });
});

describe('earlierOvertimeLine', () => {
  it('says nothing for none, and counts claims otherwise', () => {
    expect(earlierOvertimeLine(0)).toBeNull();
    expect(earlierOvertimeLine(1)).toBe('Includes 1 overtime claim from an earlier month.');
    expect(earlierOvertimeLine(3)).toBe('Includes 3 overtime claims from earlier months.');
  });
});

describe('centsToField with a negative', () => {
  it('keeps the minus sign', () => {
    expect(centsToField(-120_050)).toBe('-1200.50');
    expect(centsToField(-5)).toBe('-0.05');
  });
});

describe('deductionsOf', () => {
  it('is the one place a payslip row gets its deductions, and the detail uses it', () => {
    const p = slip();
    expect(deductionsOf(p)).toBe(99_000);
    expect(payslipDetailModel(p).deductions_cents).toBe(deductionsOf(p));
  });
});

describe('monthInRange', () => {
  it('accepts the offered month through this month only', () => {
    expect(monthInRange('2026-08', '2026-08', '2026-10')).toBe(true);
    expect(monthInRange('2026-10', '2026-08', '2026-10')).toBe(true);
    expect(monthInRange('2026-07', '2026-08', '2026-10')).toBe(false);
    expect(monthInRange('2026-11', '2026-08', '2026-10')).toBe(false);
    expect(monthInRange('', '2026-08', '2026-10')).toBe(false);
    expect(monthInRange('2026-13', '2026-08', '2026-12')).toBe(false);
  });
});

/** Every local module `payslip-detail.tsx` reaches, transitively. */
function reachable(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    seen.set(file, source);
    for (const m of source.matchAll(/(?:import|export)\s[^;]*?from\s+'([^']+)'|import\s+'([^']+)'/g)) {
      const spec = m[1] ?? m[2];
      const base = spec.startsWith('@/') ? join(resolve('src'), spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(file), spec) : null;
      if (!base) continue;
      const found = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((e) => base + e).find((p) => existsSync(p));
      if (found) queue.push(found);
    }
  }
  return seen;
}

describe('PayslipDetail is safe to import into a member page', () => {
  const graph = reachable(resolve('src/components/people/payslip-detail.tsx'));
  it('reaches a real set of modules', () => {
    expect(graph.size).toBeGreaterThan(2);
  });
  it('reaches no server action and no editing module', () => {
    for (const [file, source] of graph) {
      expect(file, file).not.toMatch(/payroll-actions|payslip-editor|payslip-line-form|statutory-field/);
      expect(source, file).not.toMatch(/payroll-actions/);
      expect(source, file).not.toMatch(/['"]use server['"]/);
    }
  });
});
