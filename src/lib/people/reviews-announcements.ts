/**
 * The rules behind the Review Scores, Scorecard and Announcements screens that can be said without a browser:
 * what a form offers, the sentences of the second steps, the figures on the tiles, which rows a viewer is shown
 * and when the unread marks are cleared. Pure: no clock, no network, no import of a write path or an action, so a
 * member's page can import it.
 *
 * Draft safety is held twice on purpose. The database and the models in `performance.ts` / `company.ts` already
 * give a member nothing but released reviews and published announcements; `visibleReviewRows`,
 * `visibleScorecardRows` and `visibleAnnouncements` filter again at the screen, so a draft handed to a member's
 * screen by mistake still draws no row, and the tiles are built from the models' released-only figures.
 */
import { formatScore } from './performance';
import type { AnnouncementItem, AnnouncementsModel } from './company';
import type { ReviewRow, ReviewsModel, ScorecardModel, ScorecardRow } from './performance';
import { COMPETENCIES, type Competency } from './types';

const DASH = '—';

// ---- Form options ----------------------------------------------------------------

/** 1 to 5 in half steps, written plainly as `toScore` wants them. */
export const SCORE_OPTIONS: string[] = Array.from({ length: 9 }, (_, i) => String(1 + i / 2));

export const RATING_OPTIONS: { value: 'exceeds' | 'meets' | 'below'; label: string }[] = [
  { value: 'exceeds', label: 'Exceeds expectations' },
  { value: 'meets', label: 'Meets expectations' },
  { value: 'below', label: 'Below expectations' },
];

/** Owners and admins outside the demo: the only people who are shown a control that changes a review or a post. */
export const showsWriteControls = (viewer: { isHr: boolean; isDemo: boolean }): boolean => viewer.isHr && !viewer.isDemo;

// ---- Second steps ----------------------------------------------------------------

export const releaseSentence = (name: string): string => `${name} will be able to see this review.`;
export const pullBackSentence = (name: string): string => `${name} will no longer see this review.`;
export const deleteReviewSentence = (name: string, period: string): string =>
  `Delete the draft ${period} review of ${name}? This cannot be undone.`;
export const publishSentence = (): string => 'Everyone in your workspace will be able to read this.';
export const pullBackAnnouncementSentence = (): string =>
  'It goes back to a draft and no one but owners and admins will see it until you publish it again.';
export const deleteAnnouncementSentence = (title: string): string => `Delete "${title}"? This cannot be undone.`;

// ---- The review form -------------------------------------------------------------

export type ReviewedPeriod = { id: string; employee_id: string; period: string };

/** The employee already has a review for that period (not counting the one being edited). */
export function periodTaken(rows: ReviewedPeriod[], employeeId: string, period: string, exceptId?: string): boolean {
  return rows.some((r) => r.employee_id === employeeId && r.period === period && r.id !== exceptId);
}

/** The first period in the list that has no review for the employee; '' when every one has. */
export function firstFreePeriod(periods: string[], rows: ReviewedPeriod[], employeeId: string, exceptId?: string): string {
  return periods.find((p) => !periodTaken(rows, employeeId, p, exceptId)) ?? '';
}

export type ReviewFormValues = {
  employee_id: string;
  period: string;
  competencies: Record<Competency, string>;
  rating: '' | 'exceeds' | 'meets' | 'below';
  comment: string;
};

/** What the form holds when it opens: blank for a new review, the row for an edit. An old row's `{}` gives blank scores. */
export function reviewFormDefaults(
  row: {
    employee_id: string;
    period: string;
    rating: 'exceeds' | 'meets' | 'below';
    comment: string | null;
    competencies: Record<string, number>;
  } | null,
  freePeriod: string,
): ReviewFormValues {
  const scores = Object.fromEntries(
    COMPETENCIES.map((name) => {
      const value = row?.competencies?.[name];
      return [name, typeof value === 'number' && Number.isFinite(value) ? String(value) : ''];
    }),
  ) as Record<Competency, string>;
  return {
    employee_id: row?.employee_id ?? '',
    period: row?.period ?? freePeriod,
    competencies: scores,
    rating: row?.rating ?? '',
    comment: row?.comment ?? '',
  };
}

// ---- Scores on screen ------------------------------------------------------------

/** A score out of 5; a dash for one that is missing (an old row has none) rather than `0.0` or `NaN`. */
export const scoreCell = (score: number | null | undefined): string =>
  typeof score === 'number' && Number.isFinite(score) && score >= 1 ? formatScore(score) : DASH;

/** `Delivery 4.0 · Teamwork 3.5 · Ownership — · Communication —`; a dash alone when none was scored. */
export function competencyLine(competencies: Record<string, number> | null | undefined): string {
  const parts = COMPETENCIES.map((name) => {
    const value = competencies?.[name];
    return typeof value === 'number' && Number.isFinite(value) ? `${name} ${value.toFixed(1)}` : `${name} ${DASH}`;
  });
  return parts.every((p) => p.endsWith(DASH)) ? DASH : parts.join(' · ');
}

export type Tile = { label: string; value: string; caption?: string };

