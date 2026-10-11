/**
 * Lekir (`hire`) domain types. Field names match the `hire_*` columns one to
 * one, so the Supabase provider maps rows directly and the seed provider can
 * stand in for it in dev and tests.
 */

export type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'internship';
export type JobStatus = 'draft' | 'open' | 'paused' | 'closed';
export type WorkArrangement = 'onsite' | 'hybrid' | 'remote';

export type Job = {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  employment_type: EmploymentType;
  status: JobStatus;
  /** Plain text. Needed before a job can be opened. */
  description: string | null;
  /** Monthly salary in sen. */
  salary_min_cents: number | null;
  salary_max_cents: number | null;
  /** Whether a public page may show the salary range. */
  show_salary: boolean;
  /** Last day to apply, as YYYY-MM-DD. */
  closes_on: string | null;
  work_arrangement: WorkArrangement | null;
  /** How many people are being hired for the role. */
  headcount: number;
  opened_at: string | null;
  closed_at: string | null;
  created_at: string;
};

/** The columns of `hire_jobs` that make a {@link Job}, for selects. */
export const JOB_COLUMNS =
  'id,title,department,location,employment_type,status,description,salary_min_cents,' +
  'salary_max_cents,show_salary,closes_on,work_arrangement,headcount,opened_at,closed_at,created_at';

export type PoolStatus = 'none' | 'available' | 'passive' | 're_engaged';

export type Candidate = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  headline: string | null;
  location: string | null;
  skills: string[];
  source: string | null;
  pool_status: PoolStatus;
  created_at: string;
};

export type ApplicationStage = 'applied' | 'screening' | 'interview' | 'offer' | 'hired';

/** The hiring stages, earliest to furthest. An application's `stage` is the furthest it reached. */
export const APPLICATION_STAGES: readonly ApplicationStage[] = [
  'applied',
  'screening',
  'interview',
  'offer',
  'hired',
];

export type ApplicationOutcome = 'active' | 'rejected' | 'withdrawn';

export type Application = {
  id: string;
  candidate_id: string;
  job_id: string;
  /** The candidate's name, joined in by the provider. */
  candidate_name: string;
  /** The job's title, joined in by the provider. */
  job_title: string;
  stage: ApplicationStage;
  outcome: ApplicationOutcome;
  /** 1 to 5, or null when not rated yet. */
  rating: number | null;
  source: string | null;
  applied_at: string;
  offered_at: string | null;
  hired_at: string | null;
  created_at: string;
  /** The applicant's cover letter, as plain text. */
  cover_letter: string | null;
  /** A link to the applicant's CV, as typed. Shown only through `safeLink`. */
  cv_url: string | null;
  /** Where the uploaded CV is held. Server-side only: it never goes to the browser or the model. */
  cv_path: string | null;
  /** A link to the applicant's portfolio, as typed. Shown only through `safeLink`. */
  portfolio_url: string | null;
  /** The monthly salary the applicant expects, in sen. */
  expected_salary_cents: number | null;
  /** When the applicant agreed to the privacy notice; null for applications added by hand. */
  consented_at: string | null;
};

export type InterviewKind = 'video' | 'onsite' | 'phone';
export type InterviewStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show';

export type Interview = {
  id: string;
  application_id: string;
  candidate_name: string;
  job_title: string;
  scheduled_at: string;
  kind: InterviewKind;
  interviewer_name: string | null;
  status: InterviewStatus;
  created_at: string;
};

/** Everything the screens and the AI tools read. One provider per request. */
export type HireData = {
  listJobs(): Promise<Job[]>;
  listCandidates(): Promise<Candidate[]>;
  listApplications(): Promise<Application[]>;
  listInterviews(): Promise<Interview[]>;
  getSettings(): Promise<HireSettings>;
};

/** A workspace's hiring settings. `org_id` is null only for the sample data. */
export type HireSettings = {
  org_id: string | null;
  /** Whether the public job board is on. */
  careers_enabled: boolean;
  careers_headline: string | null;
  careers_tagline: string | null;
  /** The apply form requires a CV (a link or a file). */
  require_cv: boolean;
  /** The apply form requires a cover letter. */
  require_cover_letter: boolean;
  /** The apply form asks for a portfolio link; optional for the applicant. */
  ask_portfolio: boolean;
  /** The apply form asks for the expected monthly salary; optional for the applicant. */
  ask_expected_salary: boolean;
};
export const SETTINGS_COLUMNS =
  'careers_enabled,careers_headline,careers_tagline,require_cv,require_cover_letter,ask_portfolio,ask_expected_salary';
/** What a workspace with no settings row has. */
export const DEFAULT_HIRE_SETTINGS: Omit<HireSettings, 'org_id'> = {
  careers_enabled: false, careers_headline: null, careers_tagline: null,
  require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false,
};
