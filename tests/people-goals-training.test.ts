import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canMarkCompleted,
  courseRemoval,
  enrolCandidates,
  enrolmentRemoval,
  goalCardView,
  goalProgressInput,
  goalsByEmployee,
  memberCourseControl,
  myGoalsControls,
  showGoalsAction,
  trainingScreenControls,
  typedProgress,
} from '@/lib/people/goals-training';
import type { Employee, Goal } from '@/lib/people/types';

const course = { starts_on: '2026-10-10', ends_on: '2026-10-12' };
const WHO = { linked: true, isDemo: false };

describe('memberCourseControl', () => {
  const at = (today: string, enrolment: { completed: boolean } | null, who = WHO) =>
    memberCourseControl(course, enrolment, today, who);

  it('offers Enrol up to and including the last day, and nothing the day after', () => {
    expect(at('2026-10-09', null)).toBe('enrol');
    expect(at('2026-10-10', null)).toBe('enrol');
    expect(at('2026-10-12', null)).toBe('enrol');
    expect(at('2026-10-13', null)).toBe('none');
  });
  it('offers Withdraw until the course starts, then says "enrolled"', () => {
    expect(at('2026-10-09', { completed: false })).toBe('withdraw');
    expect(at('2026-10-10', { completed: false })).toBe('enrolled');
    expect(at('2026-10-20', { completed: false })).toBe('enrolled');
  });
  it('says Completed once marked, even before the course starts', () => {
    expect(at('2026-10-11', { completed: true })).toBe('completed');
    expect(at('2026-10-09', { completed: true })).toBe('completed');
  });
  it('shows nothing to an unlinked account or in the demo', () => {
    expect(at('2026-10-09', null, { linked: false, isDemo: false })).toBe('none');
    expect(at('2026-10-09', { completed: false }, { linked: false, isDemo: false })).toBe('none');
    expect(at('2026-10-09', null, { linked: true, isDemo: true })).toBe('none');
  });
  it('treats a course with no dates as upcoming and open to enrol', () => {
    expect(memberCourseControl({ starts_on: null, ends_on: null }, null, '2026-10-11', WHO)).toBe('enrol');
    expect(memberCourseControl({ starts_on: null, ends_on: null }, { completed: false }, '2026-10-11', WHO)).toBe('withdraw');
  });
  it('gives the one expected control on every day around the course', () => {
    const none = null;
    const open = { completed: false };
    const done = { completed: true };
    const table: [string, typeof none | typeof open | typeof done, string][] = [
      ['2026-10-08', none, 'enrol'],
      ['2026-10-09', none, 'enrol'],
      ['2026-10-10', none, 'enrol'],
      ['2026-10-11', none, 'enrol'],
      ['2026-10-12', none, 'enrol'],
      ['2026-10-13', none, 'none'],
      ['2026-10-08', open, 'withdraw'],
      ['2026-10-09', open, 'withdraw'],
      ['2026-10-10', open, 'enrolled'],
      ['2026-10-12', open, 'enrolled'],
      ['2026-10-13', open, 'enrolled'],
      ['2026-10-09', done, 'completed'],
      ['2026-10-10', done, 'completed'],
      ['2026-10-13', done, 'completed'],
    ];
    for (const [today, enrolment, expected] of table) expect(at(today, enrolment), `${today} ${JSON.stringify(enrolment)}`).toBe(expected);
  });
  it('compares only the date a one-date course has', () => {
    expect(memberCourseControl({ starts_on: '2026-10-10', ends_on: null }, null, '2027-01-01', WHO)).toBe('enrol');
    expect(memberCourseControl({ starts_on: null, ends_on: '2026-10-12' }, null, '2026-10-13', WHO)).toBe('none');
    expect(memberCourseControl({ starts_on: null, ends_on: '2026-10-12' }, { completed: false }, '2026-10-13', WHO)).toBe('withdraw');
  });
});

