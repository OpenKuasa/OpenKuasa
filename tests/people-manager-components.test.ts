import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLetterTemplatesModel, loadSettingsModel } from '@/lib/people/documents';
import { showsOwnerDocumentControls } from '@/lib/people/documents-screens';
import { employeesControls } from '@/lib/people/employees';
import { isTeamView } from '@/lib/people/own';
import { showsTeamSection } from '@/lib/people/team-section';
import { hasReports, mayDecideRequests, peopleTier, teamScreenView } from '@/lib/people/tier';
import type { PeopleData, PeopleViewer } from '@/lib/people/types';

const text = (file: string) => readFileSync(resolve(file), 'utf8');
const MANAGER: PeopleViewer = { employeeId: 'seed-emp-12', isHr: false, isDemo: false, managesTeam: true };
const HR: PeopleViewer = { employeeId: 'seed-emp-1', isHr: true, isDemo: false };
const ADMIN_WITH_TEAM: PeopleViewer = { employeeId: 'seed-emp-1', isHr: true, isDemo: false, managesTeam: true };
const MEMBER: PeopleViewer = { employeeId: 'seed-emp-30', isHr: false, isDemo: false };
const DEMO: PeopleViewer = { employeeId: 'seed-emp-1', isHr: false, isDemo: true };

describe('what a manager component may name', () => {
  const buttons = text('src/components/people/team-decide-buttons.tsx');

  it.each([
    'cancelLeaveAction', 'cancelTimeOffAction', 'cancelClaimAction', 'cancelOvertimeAction', 'markClaimPaidAction',
    'unmarkClaimPaidAction', 'correctAttendanceAction', 'applyLeaveForAction', 'submitClaimForAction',
    'submitOvertimeForAction', 'setReportsToAction', 'Cancel', 'Mark paid', 'Undo paid', 'Correct',
  ])('team-decide-buttons.tsx never contains %s', (word) => {
    expect(buttons).not.toContain(word);
  });

  it('imports exactly the four decide actions', () => {
    const imported = [...buttons.matchAll(/\b(\w+Action)\b/g)].map((m) => m[1]);
    expect([...new Set(imported)].sort()).toEqual(
      ['decideClaimAction', 'decideLeaveAction', 'decideOvertimeAction', 'decideTimeOffAction'],
    );
  });

  it('refreshes the page when a decision is refused as already decided', () => {
    expect(buttons).toContain('router.refresh()');
    expect(buttons).toContain('LEAVE_NOT_PENDING');
    expect(buttons).toContain('PAY_NOT_PENDING');
  });

  it("HR's decide buttons refresh the same way", () => {
    const hr = text('src/components/people/decide-buttons.tsx');
    expect(hr).toContain('router.refresh()');
    expect(hr).toContain('LEAVE_NOT_PENDING');
    expect(hr).toContain('PAY_NOT_PENDING');
  });

  it('the team section module imports nothing from the app directory', () => {
    expect(text('src/lib/people/team-section.ts')).not.toMatch(/from '@\/app\//);
  });
});

describe('a manager opening an HR screen by address', () => {
  it('is answered as a member is', async () => {
    expect(isTeamView(MANAGER)).toBe(false);
    let read = false;
    const fake = new Proxy({} as PeopleData, { get: () => () => { read = true; return {}; } });
    expect(await loadSettingsModel(fake, MANAGER)).toEqual({ hr_only: true });
    expect(read).toBe(false);
    expect(buildLetterTemplatesModel([], MANAGER)).toEqual({ allowed: false });
    expect(showsOwnerDocumentControls(MANAGER)).toBe(false);
  });

  it.each(['src/screens/people/payroll.tsx', 'src/screens/people/payment-vouchers.tsx'])(
    '%s still gates on HR or the demo, and knows nothing of managers',
    (file) => {
      const source = text(file);
      expect(source).toMatch(/if \(!viewer\.isHr && !viewer\.isDemo\) return <HrOnlyScreen/);
      for (const word of ['managesTeam', 'canApproveTeam', 'teamScreenView']) expect(source).not.toContain(word);
    },
  );
});

describe('an admin who also has a team', () => {
  const hrHalf = async (viewer: PeopleViewer) => ({
    isTeamView: isTeamView(viewer),
    tier: peopleTier(viewer),
    teamScreen: teamScreenView(viewer),
    mayDecide: mayDecideRequests(viewer),
    ownerControls: showsOwnerDocumentControls(viewer),
    settingsHrOnly: await loadSettingsModel({ getSettings: async () => null } as unknown as PeopleData, viewer).then(
      (model) => 'hr_only' in model,
      () => false,
    ),
    letters: buildLetterTemplatesModel([], viewer),
    canEdit: employeesControls(viewer).canEdit,
    reportsToField: employeesControls(viewer).reportsToField,
  });
  const teamHalf = (viewer: PeopleViewer) => ({
    hasReports: hasReports(viewer),
    myTeamFilter: employeesControls(viewer).myTeamFilter,
    teamCard: showsTeamSection(viewer),
  });

  it('keeps every HR control an admin without a team has', async () => {
    expect(await hrHalf(ADMIN_WITH_TEAM)).toEqual(await hrHalf(HR));
    expect(peopleTier(ADMIN_WITH_TEAM)).toBe('hr');
    expect(teamScreenView(ADMIN_WITH_TEAM)).toBe('hr');
    expect(showsOwnerDocumentControls(ADMIN_WITH_TEAM)).toBe(true);
    expect((await hrHalf(ADMIN_WITH_TEAM)).settingsHrOnly).toBe(false);
  });

  it('adds the My team filter and the team card', () => {
    expect(teamHalf(ADMIN_WITH_TEAM)).toEqual({ hasReports: true, myTeamFilter: true, teamCard: true });
  });

  it.each([
    ['an admin without a team', HR, { hasReports: false, myTeamFilter: false, teamCard: false }],
    ['a manager', MANAGER, { hasReports: true, myTeamFilter: true, teamCard: true }],
    ['a member', MEMBER, { hasReports: false, myTeamFilter: false, teamCard: false }],
    ['the demo', DEMO, { hasReports: false, myTeamFilter: false, teamCard: false }],
  ] as const)('leaves %s as before', (_who, viewer, expected) => {
    expect(teamHalf(viewer)).toEqual(expected);
  });
});