const draftsNote = (drafts: number | null): string | undefined =>
  drafts && drafts > 0 ? `${drafts} ${drafts === 1 ? 'draft' : 'drafts'} not counted` : undefined;

/** The four (or two) tiles on Review Scores. Built from released reviews only; only a team viewer is told about drafts. */
export function reviewTiles(model: ReviewsModel | null): Tile[] {
  if (!model) return ['Exceeds', 'Meets', 'Below', 'Average score'].map((label) => ({ label, value: DASH }));
  const average = model.average === null ? DASH : scoreCell(model.average);
  if (model.team && model.ratings) {
    return [
      { label: 'Exceeds', value: String(model.ratings.exceeds) },
      { label: 'Meets', value: String(model.ratings.meets) },
      { label: 'Below', value: String(model.ratings.below) },
      { label: 'Average score', value: average, caption: draftsNote(model.drafts) },
    ];
  }
  return [
    { label: 'Your reviews', value: String(model.scored) },
    { label: 'Your score', value: average },
  ];
}

/** The tiles on the Scorecard, with the same rule. */
export function scorecardTiles(model: ScorecardModel | null): Tile[] {
  if (!model) return ['Average score', 'Highest', 'Scored'].map((label) => ({ label, value: DASH }));
  const average = model.average === null ? DASH : scoreCell(model.average);
  if (model.team) {
    return [
      { label: 'Average score', value: average },
      { label: 'Highest', value: model.highest ? scoreCell(model.highest.score) : DASH, caption: model.highest?.employee },
      { label: 'Scored', value: String(model.scored), caption: draftsNote(model.drafts) },
    ];
  }
  return [
    { label: 'Your score', value: average },
    { label: 'Scored', value: String(model.scored) },
  ];
}

/** The rows to draw. A member's are released ones only, whatever the model holds. */
export function visibleReviewRows(model: ReviewsModel): ReviewRow[] {
  return model.team ? model.rows : model.rows.filter((r) => !r.draft && r.status === 'released');
}

export function visibleScorecardRows(model: ScorecardModel): ScorecardRow[] {
  return model.team ? model.rows : model.rows.filter((r) => !r.draft);
}

/** `Draft` / `Released` for a team viewer; nothing for a member, who is never shown a draft and needs no label. */
export function reviewMark(row: Pick<ReviewRow, 'draft'>, team: boolean): 'Draft' | 'Released' | null {
  if (!team) return null;
  return row.draft ? 'Draft' : 'Released';
}

// ---- Announcements ---------------------------------------------------------------

/** The posts to draw: a draft only when the viewer is a team viewer (the model says so by counting drafts). */
export function visibleAnnouncements(model: AnnouncementsModel, team: boolean = model.drafts !== null): AnnouncementItem[] {
  return team ? model.list : model.list.filter((a) => !a.draft && a.status === 'published');
}

export function announcementMarks(item: Pick<AnnouncementItem, 'draft' | 'unread' | 'edited'>): ('Draft' | 'New' | 'edited')[] {
  if (item.draft) return ['Draft'];
  return [...(item.unread ? (['New'] as const) : []), ...(item.edited ? (['edited'] as const) : [])];
}

/** The page calls "mark all read" only for someone outside the demo who has something unread. */
export const shouldMarkRead = (input: { isDemo: boolean; unread: number }): boolean => !input.isDemo && input.unread > 0;

/** True the first time it is asked of a flag, false after: guards an effect React runs twice in development. */
export function claimOnce(flag: { current: boolean }): boolean {
  if (flag.current) return false;
  flag.current = true;
  return true;
}

/**
 * What the mark-read effect does: claim the flag (only the first run goes on), call the action, and refresh the
 * route only when the server accepted. A throw or a refusal is silent and never refreshes.
 */
export async function markReadOnce(
  flag: { current: boolean },
  call: () => Promise<{ ok: boolean }>,
  refresh: () => void,
): Promise<'skipped' | 'refreshed' | 'not-marked'> {
  if (!claimOnce(flag)) return 'skipped';
  try {
    const result = await call();
    if (!result.ok) return 'not-marked';
    refresh();
    return 'refreshed';
  } catch {
    return 'not-marked';
  }
}

/** The people layout reads the unread count for a signed-in member of a real (non-demo) workspace, and for no one else. */
export const shouldReadUnread = (input: { isDemo: boolean; orgId: string | null | undefined }): boolean =>
  !input.isDemo && Boolean(input.orgId);

type ViewerKind = { isHr: boolean; isDemo: boolean };

/** Review Scores: the write controls only for an owner or admin outside the demo, with the data loaded. */
export const reviewScreenControls = (viewer: ViewerKind, loaded: boolean) => ({
  write: loaded && showsWriteControls(viewer),
});

/** Announcements: write controls as above; mark-read only outside the demo with something unread. */
export const announcementsScreenControls = (viewer: ViewerKind, loaded: boolean, unread: number) => ({
  write: loaded && showsWriteControls(viewer),
  markRead: loaded && shouldMarkRead({ isDemo: viewer.isDemo, unread }),
});