describe('canMarkCompleted', () => {
  it('needs the course to have started', () => {
    expect(canMarkCompleted(course, '2026-10-09')).toBe(false);
    expect(canMarkCompleted(course, '2026-10-10')).toBe(true);
    expect(canMarkCompleted(course, '2026-10-30')).toBe(true);
  });
});

describe('courseRemoval', () => {
  it('allows removal when nobody is completed', () => {
    expect(courseRemoval([{ completed: false }, { completed: false }])).toEqual({ allowed: true, reason: null });
    expect(courseRemoval([])).toEqual({ allowed: true, reason: null });
  });
  it('says why, counting from the data', () => {
    const one = courseRemoval([{ completed: true }, { completed: false }]);
    expect(one.allowed).toBe(false);
    expect(one.reason).toBe('1 person is marked as completed. Undo that first to remove the course.');
    const two = courseRemoval([{ completed: true }, { completed: true }]);
    expect(two.reason).toBe('2 people are marked as completed. Undo that first to remove the course.');
  });
});

describe('enrolmentRemoval', () => {
  it('blocks a completed person with the reason, and allows the rest', () => {
    expect(enrolmentRemoval({ completed: true })).toEqual({
      allowed: false,
      reason: 'Marked as completed. Undo that first to remove them.',
    });
    expect(enrolmentRemoval({ completed: false })).toEqual({ allowed: true, reason: null });
  });
});

describe('enrolCandidates', () => {
  const emp = (id: string, name: string, status: 'active' | 'inactive' = 'active') => ({ id, name, status }) as Employee;
  it('lists active employees not yet enrolled, by name', () => {
    const list = enrolCandidates(
      [emp('3', 'Zara'), emp('1', 'Aina'), emp('2', 'Budi'), emp('4', 'Old', 'inactive')],
      [{ employee_id: '2' }],
    );
    expect(list).toEqual([
      { id: '1', name: 'Aina' },
      { id: '3', name: 'Zara' },
    ]);
  });
  it('is empty when everyone is enrolled', () => {
    expect(enrolCandidates([emp('1', 'Aina')], [{ employee_id: '1' }])).toEqual([]);
  });
});

describe('goal card', () => {
  it('reads Done at 100 whatever the stored status, and hides the at-risk choice', () => {
    expect(goalCardView({ progress: 100, status: 'done' })).toEqual({ done: true, label: 'Done', showAtRisk: false });
    expect(goalCardView({ progress: 100, status: 'at_risk' })).toEqual({ done: true, label: 'Done', showAtRisk: false });
    expect(goalCardView({ progress: 40, status: 'at_risk' })).toEqual({ done: false, label: 'At risk', showAtRisk: true });
    expect(goalCardView({ progress: 0, status: 'on_track' })).toEqual({ done: false, label: 'On track', showAtRisk: true });
  });
  it('shows the choice again when a done goal is retyped below 100', () => {
    expect(goalCardView({ progress: typedProgress('80', 100), status: 'done' }).showAtRisk).toBe(true);
    expect(goalCardView({ progress: typedProgress(' 100 ', 20), status: 'on_track' }).showAtRisk).toBe(false);
  });
  it('reads typed progress only when it is a whole number, else keeps the saved one', () => {
    expect(typedProgress('55', 10)).toBe(55);
    expect(typedProgress('', 10)).toBe(10);
    expect(typedProgress('abc', 10)).toBe(10);
    expect(typedProgress('5.5', 10)).toBe(10);
    expect(typedProgress('1000', 10)).toBe(10);
  });
  const goal = { id: 'g1', title: 'Ship it', progress: 20, due_date: '2026-12-01', status: 'at_risk' as const };
  it('saves a progress change keeping the title and due date', () => {
    expect(goalProgressInput(goal, '55', true)).toEqual({
      ok: true,
      input: { goal_id: 'g1', title: 'Ship it', progress: 55, due_date: '2026-12-01', at_risk: true },
    });
  });
  it('never sends at-risk for a finished goal', () => {
    const done = goalProgressInput(goal, '100', true);
    expect(done).toEqual({
      ok: true,
      input: { goal_id: 'g1', title: 'Ship it', progress: 100, due_date: '2026-12-01', at_risk: false },
    });
  });
  it('refuses progress that is not a whole number from 0 to 100', () => {
    for (const bad of ['', '101', '-1', '5.5', 'abc', '1e1']) {
      const result = goalProgressInput(goal, bad, false);
      expect(result.ok, bad).toBe(false);
    }
  });
  it('keeps a goal with no due date as none', () => {
    const result = goalProgressInput({ ...goal, due_date: null }, '10', false);
    expect(result).toEqual({ ok: true, input: { goal_id: 'g1', title: 'Ship it', progress: 10, due_date: null, at_risk: false } });
  });
});

