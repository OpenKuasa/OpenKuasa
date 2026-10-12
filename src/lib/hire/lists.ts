// src/lib/hire/lists.ts
/**
 * What each Lekir list screen shows, worked out from the four tables. Tables
 * show the newest ROWS_SHOWN rows; every count is over all rows.
 */

import {
  STAGE_LABEL,
  applicationLabel,
  boardCounts,
  funnelCounts,
  groupByStage,
  type ApplicationLabel,
} from './applications-view';
import type { RejectReason } from './application-changes';
import { ago } from './dashboard';
import { applicantsByJob, applicationsPerWeek } from './overview';
import { POOL_LABEL, matchesPoolSearch, poolSearchText, type InPool } from './pool';
import { ringgit } from './public-careers';
import {
  APPLICATION_STAGES,
  HIRE_READ_CAP,
  type Application,
  type ApplicationOutcome,
  type ApplicationStage,
  type EmploymentType,
  type HireData,
  type HireSettings,
  type InterviewKind,
  type InterviewStatus,
  type Job,
  type JobStatus,
  type PoolStatus,
} from './types';

/** The branding form's checks live in a file of their own, so the client form can import them alone. */
export { brandingErrors } from './careers-form';

export const ROWS_SHOWN = 50;
const TZ = 'Asia/Kuala_Lumpur';
const DAY = 86_400_000;

const JOB_STATUS_LABEL = { open: 'Open', paused: 'Paused', closed: 'Closed', draft: 'Draft' } as const;
const JOB_STATUS_ORDER: JobStatus[] = ['open', 'paused', 'closed', 'draft'];
const TYPE_LABEL: Record<EmploymentType, string> = {
  full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract', internship: 'Internship',
};
const KIND_LABEL: Record<InterviewKind, 'Video' | 'Onsite' | 'Phone'> = {
  video: 'Video', onsite: 'Onsite', phone: 'Phone',
};
const INTERVIEW_STATUS_LABEL: Record<InterviewStatus, 'Scheduled' | 'Completed' | 'Cancelled' | 'No-show'> = {
  scheduled: 'Scheduled', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show',
};

// A fixed list: a locale's own short month names vary ("Sep" or "Sept").
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The date in Kuala Lumpur, as its parts. */
function klDate(iso: string): { day: string; month: string; year: string } {
  const [year, month, day] = new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ }).split('-');
  return { day, month: MONTHS[Number(month) - 1], year };
}
/** "08 Oct 2026", in Kuala Lumpur. */
export const fullDate = (iso: string) => {
  const d = klDate(iso);
  return `${d.day} ${d.month} ${d.year}`;
};
/** "08 Oct". */
const shortDate = (iso: string) => {
  const d = klDate(iso);
  return `${d.day} ${d.month}`;
};
/** "14:00". */
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });

export type JobsModel = {
  isEmpty: boolean;
  rows: {
    id: string; title: string; dept: string; applicants: number; status: 'Open' | 'Paused' | 'Closed' | 'Draft'; posted: string;
    /** The whole job, for the edit form and the row's status buttons. */
    job: Job;
  }[];
  statusMix: { key: JobStatus; label: string; value: number }[];
  byJob: { label: string; applicants: number }[];
  totalApplicants: number;
  openJobs: number;
};

export async function buildJobsModel(data: HireData, now: Date): Promise<JobsModel> {
  const [jobs, apps] = await Promise.all([data.listJobs(), data.listApplications()]);
  const counted = applicantsByJob(jobs, apps);
  return {
    isEmpty: jobs.length === 0,
    rows: counted.map(({ job, applicants }) => ({
      id: job.id,
      title: job.title,
      dept: job.department ?? '—',
      applicants,
      status: JOB_STATUS_LABEL[job.status],
      posted: job.opened_at ? `${ago(job.opened_at, now)} ago` : '—',
      job,
    })),
    statusMix: JOB_STATUS_ORDER.map((key) => ({
      key,
      label: JOB_STATUS_LABEL[key],
      value: jobs.filter((j) => j.status === key).length,
    })),
    byJob: counted
      .filter((row) => row.job.status === 'open' && row.applicants > 0)
      .slice(0, 6)
      .map((row) => ({ label: row.job.title, applicants: row.applicants })),
    totalApplicants: apps.length,
    openJobs: jobs.filter((j) => j.status === 'open').length,
  };
}

