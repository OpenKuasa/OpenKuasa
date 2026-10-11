// src/lib/ai/hire-tools.ts
/**
 * Lekir's lookup tools. Each reads through the {@link HireData} seam and calls
 * the same pure helpers the screens call, so a number in the chat is the number
 * on the screen. `org_id` is never taken from the model: isolation is the
 * provider's job. Change tools for jobs are added only for someone who may
 * write, and each one only runs after the user approves it.
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  type CapResult,
  type HireWriteContext,
  createJob,
  createJobInput,
  deleteJob,
  deleteJobInput,
  setJobStatus,
  setJobStatusInput,
  updateApplicationForm,
  updateApplicationFormInput,
  updateCareersPage,
  updateCareersPageInput,
  updateJob,
  updateJobInput,
} from '@/lib/hire/capabilities';
import { formatWhen } from '@/lib/reach/overview';
import { LOOKUP_MAX, limitSchema, rowLimit } from '@/lib/ai/limits';
import { applicationFormOf } from '@/lib/hire/application-form';
import { applicationLabel, funnelCounts, matchesText } from '@/lib/hire/applications-view';
import { timeToHire } from '@/lib/hire/dashboard';
import { careersPath, careersUrl } from '@/lib/hire/public-careers';
import { applicantsByJob, overviewTotals, sourceBreakdown } from '@/lib/hire/overview';
import { APPLICATION_STAGES, type HireData, type Job } from '@/lib/hire/types';

export const HIRE_TOOL_NAMES = [
  'getHiringOverview',
  'listJobs',
  'listApplications',
  'getHiringFunnel',
  'listTalentPool',
  'listInterviews',
  'getTimeToHire',
  'getSourceBreakdown',
  'getCareersPage',
] as const;

const READ_ERROR = { ok: false as const, error: 'Could not read hiring data.' };

/** A lookup never throws at the model: a failed read is logged and reported plainly. */
async function safe<T>(name: string, read: () => Promise<T>): Promise<T | typeof READ_ERROR> {
  try {
    return await read();
  } catch (error) {
    console.error(`[lekir] ${name} failed:`, error instanceof Error ? error.message : error);
    return READ_ERROR;
  }
}

const jobTitle = z
  .string()
  .optional()
  .describe('Only this job, by title. Part of the title is enough, in any letter case.');
const includeContact = z
  .boolean()
  .optional()
  .describe(
    'Set true only when the user asked for contact details (email or phone) or, for applications, for what an applicant ' +
      'wrote on the form (cover letter, CV link, portfolio link, expected salary). Leave it out otherwise.',
  );
/** A cover letter cut to 600 characters, or null when there is none. */
function letterExcerpt(text: string | null): string | null {
  return text && text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

/** The first 160 characters of a description, or null when there is none. */
function excerpt(text: string | null | undefined): string | null {
  const t = text?.trim();
  if (!t) return null;
  return t.length > 160 ? `${t.slice(0, 160)}…` : t;
}

const limit = limitSchema(`How many rows to return, at most ${LOOKUP_MAX}.`);

/** The date in Kuala Lumpur, as YYYY-MM-DD: the day a closing date is checked against. */
const klToday = (now: Date) => now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });

export function createHireTools(
  data: HireData,
  nowArg: Date | (() => Date) = () => new Date(),
  write?: { ctx: HireWriteContext; canWrite: boolean },
  site?: { origin: string | null },
): ToolSet {
  const now = typeof nowArg === 'function' ? nowArg : () => nowArg;

  const read: ToolSet = {
    getHiringOverview: tool({
      description:
        'Hiring at a glance: open jobs, all applications received, live applications, interviews scheduled in the next 7 days, ' +
        'offers waiting on an answer, and hires in the last 30 days.',
      inputSchema: z.object({}),
      execute: async () =>
        safe('getHiringOverview', async () => {
          const [jobs, apps, interviews] = await Promise.all([
            data.listJobs(), data.listApplications(), data.listInterviews(),
          ]);
          return overviewTotals(jobs, apps, interviews, now());
        }),
    }),

    listJobs: tool({
      description:
        'List the job openings with status, department, location and how many people applied. ' +
        'Most applicants first. Optionally filter by status or department. ' +
        'Each job has an id to pass to a change tool, and says whether it has a description yet.',
      inputSchema: z.object({
        status: z.enum(['draft', 'open', 'paused', 'closed']).optional().describe('Only jobs with this status.'),
        department: z.string().optional().describe('Only this department. Part of the name is enough.'),
        limit,
      }),
      execute: async ({ status, department, limit: requested }) =>
        safe('listJobs', async () => {
          const [jobs, apps] = await Promise.all([data.listJobs(), data.listApplications()]);
          const rows = applicantsByJob(jobs, apps).filter(
            ({ job }) => (!status || job.status === status) && matchesText(job.department, department),
          );
          return {
            total: rows.length,
            // A closing date is an absolute date, so "in two weeks" needs a today to count from.
            today_in_malaysia: klToday(now()),
            jobs: rows.slice(0, rowLimit(requested, LOOKUP_MAX)).map(({ job, applicants }) => ({
              id: job.id,
              // The approval titles read a row's name from `name`.
              name: job.title,
              title: job.title,
              department: job.department,
              location: job.location,
              employment_type: job.employment_type,
              status: job.status,
              applicants,
              opened_at: job.opened_at,
              work_arrangement: job.work_arrangement,
              headcount: job.headcount,
              salary_min_cents: job.salary_min_cents,
              salary_max_cents: job.salary_max_cents,
              show_salary: job.show_salary,
              closes_on: job.closes_on,
              has_description: Boolean(job.description?.trim()),
              // Not the whole description: 50 jobs of up to 10,000 characters would go to the model on every lookup.
              description_excerpt: excerpt(job.description),
            })),
          };
        }),
    }),

    listApplications: tool({
      description:
        'List job applications, newest first: the candidate, the job, the stage reached ' +
        '(applied, screening, interview, offer, hired), whether it is still live, the rating out of 5, ' +
        'the source. Email, phone, cover letter, CV link, portfolio link and expected salary are returned only when includeContact is set. Filter by job, stage or outcome.',
      inputSchema: z.object({
        jobTitle,
        stage: z.enum(['applied', 'screening', 'interview', 'offer', 'hired']).optional()
          .describe("Only applications whose furthest stage reached is this one, including rejected ones. Add outcome: 'active' for the ones still live."),
        outcome: z.enum(['active', 'rejected', 'withdrawn']).optional()
          .describe('Only live (active), rejected or withdrawn applications.'),
        includeContact,
        limit,
      }),
      execute: async ({ jobTitle: title, stage, outcome, includeContact: withContact, limit: requested }) =>
        safe('listApplications', async () => {
          const apps = await data.listApplications();
          const people = withContact
            ? new Map((await data.listCandidates()).map((c) => [c.id, c]))
            : null;
          const rows = apps.filter(
            (a) => matchesText(a.job_title, title) && (!stage || a.stage === stage) && (!outcome || a.outcome === outcome),
          );
          return {
            total: rows.length,
            applications: rows.slice(0, rowLimit(requested, 20)).map((a) => ({
              candidate: a.candidate_name,
              job: a.job_title,
              stage: a.stage,
              outcome: a.outcome,
              label: applicationLabel(a.stage, a.outcome),
              rating: a.rating,
              source: a.source,
              applied_at: a.applied_at,
              ...(people && {
                email: people.get(a.candidate_id)?.email ?? null,
                phone: people.get(a.candidate_id)?.phone ?? null,
                cover_letter: letterExcerpt(a.cover_letter),
                cv_url: a.cv_url,
                has_cv_file: a.cv_path !== null,
                portfolio_url: a.portfolio_url,
                expected_salary_cents: a.expected_salary_cents,
              }),
            })),
          };
        }),
    }),

    getHiringFunnel: tool({
      description:
        'The hiring funnel: how many applications reached each stage (applied, screening, interview, ' +
        'offer, hired) and the share that moved on from each stage to the next. For all jobs, or one.',
      inputSchema: z.object({ jobTitle }),
      execute: async ({ jobTitle: title }) =>
        safe('getHiringFunnel', async () => {
          const apps = (await data.listApplications()).filter((a) => matchesText(a.job_title, title));
          const reached = funnelCounts(apps);
          return {
            applications: apps.length,
            reached,
            /** Percent of those who reached a stage that went on to the next one. */
            moved_on_pct: APPLICATION_STAGES.slice(0, -1).map((stage, index) => {
              const next = APPLICATION_STAGES[index + 1];
              return {
                from: stage,
                to: next,
                pct: reached[stage] === 0 ? null : Math.round((reached[next] / reached[stage]) * 1000) / 10,
              };
            }),
          };
        }),
    }),

    listTalentPool: tool({
      description:
        'List the saved candidates in the talent pool with their headline, skills, location, source. ' +
        'Email and phone are returned only when includeContact is set. Filter by a skill, a location or their pool status.',
      inputSchema: z.object({
        skill: z.string().optional().describe('Only candidates with this skill. Part of the skill is enough.'),
        location: z.string().optional().describe('Only candidates in this place.'),
        poolStatus: z.enum(['available', 'passive', 're_engaged']).optional().describe('Only this pool status.'),
        includeContact,
        limit,
      }),
      execute: async ({ skill, location, poolStatus, includeContact: withContact, limit: requested }) =>
        safe('listTalentPool', async () => {
          const rows = (await data.listCandidates()).filter(
            (c) =>
              c.pool_status !== 'none' &&
              (!poolStatus || c.pool_status === poolStatus) &&
              matchesText(c.location, location) &&
              (!skill?.trim() || c.skills.some((s) => matchesText(s, skill))),
          );
          return {
            total: rows.length,
            candidates: rows.slice(0, rowLimit(requested, 20)).map((c) => ({
              name: c.name,
              headline: c.headline,
              skills: c.skills,
              location: c.location,
              source: c.source,
              pool_status: c.pool_status,
              ...(withContact && { email: c.email, phone: c.phone }),
            })),
          };
        }),
    }),

    listInterviews: tool({
      description:
        'List interviews with the candidate, the job, the time, how it is held (video, onsite, phone), ' +
        'the interviewer and the status. Ask for upcoming or past ones, or filter by status. ' +
        '`when` is the time in Kuala Lumpur, relative to today; use it when telling the user the time.',
      inputSchema: z.object({
        when: z.enum(['upcoming', 'past']).optional().describe('Only interviews still ahead, or only ones already past.'),
        status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional().describe('Only this status.'),
        limit,
      }),
      execute: async ({ when, status, limit: requested }) =>
        safe('listInterviews', async () => {
          const t = now().getTime();
          const rows = (await data.listInterviews()).filter((i) => {
            const ahead = Date.parse(i.scheduled_at) > t;
            if (when === 'upcoming' && !(ahead && i.status === 'scheduled')) return false;
            if (when === 'past' && ahead) return false;
            return !status || i.status === status;
          });
          // Past interviews read better latest first; the rest soonest first. Not left to the provider's order.
          const ordered = [...rows].sort((a, b) =>
            when === 'past'
              ? Date.parse(b.scheduled_at) - Date.parse(a.scheduled_at)
              : Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at),
          );
          return {
            total: rows.length,
            interviews: ordered.slice(0, rowLimit(requested, 20)).map((i) => ({
              candidate: i.candidate_name,
              job: i.job_title,
              scheduled_at: i.scheduled_at,
              when: formatWhen(i.scheduled_at, now()),
              kind: i.kind,
              interviewer: i.interviewer_name,
              status: i.status,
            })),
          };
        }),
    }),

    getTimeToHire: tool({
      description:
        'How long hiring takes: the average days from applying to an offer and to being hired, and how ' +
        'many offers and hires that is based on. For all jobs, or one. A null average means there were none.',
      inputSchema: z.object({ jobTitle }),
      execute: async ({ jobTitle: title }) =>
        safe('getTimeToHire', async () =>
          timeToHire((await data.listApplications()).filter((a) => matchesText(a.job_title, title))),
        ),
    }),

    getSourceBreakdown: tool({
      description:
        'Where candidates come from: applications and hires per source (for example JobStreet, LinkedIn, ' +
        'referral, the careers page), the biggest source first.',
      inputSchema: z.object({}),
      execute: async () =>
        safe('getSourceBreakdown', async () => ({ sources: sourceBreakdown(await data.listApplications()) })),
    }),

    getCareersPage: tool({
      description:
        'The public careers page: whether it is on, its address, its headline and tagline, and how many jobs it is showing. ' +
        'When it is off nothing is public. ' +
        'Also what the application form asks for: whether a CV and a cover letter are required, and whether a portfolio link and expected salary are asked for.',
      inputSchema: z.object({}),
      execute: async () =>
        safe('getCareersPage', async () => {
          const [settings, jobs] = await Promise.all([data.getSettings(), data.listJobs()]);
          const path = settings.org_id ? careersPath(settings.org_id) : null;
          const origin = site?.origin ?? null;
          return {
            enabled: settings.careers_enabled,
            headline: settings.careers_headline,
            tagline: settings.careers_tagline,
            application_form: applicationFormOf(settings),
            path,
            url: settings.careers_enabled && origin && settings.org_id ? careersUrl(origin, settings.org_id) : null,
            // Only open jobs with a description are listed publicly.
            jobs_showing: settings.careers_enabled
              ? jobs.filter((j) => j.status === 'open' && j.description?.trim()).length
              : 0,
          };
        }),
    }),
  };
  if (!write?.canWrite) return read;
  const { ctx } = write;
  // The approval titles learn a row's name from a `name` field; a job has `title`.
  const named = (result: CapResult<Job>) =>
    result.ok ? { ...result, data: { ...result.data, name: result.data.title } } : result;
  // closes_on is an absolute date; without this the model has to guess the year.
  const today = ` Today in Malaysia is ${klToday(now())}.`;
  return {
    ...read,
    createJob: tool({
      description:
        'Create a job opening. It is always created as a draft: nothing is open until it is opened. ' +
        'Only a title is needed; give the description when you have one.' +
        today,
      inputSchema: createJobInput,
      execute: async (input) => named(await createJob(ctx, input, now())),
    }),
    updateJob: tool({
      description:
        "Change a job's details. Send only the fields that change. Does not change its status." + today,
      inputSchema: updateJobInput,
      execute: async (input) => named(await updateJob(ctx, input, now())),
    }),
    setJobStatus: tool({
      description:
        'Open, pause or close a job. A draft can be opened; an open job paused or closed; a paused job ' +
        'opened or closed; a closed job reopened. Opening needs a description.',
      inputSchema: setJobStatusInput,
      execute: async (input) => named(await setJobStatus(ctx, input, now())),
    }),
    deleteJob: tool({
      description: 'Delete a job for good. Only a job with no applications can be deleted; otherwise close it.',
      inputSchema: deleteJobInput,
      execute: async (input) => deleteJob(ctx, input),
    }),
    updateCareersPage: tool({
      description:
        'Turn the public careers page on or off, or change its headline and tagline. Send only what changes. ' +
        'Turning it on makes every open job visible to anyone with the link.',
      inputSchema: updateCareersPageInput,
      execute: async (input) => updateCareersPage(ctx, input, now()),
    }),
    updateApplicationForm: tool({
      description:
        'Change what the public application form asks for. Send only the switches that change. ' +
        'A CV and a cover letter are required when on; a portfolio link and expected salary are asked for, and optional, when on. ' +
        'Use getCareersPage to see the current switches.',
      inputSchema: updateApplicationFormInput,
      execute: async (input) => updateApplicationForm(ctx, input, now()),
    }),
  };
}