describe('goalsByEmployee', () => {
  const g = (id: string, employee_id: string, due_date: string | null, title: string): Goal => ({
    id,
    employee_id,
    employee_name: 'x',
    title,
    progress: 10,
    due_date,
    status: 'on_track',
  });
  it('groups by employee, dated goals first by date, then undated by title', () => {
    const grouped = goalsByEmployee([
      g('1', 'a', null, 'B'),
      g('2', 'a', '2026-12-01', 'Z'),
      g('3', 'b', null, 'Only'),
      g('4', 'a', '2026-11-01', 'Y'),
      g('5', 'a', null, 'A'),
    ]);
    expect(grouped.a.map((x) => x.id)).toEqual(['4', '2', '5', '1']);
    expect(grouped.b.map((x) => x.id)).toEqual(['3']);
    expect(grouped.c).toBeUndefined();
  });
});

/** Every local module an entry reaches, transitively. */
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

const ACTIONS_FILE = resolve('src/app/(app)/people/performance-actions.ts');
const OWN_ACTIONS = ['saveMyGoalAction', 'deleteMyGoalAction', 'enrolMeAction', 'withdrawMeAction'];
const exportedActions = readFileSync(ACTIONS_FILE, 'utf8')
  .split('\n')
  .map((line) => /^export async function (\w+)/.exec(line)?.[1])
  .filter((name): name is string => Boolean(name));
// Owner-only = every action the module exports except the member's own four; read from the file, not listed by hand.
const OWNER_ONLY = exportedActions.filter((name) => !OWN_ACTIONS.includes(name));

