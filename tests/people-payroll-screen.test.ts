import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DRAFT_BANNER,
  PROPOSED_NOTE,
  centsToField,
  deleteDraftSentence,
  deductionsOf,
  draftBlocksRun,
  earlierOvertimeCount,
  earlierOvertimeLine,
  emptyRunNote,
  runOptionLabel,
  runCreatedSentence,
  recalculateNote,
  headcountNote,
  monthInRange,
  notOnRun,
  notOnRunLine,
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
  it('offers mark paid on an empty draft too: a month with nobody to pay is a real record', () => {
    const c = runControls({ status: 'draft', headcount: 0 }, { isDemo: false });
    expect(c.markPaid).toBe(true);
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
    expect(markPaidSentence(12, 'October 2026')).toBe('Marks 12 payslips as paid. Employees will see them.');
    expect(markPaidSentence(1, 'October 2026')).toBe('Marks 1 payslip as paid. The employee will see it.');
  });
  it('says what Mark as paid does on a run with nobody on it', () => {
    expect(markPaidSentence(0, 'October 2026')).toBe('Marks October 2026 as paid with no payslips. The next month can then be run.');
    expect(undoPaidSentence(0, 'October 2026')).toBe('Puts October 2026 back to draft.');
  });
  it('says what Undo paid, Delete draft and Remove payslip do', () => {
    expect(undoPaidSentence(12, 'October 2026')).toBe('Puts 12 payslips back to draft. Employees will no longer see them.');
    expect(undoPaidSentence(1, 'October 2026')).toBe('Puts 1 payslip back to draft. The employee will no longer see it.');
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

describe('empty runs', () => {
  it('says what an empty draft and an empty paid run mean', () => {
    expect(emptyRunNote({ status: 'draft', headcount: 0, label: 'October 2026' })).toBe(
      'Nobody is on this run. Mark it as paid to record that nothing was paid this month, or delete it.',
    );
    expect(emptyRunNote({ status: 'paid', headcount: 0, label: 'October 2026' })).toBe('Nothing was paid for October 2026.');
    expect(emptyRunNote({ status: 'draft', headcount: 2, label: 'October 2026' })).toBeNull();
    expect(emptyRunNote({ status: 'paid', headcount: 2, label: 'October 2026' })).toBeNull();
  });
});

describe('headcountNote', () => {
  it('reads "On this run" on a draft and the paid count otherwise', () => {
    expect(headcountNote({ status: 'draft', headcount: 3, paid_count: 0 })).toBe('On this run');
    expect(headcountNote({ status: 'paid', headcount: 3, paid_count: 3 })).toBe('3 of 3 payslips paid');
  });
});

describe('draftBlocksRun', () => {
  const r = (period_month: string, status: 'draft' | 'paid') => ({ period_month, status });
  it('blocks running the next month while the latest run is a draft, and says which', () => {
    expect(draftBlocksRun([r('2026-08-01', 'paid'), r('2026-09-01', 'draft')])).toBe(
      'Mark September 2026 as paid or delete it before running the next month.',
    );
  });
  it('does not block when the latest run is paid, or there are none', () => {
    expect(draftBlocksRun([r('2026-08-01', 'draft'), r('2026-09-01', 'paid')])).toBeNull();
    expect(draftBlocksRun([])).toBeNull();
  });
});

describe('earlierOvertimeCount', () => {
  const ot = (work_date: string | null, source: 'overtime' | 'hr' = 'overtime') =>
    line({ id: `l-${work_date}-${source}`, source, work_date, label: 'x' });
  it('counts overtime lines for work before the month, across payslips', () => {
    const slips = [
      slip({ id: 'a', lines: [ot('2026-09-30'), ot('2026-10-01'), ot('2026-10-31')] }),
      slip({ id: 'b', lines: [ot('2026-08-15'), ot('2026-09-02')] }),
    ];
    expect(earlierOvertimeCount(slips, '2026-10-01')).toBe(3);
    expect(earlierOvertimeCount(slips, '2026-10')).toBe(3);
  });
  it('ignores lines with no date and lines that are not overtime', () => {
    expect(earlierOvertimeCount([slip({ lines: [ot(null), ot('2026-01-01', 'hr')] })], '2026-10-01')).toBe(0);
  });
  it('drops when a payslip is removed', () => {
    const a = slip({ id: 'a', lines: [ot('2026-09-30')] });
    const b = slip({ id: 'b', lines: [ot('2026-09-29')] });
    expect(earlierOvertimeCount([a, b], '2026-10-01')).toBe(2);
    expect(earlierOvertimeCount([a], '2026-10-01')).toBe(1);
  });
});

describe('notOnRun', () => {
  const emp = (id: string, name: string, status: 'active' | 'inactive' = 'active', join_date: string | null = '2025-01-01') =>
    ({ id, name, status, join_date }) as never;
  it('names active employees with no payslip on the run, by name', () => {
    const slips = [slip({ employee_id: 'e1', payroll_run_id: 'r1' })];
    const list = [emp('e1', 'Aisyah'), emp('e2', 'Zul'), emp('e3', 'Ben'), emp('e4', 'Gone', 'inactive')];
    expect(notOnRun(list, slips, 'r1', '2026-10-01')).toEqual(['Ben', 'Zul']);
  });
  it('does not count a payslip on another run, or someone who joins after the month', () => {
    const slips = [slip({ employee_id: 'e1', payroll_run_id: 'r0' })];
    const list = [emp('e1', 'Aisyah'), emp('e2', 'Late', 'active', '2026-11-03')];
    expect(notOnRun(list, slips, 'r1', '2026-10-01')).toEqual(['Aisyah']);
  });
  it('says it in a sentence, singular and plural', () => {
    expect(notOnRunLine([])).toBeNull();
    expect(notOnRunLine(['Ben'])).toBe('1 active employee is not on this run: Ben.');
    expect(notOnRunLine(['Ben', 'Zul'])).toBe('2 active employees are not on this run: Ben, Zul.');
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
      expect(file, file).not.toMatch(/payroll-actions|payslip-editor|payslip-line-form|components\/people\/statutory-field\.tsx/);
      expect(source, file).not.toMatch(/payroll-actions/);
      expect(source, file).not.toMatch(/['"]use server['"]/);
    }
  });
});

describe('runCreatedSentence', () => {
  it('says what a run with payslips and a run with nobody on it created', () => {
    expect(runCreatedSentence('October 2026', 3)).toBe('Draft created for October 2026 with 3 payslips. Check it, then mark it as paid.');
    expect(runCreatedSentence('October 2026', 1)).toBe('Draft created for October 2026 with 1 payslip. Check it, then mark it as paid.');
    expect(runCreatedSentence('October 2026', 0)).toBe(
      'Draft created for October 2026 with no payslips: nobody active has a base salary recorded. Mark it as paid to record that nothing was paid, or add salaries and recalculate.',
    );
  });
});

describe('recalculateNote', () => {
  it('says how many payslips were added', () => {
    expect(recalculateNote(0)).toBe('Recalculated. No new payslips.');
    expect(recalculateNote(1)).toBe('Recalculated. 1 payslip added.');
    expect(recalculateNote(4)).toBe('Recalculated. 4 payslips added.');
    expect(recalculateNote(undefined)).toBe('Recalculated. No new payslips.');
  });
});

describe('runOptionLabel', () => {
  it('labels a run for the picker, saying so when it has no payslips', () => {
    expect(runOptionLabel({ label: 'October 2026', status: 'draft', headcount: 0 })).toBe('October 2026 · Draft · no payslips');
    expect(runOptionLabel({ label: 'September 2026', status: 'paid', headcount: 0 })).toBe('September 2026 · Paid · no payslips');
    expect(runOptionLabel({ label: 'August 2026', status: 'paid', headcount: 4 })).toBe('August 2026 · Paid');
    expect(runOptionLabel({ label: 'October 2026', status: 'draft', headcount: 4 })).toBe('October 2026 · Draft');
  });
});
