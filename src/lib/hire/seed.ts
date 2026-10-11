/**
 * Fictional Rimba Ventures hiring data: the dev, preview and test stand-in for
 * the `hire_*` tables. Self-consistent (jobs, the funnel, the source mix and
 * the interviews all line up) and generated from `now`, so tests are stable.
 * `private.reseed_demo_hire()` repeats the same arithmetic in SQL.
 */

import type {
  Application,
  ApplicationOutcome,
  ApplicationStage,
  Candidate,
  EmploymentType,
  HireData,
  Interview,
  InterviewKind,
  InterviewStatus,
  Job,
  JobStatus,
  PoolStatus,
  WorkArrangement,
} from './types';
import { DEFAULT_HIRE_SETTINGS } from './types';

const DAY = 86_400_000;
const HOUR = 3_600_000;
export const SEED_APPLICATIONS = 248;
export const SEED_CANDIDATES = 342;

const FIRST = [
  'Aisyah', 'Faiz', 'Mei Ling', 'Rajesh', 'Nurul', 'Hafiz', 'Siti', 'Wei Jie', 'Nabila', 'Arjun',
  'Farah', 'Daniel', 'Amira', 'Kavitha', 'Zulkifli', 'Li Fen', 'Imran', 'Priya', 'Azlan',
];
const LAST = [
  'Rahim', 'Hakim', 'Tan', 'Kumar', 'Huda', 'Omar', 'Aminah', 'Lim', 'Idris', 'Nair',
  'Zaki', 'Wong', 'Yusof', 'Pillai', 'Ismail', 'Chong', 'Bakar', 'Menon',
];
const LOCATIONS = ['Kuala Lumpur', 'Petaling Jaya', 'Shah Alam', 'Cyberjaya', 'Subang Jaya'];
const SKILLS = [
  ['React', 'Node.js', 'TypeScript'],
  ['B2B Sales', 'CRM'],
  ['Account Management', 'Negotiation'],
  ['Figma', 'Branding'],
  ['Customer Service', 'Zendesk'],
  ['Operations', 'Excel'],
];
const POOL_HEADLINES = [
  'Software Engineer', 'Sales Executive', 'Account Manager',
  'Graphic Designer', 'Customer Support', 'Operations Executive',
];
const POOL_SOURCES = ['LinkedIn', 'JobStreet', 'Referral', 'Careers page'];
const POOL_STATUSES: PoolStatus[] = ['available', 'passive', 're_engaged'];
const INTERVIEWERS = ['Ahmad Zaki', 'Faiz Hakim', 'Nurul Huda', 'Siti Aminah'];
const KINDS: InterviewKind[] = ['video', 'onsite', 'phone'];

type JobSeed = {
  title: string; department: string; location: string; employment_type: EmploymentType;
  status: JobStatus; openedDaysAgo: number | null; closedDaysAgo: number | null;
  /** Applications 1..upTo (cumulative) belong to this job or an earlier one. */
  upTo: number;
  work_arrangement: WorkArrangement; headcount: number;
  /** Monthly range in whole ringgit. */
  salary: [number, number] | null; show_salary: boolean; closesInDays: number | null;
};
export const JOB_SEEDS: JobSeed[] = [
  { title: 'Software Engineer', department: 'Engineering', location: 'Kuala Lumpur', employment_type: 'full_time', status: 'open', openedDaysAgo: 62, closedDaysAgo: null, upTo: 56, work_arrangement: 'hybrid', headcount: 2, salary: [5000, 8000], show_salary: true, closesInDays: 21 },
  { title: 'Sales Executive', department: 'Sales', location: 'Petaling Jaya', employment_type: 'full_time', status: 'open', openedDaysAgo: 61, closedDaysAgo: null, upTo: 98, work_arrangement: 'onsite', headcount: 3, salary: [3000, 4500], show_salary: true, closesInDays: 14 },
  { title: 'Account Manager', department: 'Sales', location: 'Shah Alam', employment_type: 'full_time', status: 'open', openedDaysAgo: 60, closedDaysAgo: null, upTo: 129, work_arrangement: 'hybrid', headcount: 1, salary: [4500, 6500], show_salary: true, closesInDays: null },
  { title: 'Graphic Designer', department: 'Marketing', location: 'Kuala Lumpur', employment_type: 'contract', status: 'open', openedDaysAgo: 59, closedDaysAgo: null, upTo: 157, work_arrangement: 'remote', headcount: 1, salary: [3500, 5000], show_salary: true, closesInDays: 28 },
  { title: 'Customer Support', department: 'Operations', location: 'Cyberjaya', employment_type: 'part_time', status: 'open', openedDaysAgo: 58, closedDaysAgo: null, upTo: 181, work_arrangement: 'onsite', headcount: 2, salary: [2200, 3000], show_salary: false, closesInDays: null },
  { title: 'Operations Executive', department: 'Operations', location: 'Klang', employment_type: 'full_time', status: 'open', openedDaysAgo: 57, closedDaysAgo: null, upTo: 203, work_arrangement: 'onsite', headcount: 1, salary: [3000, 4000], show_salary: false, closesInDays: null },
  { title: 'Content Writer', department: 'Marketing', location: 'Kuala Lumpur', employment_type: 'contract', status: 'closed', openedDaysAgo: 64, closedDaysAgo: 4, upTo: 230, work_arrangement: 'remote', headcount: 1, salary: null, show_salary: false, closesInDays: null },
  { title: 'Accountant', department: 'Finance', location: 'Subang Jaya', employment_type: 'full_time', status: 'paused', openedDaysAgo: 63, closedDaysAgo: null, upTo: 248, work_arrangement: 'onsite', headcount: 1, salary: [4000, 5500], show_salary: false, closesInDays: null },
  { title: 'Marketing Lead', department: 'Marketing', location: 'Kuala Lumpur', employment_type: 'full_time', status: 'draft', openedDaysAgo: null, closedDaysAgo: null, upTo: 248, work_arrangement: 'hybrid', headcount: 1, salary: null, show_salary: false, closesInDays: null },
];