describe('the member-only components name no owner-only action', () => {
  it('reads a real list of actions from the module', () => {
    for (const name of OWN_ACTIONS) expect(exportedActions).toContain(name);
    expect(OWNER_ONLY.length).toBeGreaterThanOrEqual(7);
    expect(OWNER_ONLY).toContain('saveGoalForAction');
    expect(OWNER_ONLY).toContain('enrolAction');
  });
  // goal-form.tsx is shared by the own-record and owner paths; it takes its action as a prop and imports none.
  for (const entry of [
    'src/components/people/goal-card-controls.tsx',
    'src/components/people/goal-form.tsx',
    'src/components/people/enrol-buttons.tsx',
    'src/screens/people/my-goals.tsx',
  ]) {
    it(`${entry} and what it imports name no owner-only action`, () => {
      const graph = reachable(resolve(entry));
      expect(graph.size).toBeGreaterThan(2);
      for (const [file, source] of graph) {
        if (file === ACTIONS_FILE) continue; // the module that defines them
        for (const name of OWNER_ONLY) expect(source, `${file} names ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
      }
    });
  }
  it('the components that import from the actions module take only the own actions', () => {
    for (const entry of ['src/components/people/enrol-buttons.tsx', 'src/screens/people/my-goals.tsx']) {
      const source = readFileSync(resolve(entry), 'utf8');
      const imported = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*performance-actions'/g)].flatMap((m) =>
        m[1].split(',').map((x) => x.trim()).filter(Boolean),
      );
      expect(imported.length, entry).toBeGreaterThan(0);
      for (const name of imported) expect(OWN_ACTIONS, entry).toContain(name);
    }
  });
});

describe('what each screen renders for each kind of viewer', () => {
  const viewers = {
    owner: { isHr: true, isDemo: false, employeeId: 'e1' },
    admin: { isHr: true, isDemo: false, employeeId: null },
    member: { isHr: false, isDemo: false, employeeId: 'e2' },
    readOnlyViewer: { isHr: false, isDemo: false, employeeId: 'e3' },
    unlinked: { isHr: false, isDemo: false, employeeId: null },
    demoVisitor: { isHr: false, isDemo: true, employeeId: null },
    demoAdmin: { isHr: true, isDemo: true, employeeId: 'e4' },
  };

  it('Training: owner controls only for an owner or admin outside the demo', () => {
    const owner = Object.entries(viewers).filter(([, v]) => trainingScreenControls(v, true).owner).map(([k]) => k);
    expect(owner).toEqual(['owner', 'admin']);
  });
  it('Training: no owner control while nothing loaded', () => {
    expect(trainingScreenControls(viewers.owner, false)).toEqual({ owner: false, demoPlaceholders: false, memberEnrol: false });
  });
  it('Training: a member gets the enrol column only when linked; the demo gets placeholders and nothing live', () => {
    expect(trainingScreenControls(viewers.member, true)).toEqual({ owner: false, demoPlaceholders: false, memberEnrol: true });
    expect(trainingScreenControls(viewers.readOnlyViewer, true).memberEnrol).toBe(true);
    expect(trainingScreenControls(viewers.unlinked, true)).toEqual({ owner: false, demoPlaceholders: false, memberEnrol: false });
    expect(trainingScreenControls(viewers.demoVisitor, true)).toEqual({ owner: false, demoPlaceholders: true, memberEnrol: false });
    expect(trainingScreenControls(viewers.demoAdmin, true)).toEqual({ owner: false, demoPlaceholders: true, memberEnrol: false });
    expect(trainingScreenControls(viewers.owner, true).memberEnrol).toBe(false);
    expect(trainingScreenControls(viewers.admin, true).memberEnrol).toBe(false);
  });
  it('My Goals: own controls for a linked non-demo account; none for unlinked or the demo', () => {
    expect(myGoalsControls(viewers.member, { linked: true })).toEqual({ cards: true, add: true, placeholder: false });
    expect(myGoalsControls(viewers.unlinked, { linked: false })).toEqual({ cards: true, add: false, placeholder: false });
    expect(myGoalsControls(viewers.demoVisitor, { linked: true })).toEqual({ cards: false, add: false, placeholder: true });
    expect(myGoalsControls(viewers.demoAdmin, { linked: true })).toEqual({ cards: false, add: false, placeholder: true });
    expect(myGoalsControls(viewers.member, null)).toEqual({ cards: false, add: false, placeholder: false });
  });
  it('Employees: the Goals action shows only when the table can edit and the goals loaded', () => {
    expect(showGoalsAction(true, {})).toBe(true);
    expect(showGoalsAction(true, null)).toBe(false);
    expect(showGoalsAction(false, {})).toBe(false);
    expect(showGoalsAction(false, null)).toBe(false);
  });
  it('the screens use these decisions', () => {
    const training = readFileSync(resolve('src/screens/people/training.tsx'), 'utf8');
    expect(training).toContain('trainingScreenControls(');
    expect(training).not.toMatch(/import\('/);
    expect(readFileSync(resolve('src/screens/people/my-goals.tsx'), 'utf8')).toContain('myGoalsControls(');
    expect(readFileSync(resolve('src/components/people/employees-table.tsx'), 'utf8')).toContain('showGoalsAction(');
  });
});
