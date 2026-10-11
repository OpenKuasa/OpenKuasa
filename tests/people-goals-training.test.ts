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
  showAtRiskChoice,
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
  it('gives exactly one answer for every day around the course', () => {
    const answers = new Set(['enrol', 'withdraw', 'enrolled', 'completed', 'none']);
    for (const today of ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']) {
      for (const e of [null, { completed: false }, { completed: true }]) expect(answers.has(at(today, e))).toBe(true);
    }
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
  it('reads Done at 100 and hides the at-risk choice', () => {
    expect(goalCardView({ progress: 100, status: 'done' })).toEqual({ done: true, label: 'Done', showAtRisk: false });
    expect(goalCardView({ progress: 40, status: 'at_risk' })).toEqual({ done: false, label: 'At risk', showAtRisk: true });
    expect(goalCardView({ progress: 0, status: 'on_track' })).toEqual({ done: false, label: 'On track', showAtRisk: true });
  });
  it('hides the choice while the typed progress is 100', () => {
    expect(showAtRiskChoice('100')).toBe(false);
    expect(showAtRiskChoice(' 100 ')).toBe(false);
    expect(showAtRiskChoice('99')).toBe(true);
    expect(showAtRiskChoice('')).toBe(true);
    expect(showAtRiskChoice('abc')).toBe(true);
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

const OWNER_ONLY = [
  'saveGoalForAction',
  'deleteGoalForAction',
  'saveTrainingAction',
  'deleteTrainingAction',
  'enrolAction',
  'unenrolAction',
  'setTrainingCompletedAction',
  'saveReviewAction',
  'releaseReviewAction',
  'unreleaseReviewAction',
  'deleteReviewAction',
];
const OWNER_ONLY_COMPONENTS = /employee-goals|course-form|course-enrolments/;

describe('the member pages reach no owner-only control', () => {
  // The own and owner-only actions share one server module (it only exports guarded actions); so what is proved is
  // that no module a member page reaches names an owner-only action, and that the owner-only components are not reached.
  for (const entry of [
    'src/components/people/goal-card-controls.tsx',
    'src/components/people/goal-form.tsx',
    'src/components/people/enrol-buttons.tsx',
    'src/screens/people/my-goals.tsx',
    'src/screens/people/training.tsx',
  ]) {
    const graph = reachable(resolve(entry));
    it(`${entry} reaches a real set of modules`, () => {
      expect(graph.size).toBeGreaterThan(2);
    });
    it(`${entry} reaches no owner-only component and names no owner-only action`, () => {
      for (const [file, source] of graph) {
        if (file.endsWith('performance-actions.ts')) continue; // the boundary: it defines them, it does not import them into a page
        expect(file, file).not.toMatch(OWNER_ONLY_COMPONENTS);
        for (const name of OWNER_ONLY) expect(source, `${file} names ${name}`).not.toContain(name);
      }
    });
  }
  it('the owner-only components are only ever loaded dynamically by the Training screen, never imported', () => {
    for (const entry of ['src/screens/people/my-goals.tsx', 'src/screens/people/training.tsx']) {
      const source = readFileSync(resolve(entry), 'utf8');
      expect(source, entry).not.toMatch(/from\s+'[^']*(employee-goals|course-form|course-enrolments)'/);
      for (const name of OWNER_ONLY) expect(source, `${entry} names ${name}`).not.toContain(name);
    }
    expect(readFileSync(resolve('src/screens/people/training.tsx'), 'utf8')).toMatch(/import\('@\/components\/people\/course-form'\)/);
  });
  it('the own components import only the own actions from the actions module', () => {
    for (const entry of ['src/components/people/enrol-buttons.tsx', 'src/screens/people/my-goals.tsx']) {
      const source = readFileSync(resolve(entry), 'utf8');
      const imported = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*performance-actions'/g)].flatMap((m) =>
        m[1].split(',').map((s) => s.trim()).filter(Boolean),
      );
      expect(imported.length, entry).toBeGreaterThan(0);
      for (const name of imported) expect(['saveMyGoalAction', 'deleteMyGoalAction', 'enrolMeAction', 'withdrawMeAction'], entry).toContain(name);
    }
  });
});