/** Applications received in each of the last 8 weeks, oldest first, as running totals. */
const WEEK_UP_TO = [22, 49, 74, 106, 136, 173, 207, 248];
const SOURCE_UP_TO: [string, number][] = [
  ['JobStreet', 104], ['LinkedIn', 176], ['Referral', 220], ['Careers page', 248],
];
/** Hours from now for the ten interviews: six ahead, three completed, one no-show. */
const INTERVIEW_OFFSET_HOURS = [5, 26, 30, 50, 74, 98, -24, -48, -72, -120];

export type SeedRow = {
  k: number; jobIndex: number; stage: ApplicationStage; outcome: ApplicationOutcome;
  source: string; rating: number | null; appliedDaysAgo: number; appliedHoursAgo: number;
  offeredDaysAfter: number | null; hiredDaysAfter: number | null; pool_status: PoolStatus;
};

/** Everything about application `i` (1-based), by arithmetic alone. */
export function seedRow(i: number): SeedRow {
  const k = (i * 37) % 248;
  const s = (i * 91) % 248;
  const w = (i * 53) % 248;
  const jobIndex = JOB_SEEDS.findIndex((job) => i <= job.upTo);
  const stage: ApplicationStage =
    k < 2 ? 'hired' : k < 4 ? 'offer' : k < 38 ? 'interview' : k < 96 ? 'screening' : 'applied';
  let outcome: ApplicationOutcome = 'active';
  if (stage === 'applied') outcome = k % 40 === 3 ? 'withdrawn' : k % 5 < 2 ? 'rejected' : 'active';
  else if (stage === 'screening') outcome = k % 4 === 0 ? 'rejected' : 'active';
  else if (stage === 'interview') outcome = k >= 20 && k % 6 === 0 ? 'rejected' : 'active';
  const source = SOURCE_UP_TO.find(([, upTo]) => s < upTo)![0];
  const rating =
    stage === 'hired' || stage === 'offer' ? 5
    : stage === 'interview' ? (k % 3 === 0 ? 5 : 4)
    : stage === 'screening' ? 3 + (k % 2)
    : k % 3 === 0 ? null : 2 + (k % 3);
  const week = WEEK_UP_TO.findIndex((upTo) => w < upTo);
  // The furthest-along applications are a month old, so their offer, hire and
  // interview dates all fall after they applied and before now.
  const early = k < 14;
  return {
    k, jobIndex, stage, outcome, source, rating,
    // 28 to 54 days: old enough for the offer and hire dates, inside the 8-week trend.
    appliedDaysAgo: early ? 28 + k * 2 : (7 - week) * 7 + ((i * 11) % 7),
    appliedHoursAgo: early ? 0 : (i * 5) % 24,
    offeredDaysAfter: k < 4 ? 17 + k : null,
    hiredDaysAfter: k < 2 ? 26 + k * 2 : null,
    pool_status: outcome === 'rejected' && k % 10 === 0 ? 'available' : 'none',
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const klDate = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });

const describeJob = (title: string, department: string) =>
  `Rimba Ventures is hiring for the role of ${title} in our ${department} team.\n\n` +
  `You will own day-to-day ${department.toLowerCase()} work, report to the head of ${department}, ` +
  `and work closely with the rest of the company.\n\n` +
  `We are looking for relevant experience, clear communication in Bahasa Malaysia and English, ` +
  `and someone who finishes what they start.`;

