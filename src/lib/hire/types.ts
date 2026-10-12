/**
 * Lekir (`hire`) domain types. Field names match the `hire_*` columns one to
 * one, so the Supabase provider maps rows directly and the seed provider can
 * stand in for it in dev and tests.
 */
import type { RejectReason } from './application-changes';
import type { Feedback } from './interview-feedback';

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
  /**
   * The person's talent pool status, joined in by the provider (`none`: not in the pool). Optional so an
   * application written out by hand in a test still type-checks; both providers always fill it, and a
   * missing value is read as `none`.
   */
  candidate_pool_status?: PoolStatus;
  stage: ApplicationStage;
  outcome: ApplicationOutcome;
  /** Why it was rejected, when a reason was given. */
  reject_reason: RejectReason | null;
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
  /** The start, as an instant. Shown in Kuala Lumpur time everywhere. */
  scheduled_at: string;
  /** Whole minutes, 15 to 480. */
  duration_minutes: number;
  kind: InterviewKind;
  /** Where it is held, or the meeting link: one line of free text, at most 300 characters. Shown as a link only through `safeLink`. */
  place: string | null;
  /** A typed name, not a team member. */
  interviewer_name: string | null;
  /** For the team only: never in the invitation, the calendar file or a result an assistant is given to pass on. */
  notes: string | null;
  status: InterviewStatus;
  created_at: string;
  /** When the row last changed. The reschedule form sends it back, so a stale form saves nothing. */
  updated_at: string;
  /** The stage of the interview's application, joined in by the provider: what "Move to Interview" is offered on. */
  application_stage: ApplicationStage;
  /** Whether the interview's application is still active, joined in by the provider: a closed one cannot be rescheduled. */
  application_outcome: ApplicationOutcome;
  /**
   * The interview's one feedback: a rating, a recommendation and comments, with when it was last saved. Only a
   * completed interview has any. Optional so an interview written out by hand in a test still type-checks: left
   * out, or null, reads as none.
   */
  feedback?: Feedback | null;
};

/** One interview as an approval card describes it: who, which job, when and how. Nothing to contact anyone by. */
export type InterviewCardRow = {
  id: string;
  application_id: string;
  /** The candidate's name. */
  candidate: string;
  /** The job's title. */
  job: string;
  scheduled_at: string;
  kind: InterviewKind;
  status: InterviewStatus;
  /** Whole minutes. */
  duration_minutes: number;
  /** Where it is held, or the meeting link. The team's own text: it goes to the browser on a card, never to a model. */
  place: string | null;
  /** What feedback the interview has, without its comments. Present only when it has some. Read for the card's "Now: …" line. */
  feedback?: Pick<Feedback, 'rating' | 'recommendation' | 'recorded_at'>;
};

/**
 * `target` is null when the interview is not there. `others`: every other interview whose candidate name and job
 * title are the same, of the same application or of a namesake's. `cut` when there were more than were read.
 * `also`: every other interview still SCHEDULED with this very CANDIDATE (by the candidate's id, across all their
 * applications; never a namesake's), soonest first, at most the first fifty: what a card lists so the person sees
 * there is more than one. `alsoClosed`: the same candidate's other interviews that are NOT scheduled (cancelled,
 * completed or a no-show), for the one change that acts on a closed interview. `application_outcome`: whether the
 * target's application is still active; null when there is no target.
 */
export type InterviewCardRead = {
  target: InterviewCardRow | null;
  others: InterviewCardRow[];
  cut: boolean;
  also: InterviewCardRow[];
  alsoClosed: InterviewCardRow[];
  application_outcome: ApplicationOutcome | null;
};

/** The most rows one list read returns: the API's page size. A list that long may have been cut short. */
export const HIRE_READ_CAP = 1000;

/** Everything the screens and the AI tools read. One provider per request. */
export type HireData = {
  listJobs(): Promise<Job[]>;
  listCandidates(): Promise<Candidate[]>;
  listApplications(): Promise<Application[]>;
  listInterviews(): Promise<Interview[]>;
  getSettings(): Promise<HireSettings>;
  /**
   * One row and the rows that share its name (for an application: the same candidate name and the same job title),
   * read by id and by name so that no page size can hide one. A provider over a database must have it. One that
   * holds every row in memory (the sample data) may leave it out: the lists are then used.
   */
  namesakes?(kind: 'application' | 'candidate', id: unknown): Promise<Namesakes>;
  /**
   * One candidate's stored talent pool status, read by id; null when the row is not there. A provider that holds
   * every row in memory (the sample data) may leave it out: the candidates list is then used.
   */
  poolStatusOf?(id: unknown): Promise<PoolStatus | null>;
  /**
   * One interview and the others that could be taken for it (the same candidate name and the same job title),
   * read by id and by name so that no page size can hide one. A provider over a database must have it. One that
   * holds every row in memory (the sample data) may leave it out: `interviewCardFromLists` is then used.
   */
  interviewCard?(id: unknown): Promise<InterviewCardRead>;
};

/** A candidate or an application as an approval card may need to describe it, to tell it from another of the same name. */
export type Namesake = {
  id: string;
  /** The candidate's name. */
  name: string;
  /** The job's title, for an application; null for a candidate. */
  job: string | null;
  email: string | null;
  location: string | null;
  headline: string | null;
  /** When the candidate was added, or the application made. */
  added_at: string;
};

/** `target` is null when the row is not there. `cut` when there were more same-named rows than were read. */
export type Namesakes = { target: Namesake | null; others: Namesake[]; cut: boolean };

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