export type CareersModel = {
  isEmpty: boolean;
  rows: {
    id: string; title: string; location: string; type: string; applicants: number;
    /** Published: the public board is on and lists it. Open: open, but not listed (board off, or no description). */
    status: 'Published' | 'Open' | 'Closed' | 'Draft';
    /** The job's real status; `status` folds paused and draft into "Draft". */
    jobStatus: JobStatus;
  }[];
  /** Open jobs, listed publicly or not. */
  openRoles: number;
  /** Jobs the public board lists right now: the board is on and the job is one it shows. */
  publishedRoles: number;
  settings: HireSettings;
  /**
   * What the public board lists, in its order: open jobs with a description,
   * newest opened first. The same rule as the `get_public_careers` function.
   */
  showing: { title: string; location: string }[];
};

/** The public board lists a job when it is open and has a description with a non-space character. */
const isListedOnBoard = (job: Job) => job.status === 'open' && /\S/.test(job.description ?? '');

function careersRowStatus(job: Job, boardOn: boolean): CareersModel['rows'][number]['status'] {
  if (job.status === 'open') return boardOn && isListedOnBoard(job) ? 'Published' : 'Open';
  return job.status === 'closed' ? 'Closed' : 'Draft';
}

export async function buildCareersModel(data: HireData): Promise<CareersModel> {
  const [jobs, apps, settings] = await Promise.all([data.listJobs(), data.listApplications(), data.getSettings()]);
  const showing = jobs
    .filter(isListedOnBoard)
    .sort((a, b) => (b.opened_at ?? '').localeCompare(a.opened_at ?? '') || a.title.localeCompare(b.title))
    .map((job) => ({ title: job.title, location: job.location ?? '' }));
  const rows = applicantsByJob(jobs, apps).map(({ job, applicants }) => ({
    id: job.id,
    jobStatus: job.status,
    title: job.title,
    location: job.location ?? '—',
    type: TYPE_LABEL[job.employment_type],
    applicants,
    status: careersRowStatus(job, settings.careers_enabled),
  }));
  return {
    isEmpty: jobs.length === 0,
    rows,
    openRoles: rows.filter((r) => r.jobStatus === 'open').length,
    publishedRoles: rows.filter((r) => r.status === 'Published').length,
    settings,
    showing,
  };
}

/**
 * What the controls that change an application need to know about it. Plain
 * values only: this goes to the browser, so no storage path and no contact details.
 */
export type ApplicationState = {
  stage: ApplicationStage;
  outcome: ApplicationOutcome;
  /** 1 to 5, or null when not rated. */
  rating: number | null;
  /** Why it was rejected or withdrawn, when a reason was given. */
  rejectReason: RejectReason | null;
};

const applicationState = (a: Application): ApplicationState => ({
  stage: a.stage, outcome: a.outcome, rating: a.rating, rejectReason: a.reject_reason,
});

export type BoardModel = {
  isEmpty: boolean;
  stages: {
    key: ApplicationStage;
    name: string;
    /** Live applications in this stage, over all applications (the list below is cut at ROWS_SHOWN). */
    count: number;
    /** `id` is the application's; `candidateId` the person's, for the Edit candidate form; `poolStatus` their stored talent pool status. No contact details. */
    candidates: ({ id: string; candidateId: string; poolStatus?: PoolStatus; name: string; role: string; source: string; lastTouch: string; active: boolean } & ApplicationState)[];
  }[];
  /** The jobs a new application can be for (open and paused), by title: the Add Candidate form's picker. */
  jobs: { id: string; title: string }[];
  total: number;
  hired: number;
  inPipeline: number;
  interviewing: number;
  offers: number;
  trend: { label: string; applied: number; shortlisted: number }[];
  funnel: { key: ApplicationStage; label: string; value: number }[];
};