/** The same instant moved to 09:00–17:00 in Kuala Lumpur, on the hour or half hour. */
function workingTime(ms: number): number {
  const KL = 8 * HOUR;
  const local = new Date(ms + KL);
  const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const clamped = Math.min(17 * 60, Math.max(9 * 60, Math.round(minutes / 30) * 30));
  return dayStart + clamped * 60_000 - KL;
}

export function createSeedHireData(now: Date = new Date()): HireData {
  const t = now.getTime();

  const jobs: Job[] = JOB_SEEDS.map((job, index) => ({
    id: `job-${index + 1}`,
    title: job.title,
    department: job.department,
    location: job.location,
    employment_type: job.employment_type,
    status: job.status,
    description: job.status === 'draft' ? null : describeJob(job.title, job.department),
    salary_min_cents: job.salary ? job.salary[0] * 100 : null,
    salary_max_cents: job.salary ? job.salary[1] * 100 : null,
    show_salary: job.show_salary,
    closes_on: job.closesInDays === null ? null : klDate(t + job.closesInDays * DAY),
    work_arrangement: job.work_arrangement,
    headcount: job.headcount,
    opened_at: job.openedDaysAgo === null ? null : iso(t - job.openedDaysAgo * DAY),
    closed_at: job.closedDaysAgo === null ? null : iso(t - job.closedDaysAgo * DAY),
    created_at: iso(t - (job.openedDaysAgo ?? 2) * DAY),
  }));

  const rows = Array.from({ length: SEED_APPLICATIONS }, (_, index) => seedRow(index + 1));

  const candidates: Candidate[] = Array.from({ length: SEED_CANDIDATES }, (_, index) => {
    const n = index + 1;
    const row = n <= SEED_APPLICATIONS ? rows[index] : null;
    return {
      id: `cand-${n}`,
      name: `${FIRST[index % 19]} ${LAST[Math.floor(index / 19)]}`,
      email: `calon${n}@demo.openkuasa.com`,
      phone: `+60 12-555 ${String(n).padStart(4, '0')}`,
      headline: row ? JOB_SEEDS[row.jobIndex].title : POOL_HEADLINES[n % 6],
      location: LOCATIONS[n % 5],
      skills: SKILLS[n % 6],
      source: row ? row.source : POOL_SOURCES[n % 4],
      pool_status: row ? row.pool_status : POOL_STATUSES[n % 3],
      created_at: iso(t - (row ? row.appliedDaysAgo * DAY + row.appliedHoursAgo * HOUR : (90 + (n % 60)) * DAY)),
    };
  });

  const applications: Application[] = rows.map((row, index) => {
    const applied = t - row.appliedDaysAgo * DAY - row.appliedHoursAgo * HOUR;
    return {
      id: `app-${index + 1}`,
      candidate_id: candidates[index].id,
      job_id: jobs[row.jobIndex].id,
      candidate_name: candidates[index].name,
      job_title: jobs[row.jobIndex].title,
      stage: row.stage,
      outcome: row.outcome,
      rating: row.rating,
      source: row.source,
      applied_at: iso(applied),
      offered_at: row.offeredDaysAfter === null ? null : iso(applied + row.offeredDaysAfter * DAY),
      hired_at: row.hiredDaysAfter === null ? null : iso(applied + row.hiredDaysAfter * DAY),
      created_at: iso(applied),
      cover_letter: null,
      cv_url: null,
      cv_path: null,
      portfolio_url: null,
      expected_salary_cents: null,
      consented_at: null,
      reject_reason: null,
    };
  });

  // Interviews go to the applications with k = 4..13, in that order.
  const byK = new Map(rows.map((row, index) => [row.k, applications[index]]));
  const interviews: Interview[] = INTERVIEW_OFFSET_HOURS.map((hours, index) => {
    const application = byK.get(index + 4)!;
    const status: InterviewStatus = index < 6 ? 'scheduled' : index < 9 ? 'completed' : 'no_show';
    let scheduled = workingTime(t + hours * HOUR);
    // Snapping must not pull an upcoming interview back to now or earlier.
    if (status === 'scheduled' && scheduled <= t) scheduled += DAY;
    return {
      id: `int-${index + 1}`,
      application_id: application.id,
      candidate_name: application.candidate_name,
      job_title: application.job_title,
      scheduled_at: iso(scheduled),
      kind: KINDS[index % 3],
      interviewer_name: INTERVIEWERS[index % 4],
      status,
      created_at: iso(t - 6 * DAY),
    };
  });

  const newestFirst = <T extends { created_at: string }>(list: T[]) =>
    [...list].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return {
    listJobs: async () => newestFirst(jobs),
    listCandidates: async () => newestFirst(candidates),
    listApplications: async () =>
      [...applications].sort((a, b) => b.applied_at.localeCompare(a.applied_at)),
    listInterviews: async () =>
      [...interviews].sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at)),
    getSettings: async () => ({ org_id: null, ...DEFAULT_HIRE_SETTINGS }),
  };
}
