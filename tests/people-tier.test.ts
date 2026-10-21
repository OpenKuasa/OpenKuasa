import { describe, expect, it } from 'vitest';
import { canApproveTeam, isTeamView } from '@/lib/people/own';
import { hasReports, mayDecideRequests, peopleTier, teamScreenView } from '@/lib/people/tier';
import type { PeopleViewer } from '@/lib/people/types';

const base = { employeeId: 'e1', isDemo: false } as const;
const VIEWERS: Record<string, PeopleViewer> = {
  owner: { ...base, isHr: true, isOwner: true },
  admin: { ...base, isHr: true },
  manager: { ...base, isHr: false, managesTeam: true },
  member: { ...base, isHr: false },
  unlinked: { employeeId: null, isHr: false, isDemo: false },
  demo: { employeeId: 'e1', isHr: false, isDemo: true },
  demoAdmin: { employeeId: 'e1', isHr: true, isDemo: true },
  // An owner or admin with people reporting to them: still HR everywhere, plus the team bits.
  hrWithFlag: { ...base, isHr: true, managesTeam: true },
  // Never built by getPeopleViewer, but the functions must not be fooled by it.
  demoWithFlag: { employeeId: 'e1', isHr: false, isDemo: true, managesTeam: true },
};

describe('the three tiers', () => {
  it.each([
    ['owner', 'hr'], ['admin', 'hr'], ['hrWithFlag', 'hr'],
    ['manager', 'manager'], ['demoWithFlag', 'manager'],
    ['member', 'self'], ['unlinked', 'self'], ['demo', 'self'], ['demoAdmin', 'hr'],
  ] as const)('%s is %s', (who, tier) => {
    expect(peopleTier(VIEWERS[who])).toBe(tier);
  });
});

describe('what a team screen is for each viewer', () => {
  it.each([
    ['owner', 'hr'], ['admin', 'hr'], ['hrWithFlag', 'hr'],
    ['manager', 'manager'],
    ['member', 'none'], ['unlinked', 'none'],
    ['demo', 'demo'], ['demoAdmin', 'demo'], ['demoWithFlag', 'demo'],
  ] as const)('%s sees %s', (who, view) => {
    expect(teamScreenView(VIEWERS[who])).toBe(view);
  });
});

describe('who may call a decide action', () => {
  it.each([
    ['owner', true], ['admin', true], ['manager', true],
    ['member', false], ['unlinked', false], ['demo', false], ['demoAdmin', false], ['demoWithFlag', false],
  ] as const)('%s: %s', (who, may) => {
    expect(mayDecideRequests(VIEWERS[who])).toBe(may);
  });
});

describe('canApproveTeam is not isTeamView', () => {
  it('adds the manager and nobody else', () => {
    for (const [who, viewer] of Object.entries(VIEWERS)) {
      const expected = isTeamView(viewer) || viewer.managesTeam === true;
      expect(canApproveTeam(viewer), who).toBe(expected);
    }
    expect(isTeamView(VIEWERS.manager)).toBe(false);
    expect(canApproveTeam(VIEWERS.manager)).toBe(true);
    expect(canApproveTeam(VIEWERS.member)).toBe(false);
  });
});

describe('who has reports, whatever their tier', () => {
  it.each([
    ['owner', false], ['admin', false], ['hrWithFlag', true], ['manager', true],
    ['member', false], ['unlinked', false], ['demo', false], ['demoAdmin', false], ['demoWithFlag', false],
  ] as const)('%s: %s', (who, has) => {
    expect(hasReports(VIEWERS[who])).toBe(has);
  });

  it('changes nothing an admin with reports may do', () => {
    const viewer = VIEWERS.hrWithFlag;
    expect(peopleTier(viewer)).toBe('hr');
    expect(teamScreenView(viewer)).toBe('hr');
    expect(mayDecideRequests(viewer)).toBe(true);
    expect(isTeamView(viewer)).toBe(true);
  });
});