export async function buildBoardModel(data: HireData, now: Date): Promise<BoardModel> {
  const [jobs, apps] = await Promise.all([data.listJobs(), data.listApplications()]);
  const groups = groupByStage(apps);
  const board = boardCounts(apps);
  const funnel = funnelCounts(apps);
  const total = Object.values(board).reduce((a, b) => a + b, 0);
  return {
    isEmpty: apps.length === 0,
    stages: APPLICATION_STAGES.map((key) => ({
      key,
      name: STAGE_LABEL[key],
      count: board[key],
      candidates: groups[key].slice(0, ROWS_SHOWN).map((a) => ({
        id: a.id,
        candidateId: a.candidate_id,
        poolStatus: a.candidate_pool_status ?? 'none',
        name: a.candidate_name,
        role: a.job_title,
        source: a.source ?? 'Unknown',
        ...applicationState(a),
        lastTouch: `${ago(a.hired_at ?? a.offered_at ?? a.applied_at, now)} ago`,
        active: now.getTime() - Date.parse(a.applied_at) < 7 * DAY,
      })),
    })),
    jobs: jobs
      .filter((job) => job.status === 'open' || job.status === 'paused')
      .map((job) => ({ id: job.id, title: job.title }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    total,
    hired: board.hired,
    inPipeline: total - board.hired,
    interviewing: board.interview,
    offers: board.offer,
    trend: applicationsPerWeek(apps, now),
    funnel: APPLICATION_STAGES.map((key) => ({ key, label: STAGE_LABEL[key], value: funnel[key] })),
  };
}

const LABELS: ApplicationLabel[] = ['New', 'In review', 'Shortlisted', 'Rejected'];

export type SafeLink = { href: string; host: string };

/** A stored link as something safe to render: http or https only, or nothing. */
export function safeLink(url: string | null): SafeLink | null {
  if (!url || url !== url.trim()) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // "https://good.com@evil.com" goes to evil.com with good.com as a login name: never shown as a link.
    if (parsed.username || parsed.password) return null;
    return { href: parsed.href, host: parsed.host };
  } catch {
    return null;
  }
}

/** What an applicant gave on the form, ready to show. Every link has been through `safeLink`. */
export type ApplicationDetails = {
  coverLetter: string | null;
  cv: SafeLink | null;
  /** True when a PDF was uploaded. The path to it stays on the server. */
  hasCvFile: boolean;
  portfolio: SafeLink | null;
  expectedSalary: string | null;
};

function applicationDetails(a: Application): ApplicationDetails | null {
  const details: ApplicationDetails = {
    coverLetter: a.cover_letter?.trim() ? a.cover_letter : null,
    cv: safeLink(a.cv_url),
    hasCvFile: a.cv_path !== null,
    portfolio: safeLink(a.portfolio_url),
    expectedSalary: a.expected_salary_cents === null ? null : `${ringgit(a.expected_salary_cents)} a month`,
  };
  return details.coverLetter || details.cv || details.hasCvFile || details.portfolio || details.expectedSalary ? details : null;
}

export type ApplicationsModel = {
  isEmpty: boolean;
  total: number;
  rows: ({
    /** `id` is the application's; `candidateId` the person's, for the Edit candidate form. */
    id: string; candidateId: string; poolStatus?: PoolStatus; name: string; job: string; source: string; status: ApplicationLabel; applied: string;
    details: ApplicationDetails | null;
  } & ApplicationState)[];
  statusMix: { key: ApplicationLabel; value: number }[];
  byJob: { label: string; applications: number }[];
};

export async function buildApplicationsModel(data: HireData): Promise<ApplicationsModel> {
  const [jobs, apps] = await Promise.all([data.listJobs(), data.listApplications()]);
  const labelled = apps.map((a) => ({ a, status: applicationLabel(a.stage, a.outcome) }));
  return {
    isEmpty: apps.length === 0,
    total: apps.length,
    rows: labelled.slice(0, ROWS_SHOWN).map(({ a, status }) => ({
      id: a.id,
      candidateId: a.candidate_id,
      poolStatus: a.candidate_pool_status ?? 'none',
      name: a.candidate_name,
      job: a.job_title,
      source: a.source ?? 'Unknown',
      status,
      ...applicationState(a),
      applied: fullDate(a.applied_at),
      details: applicationDetails(a),
    })),
    statusMix: LABELS.map((key) => ({ key, value: labelled.filter((row) => row.status === key).length })),
    byJob: applicantsByJob(jobs, apps)
      .filter((row) => row.applicants > 0)
      .slice(0, 6)
      .map((row) => ({ label: row.job.title, applications: row.applicants })),
  };
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

export type InterviewsModel = {
  isEmpty: boolean;
  rows: {
    id: string; name: string; role: string; date: string; time: string; interviewer: string;
    type: 'Video' | 'Onsite' | 'Phone'; status: 'Scheduled' | 'Completed' | 'Cancelled' | 'No-show';
  }[];
  scheduled: number;
  completed: number;
  noShow: number;
  /** Scheduled interviews in the next 7 days: the same number the Overview and the chat give. */
  next7Days: number;
  /** Those interviews by weekday, Monday to Friday only (for the chart; weekend ones are not in it). */
  weekLoad: { label: string; count: number }[];
};

export async function buildInterviewsModel(data: HireData, now: Date): Promise<InterviewsModel> {
  const interviews = await data.listInterviews();
  const count = (status: InterviewStatus) => interviews.filter((i) => i.status === status).length;
  const ahead = interviews.filter((i) => {
    const at = Date.parse(i.scheduled_at);
    return i.status === 'scheduled' && at >= now.getTime() && at < now.getTime() + 7 * DAY;
  });
  const weekday = (iso: string) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', timeZone: TZ });
  // Scheduled first (soonest first), then the past ones, latest first.
  const ordered = [
    ...interviews.filter((i) => i.status === 'scheduled'),
    ...interviews.filter((i) => i.status !== 'scheduled').reverse(),
  ];
  return {
    isEmpty: interviews.length === 0,
    rows: ordered.slice(0, ROWS_SHOWN).map((i) => ({
      id: i.id,
      name: i.candidate_name,
      role: i.job_title,
      date: shortDate(i.scheduled_at),
      time: clock(i.scheduled_at),
      interviewer: i.interviewer_name ?? '—',
      type: KIND_LABEL[i.kind],
      status: INTERVIEW_STATUS_LABEL[i.status],
    })),
    scheduled: count('scheduled'),
    completed: count('completed'),
    noShow: count('no_show'),
    next7Days: ahead.length,
    weekLoad: WEEKDAYS.map((label) => ({ label, count: ahead.filter((i) => weekday(i.scheduled_at) === label).length })),
  };
}

export type PoolModel = {
  isEmpty: boolean;
  /** Everyone in the pool, whatever is being searched for. */
  size: number;
  rows: {
    id: string; name: string; title: string; skills: string[]; location: string; source: string;
    rating: number | null; status: 'Available' | 'Shortlisted' | 'Passive' | 'Re-engaged';
    /** The stored status, which the row's menu shows and changes. `status` is the label drawn. */
    poolStatus: InPool;
  }[];
  /** The whole pool by status: always the four keys, in this order. */
  statusCounts: { key: 'Available' | 'Shortlisted' | 'Passive' | 'Re-engaged'; value: number }[];
  /** The whole pool by headline, largest first. */
  byTitle: { label: string; value: number }[];
  /** The whole pool by source, largest first. */
  bySource: { label: string; value: number }[];
  /** The jobs a pool member can be moved to (open and paused), by title: the Move to pipeline dialog's picker. */
  jobs: { id: string; title: string; status: 'open' | 'paused' }[];
  /** The text the rows were searched for, or null. */
  search: string | null;
  /** How many pool members fit the search, before the cut to ROWS_SHOWN. The pool's size when nothing is searched for. */
  matched: number;
  /** True when the read came back with its full HIRE_READ_CAP candidates: an older pool member may be missing. */
  readCapped: boolean;
};

/** Groups `items` by `pick`, largest group first (ties keep first-seen order). */
function tally<T>(items: T[], pick: (item: T) => string): { label: string; value: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(pick(item), (counts.get(pick(item)) ?? 0) + 1);
  return [...counts.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

/**
 * The talent pool. `search` (from the page's address) is applied to the WHOLE
 * pool and only then are the rows cut to ROWS_SHOWN: that is what makes every
 * pool member reachable by name. The size, the status counts and the two
 * tallies are always figures for the whole pool.
 */
export async function buildPoolModel(data: HireData, search?: string | null): Promise<PoolModel> {
  const [candidates, apps, jobs] = await Promise.all([data.listCandidates(), data.listApplications(), data.listJobs()]);
  const pool = candidates.filter((c) => c.pool_status !== 'none');
  // "Shortlisted": has a live application at interview or beyond. Best rating across their applications.
  const shortlisted = new Set<string>();
  const rating = new Map<string, number>();
  for (const a of apps) {
    if (a.outcome === 'active' && ['interview', 'offer', 'hired'].includes(a.stage)) shortlisted.add(a.candidate_id);
    if (a.rating !== null) rating.set(a.candidate_id, Math.max(rating.get(a.candidate_id) ?? 0, a.rating));
  }
  const statusOf = (c: (typeof pool)[number]) =>
    shortlisted.has(c.id) ? ('Shortlisted' as const) : POOL_LABEL[c.pool_status as InPool];
  const STATUS_KEYS = ['Available', 'Shortlisted', 'Passive', 'Re-engaged'] as const;
  const text = poolSearchText(search);
  // Before the cut, over everyone in the pool that was read.
  const matches = text === null ? pool : pool.filter((c) => matchesPoolSearch(c, text));
  return {
    isEmpty: pool.length === 0,
    size: pool.length,
    rows: matches.slice(0, ROWS_SHOWN).map((c) => ({
      id: c.id,
      name: c.name,
      title: c.headline ?? '—',
      skills: c.skills,
      location: c.location ?? '—',
      source: c.source ?? 'Unknown',
      rating: rating.get(c.id) ?? null,
      status: statusOf(c),
      poolStatus: c.pool_status as InPool,
    })),
    statusCounts: STATUS_KEYS.map((key) => ({ key, value: pool.filter((c) => statusOf(c) === key).length })),
    byTitle: tally(pool, (c) => c.headline ?? '—'),
    bySource: tally(pool, (c) => c.source ?? 'Unknown'),
    jobs: jobs
      .flatMap((job) => (job.status === 'open' || job.status === 'paused' ? [{ id: job.id, title: job.title, status: job.status }] : []))
      .sort((a, b) => a.title.localeCompare(b.title)),
    search: text,
    matched: matches.length,
    readCapped: candidates.length >= HIRE_READ_CAP,
  };
}

/** One person the "Add to Pool" picker can offer: who they are, and nothing to contact them by. */
export type PickerPerson = {
  id: string; name: string; headline: string | null; location: string | null; skills: string[]; source: string | null;
};
export type PoolPicker = {
  people: PickerPerson[];
  /** True when the read came back with its full HIRE_READ_CAP candidates: someone added long ago may be missing. */
  capped: boolean;
};

/** Everyone on file who is not in the pool, newest on file first. Each field is named: an email or a phone can never ride along. */
export async function buildPoolPicker(data: HireData): Promise<PoolPicker> {
  const candidates = await data.listCandidates();
  return {
    people: candidates
      .filter((c) => c.pool_status === 'none')
      .map((c) => ({ id: c.id, name: c.name, headline: c.headline, location: c.location, skills: c.skills, source: c.source })),
    capped: candidates.length >= HIRE_READ_CAP,
  };
}
