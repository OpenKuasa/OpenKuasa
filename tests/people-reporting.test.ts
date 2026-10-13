import { describe, expect, it } from 'vitest';
import { managerIdsOf, managerLabel, managerOf, reportsOf, teamIds, wouldLoop } from '@/lib/people/reporting';
import type { Employee, PeopleViewer } from '@/lib/people/types';

function emp(id: string, name: string, reports_to: string | null, status: Employee['status'] = 'active'): Employee {
  return {
    id,
    user_id: null,
    employee_no: `E-${id}`,
    name,
    work_email: null,
    department_id: null,
    department_name: null,
    designation: null,
    employment_type: 'full_time',
    reports_to,
    join_date: null,
    status,
    date_of_birth_day: null,
    date_of_birth_month: null,
    created_at: '2026-01-01T00:00:00Z',
  };
}

const a = emp('a', 'A name', null);
const b = emp('b', 'B name', 'a');
const c = emp('c', 'C name', 'b');
const d = emp('d', 'D name', 'a');
const z = emp('z', 'Z name', null, 'inactive');
const y = emp('y', 'Y name', 'z');
const all = [a, b, c, d, z, y];

const names = (rows: Employee[]) => rows.map((e) => e.name);
const viewerOf = (employeeId: string | null): PeopleViewer => ({ employeeId, isHr: false, isDemo: false, managesTeam: true });

describe('reportsOf', () => {
  it('lists the direct reports, by name', () => {
    expect(names(reportsOf([d, b, a], 'a'))).toEqual(['B name', 'D name']);
    expect(reportsOf(all, 'a')).toEqual([b, d]);
  });
  it('is empty for someone with no reports, for null and for an unknown id', () => {
    expect(reportsOf(all, 'c')).toEqual([]);
    expect(reportsOf(all, null)).toEqual([]);
    expect(reportsOf(all, 'nobody')).toEqual([]);
  });
  it('goes one hop only', () => {
    expect(reportsOf(all, 'a')).not.toContain(c);
  });
});

describe('teamIds', () => {
  it('is the ids of the viewer\'s direct reports', () => {
    expect(teamIds(all, viewerOf('a'))).toEqual(new Set(['b', 'd']));
  });
  it('is empty for an unlinked viewer', () => {
    expect(teamIds(all, viewerOf(null)).size).toBe(0);
  });
});

describe('managerOf and managerLabel', () => {
  it('finds the manager', () => {
    expect(managerOf(b, all)).toBe(a);
  });
  it('is null for nobody and for a manager who is gone', () => {
    expect(managerOf(a, all)).toBeNull();
    expect(managerOf({ reports_to: 'gone' }, all)).toBeNull();
  });
  it('labels the manager by name', () => {
    expect(managerLabel(b, all)).toBe('A name');
  });
  it('marks an inactive manager', () => {
    expect(managerLabel(y, all)).toBe('Z name (inactive)');
  });
  it('is null when there is no manager', () => {
    expect(managerLabel(a, all)).toBeNull();
  });
});

describe('managerIdsOf', () => {
  it('is everyone with at least one report', () => {
    expect(managerIdsOf(all)).toEqual(new Set(['a', 'b', 'z']));
  });
});

describe('wouldLoop', () => {
  it('sees a person made their own manager (length 1)', () => {
    expect(wouldLoop('a', 'a', all)).toBe(true);
  });
  it('sees a loop of length 2', () => {
    expect(wouldLoop('a', 'b', all)).toBe(true);
  });
  it('sees a loop of length 3', () => {
    expect(wouldLoop('a', 'c', all)).toBe(true);
  });
  it('allows a line that makes no loop', () => {
    expect(wouldLoop('c', 'a', all)).toBe(false);
    expect(wouldLoop('d', 'b', all)).toBe(false);
  });
  it('leaves an unknown manager to the database to refuse', () => {
    expect(wouldLoop('a', 'gone', all)).toBe(false);
  });
  it('returns within 50 steps over rows that already hold a loop', () => {
    const p = emp('p', 'P', 'q');
    const q = emp('q', 'Q', 'p');
    expect(wouldLoop('x', 'p', [p, q])).toBe(true);
  });
});
