import type { PeopleViewer } from './types';

/** Who is asking, for wording and for what to show. Never a permission: the database decides what is read or done. */
export type PeopleTier = 'hr' | 'manager' | 'self';

/** `hr` for an owner or admin, else `manager` for someone with at least one report, else `self`. The demo keeps its own flag. */
export function peopleTier(viewer: Pick<PeopleViewer, 'isHr' | 'managesTeam'>): PeopleTier {
  if (viewer.isHr) return 'hr';
  return viewer.managesTeam === true ? 'manager' : 'self';
}

/**
 * Has people reporting to them, outside the demo, whatever their tier: a manager, or an owner or admin who also has a
 * team. Not a tier and never a permission: an admin with reports stays `hr` in {@link peopleTier}. It only decides the
 * extras about one's own team, the Employees screen's "My team" filter and the dashboard's team card.
 */
export function hasReports(viewer: Pick<PeopleViewer, 'isDemo' | 'managesTeam'>): boolean {
  return !viewer.isDemo && viewer.managesTeam === true;
}

/** What a team screen (the four approval screens, team attendance) is for this viewer. */
export type TeamScreenView = 'hr' | 'manager' | 'demo' | 'none';

/** The demo first: there every control is drawn and switched off, whoever is looking. */
export function teamScreenView(viewer: Pick<PeopleViewer, 'isHr' | 'isDemo' | 'managesTeam'>): TeamScreenView {
  if (viewer.isDemo) return 'demo';
  const tier = peopleTier(viewer);
  return tier === 'self' ? 'none' : tier;
}

/** May call a decide action at all: HR or a manager, never in the demo. The database judges each request. */
export function mayDecideRequests(viewer: Pick<PeopleViewer, 'isHr' | 'isDemo' | 'managesTeam'>): boolean {
  return !viewer.isDemo && peopleTier(viewer) !== 'self';
}
