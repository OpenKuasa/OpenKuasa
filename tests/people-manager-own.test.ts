import { describe, expect, it } from 'vitest';
import { todayInMalaysia } from '@/lib/people/dates';
import { buildMyDocumentsModel, loadRecordsModel } from '@/lib/people/documents';
import { buildMyAttendance, buildOvertimeView } from '@/lib/people/attendance';
import { buildPeopleOverviewModel } from '@/lib/people/overview';
import { buildClaimsModel, buildLeaveModel, buildOtModel, buildTimeOffModel } from '@/lib/people/requests';
import { createSeedPeopleData } from '@/lib/people/seed';
import { DEMO_EMPLOYEE_ID, type PeopleViewer } from '@/lib/people/types';
import { asManager } from './setup/people-manager-view';
import { asMember } from './setup/people-member-view';

const FIXED_NOW = new Date('2026-10-09T04:00:00Z');
const TODAY = todayInMalaysia(FIXED_NOW);
const YEAR = Number(TODAY.slice(0, 4));

// Farid Ismail (seed employee 12) and his department's five others.
const MANAGER_ID = 'seed-emp-12';
const TEAM = [DEMO_EMPLOYEE_ID, 'seed-emp-5', 'seed-emp-10', 'seed-emp-11', 'seed-emp-13'];

const MANAGER: PeopleViewer = { employeeId: MANAGER_ID, isHr: false, isDemo: false, managesTeam: true };
const MEMBER: PeopleViewer = { employeeId: MANAGER_ID, isHr: false, isDemo: false };

const seed = createSeedPeopleData(FIXED_NOW);
const asManagerData = asManager(seed, MANAGER_ID, TEAM);
const asMemberData = asMember(seed, MANAGER_ID);

/** A model is compared without the flag a viewer echoes. */
const bare = <T>(model: T): T => JSON.parse(JSON.stringify(model, (key, value) => (key === 'managesTeam' ? undefined : value)));

describe('the fixture is not vacuous', () => {
  it('hands the manager more leave rows than a member', async () => {
    expect((await asManagerData.listLeaveRequests()).length).toBeGreaterThan((await asMemberData.listLeaveRequests()).length);
  });
});

describe("a manager's personal screens are a member's", () => {
  it('Leave', async () => {
    const build = async (d: typeof seed, viewer: PeopleViewer) =>
      buildLeaveModel(await d.listLeaveRequests(), await d.listLeaveBalances(YEAR), viewer, TODAY);
    expect(bare(await build(asManagerData, MANAGER))).toEqual(bare(await build(asMemberData, MEMBER)));
  });

  it('Time-Off', async () => {
    const build = async (d: typeof seed, viewer: PeopleViewer) => buildTimeOffModel(await d.listTimeOffRequests(), viewer, TODAY);
    expect(bare(await build(asManagerData, MANAGER))).toEqual(bare(await build(asMemberData, MEMBER)));
  });

  it('Financial Claims', async () => {
    const build = async (d: typeof seed, viewer: PeopleViewer) => buildClaimsModel(await d.listClaims(), viewer, TODAY);
    expect(bare(await build(asManagerData, MANAGER))).toEqual(bare(await build(asMemberData, MEMBER)));
  });

  it('OT Claims', async () => {
    const build = async (d: typeof seed, viewer: PeopleViewer) => buildOtModel(await d.listOvertime(), viewer, TODAY);
    expect(bare(await build(asManagerData, MANAGER))).toEqual(bare(await build(asMemberData, MEMBER)));
  });

  it('My Attendance', async () => {
    const build = async (d: typeof seed, viewer: PeopleViewer) =>
      buildMyAttendance({
        days: await d.listAttendance('2026-01-01', TODAY),
        leave: await d.listLeaveRequests(),
        balances: await d.listLeaveBalances(YEAR),
        viewer,
        today: TODAY,
      });
    expect(bare(await build(asManagerData, MANAGER))).toEqual(bare(await build(asMemberData, MEMBER)));
  });

  it('Overtime in the Attendance section', async () => {
    const build = async (d: typeof seed, viewer: PeopleViewer) =>
      buildOvertimeView({ records: await d.listOvertime(), employees: await d.listEmployees(), viewer, today: TODAY });
    expect(bare(await build(asManagerData, MANAGER))).toEqual(bare(await build(asMemberData, MEMBER)));
  });

  it('Overview', async () => {
    const manager = await buildPeopleOverviewModel(asManagerData, FIXED_NOW, { viewer: MANAGER });
    const member = await buildPeopleOverviewModel(asMemberData, FIXED_NOW, { viewer: MEMBER });
    expect(bare(manager)).toEqual(bare(member));
  });

  it('My Documents and Records', async () => {
    const documents = async (d: typeof seed, viewer: PeopleViewer) =>
      buildMyDocumentsModel({
        documents: await d.listDocuments(),
        letters: await d.listLetters(),
        payslips: await d.listPayslips(),
        today: TODAY,
        viewer,
      });
    expect(bare(await documents(asManagerData, MANAGER))).toEqual(bare(await documents(asMemberData, MEMBER)));
    expect(bare(await loadRecordsModel(asManagerData, MANAGER, TODAY))).toEqual(
      bare(await loadRecordsModel(asMemberData, MEMBER, TODAY)),
    );
  });
});
