// src/lib/hire/overview.ts
import { formatWhen } from '@/lib/reach/overview';
import { STAGE_LABEL, funnelCounts, stageRank } from './applications-view';
import {
  APPLICATION_STAGES,
  type Application,
  type ApplicationStage,
  type HireData,
  type Interview,
  type Job,
} from './types';

const DAY = 86_400_000;

export type OverviewTotals = {
  applications: number;
  open_jobs: number;
  active_applications: number;
  interviews_next_7_days: number;
  offers_out: number;
  hires_last_30_days: number;
};

export function overviewTotals(jobs: Job[], apps: Application[], interviews: Interview[], now: Date): OverviewTotals {
  const t = now.getTime();
  return {
    applications: apps.length,
    open_jobs: jobs.filter((j) => j.status === 'open').length,
    active_applications: apps.filter((a) => a.outcome === 'active' && a.stage !== 'hired').length,
    interviews_next_7_days: interviews.filter((i) => {
      const at = Date.parse(i.scheduled_at);
      return i.status === 'scheduled' && at >= t && at < t + 7 * DAY;
    }).length,
    offers_out: apps.filter((a) => a.outcome === 'active' && a.stage === 'offer').length,
    hires_last_30_days: apps.filter((a) => a.hired_at !== null && a.outcome === 'active' && Date.parse(a.hired_at) <= t && t - Date.parse(a.hired_at) <= 30 * DAY).length,
  };
}

/** Applications received in each of the last `weeks` weeks, oldest first. */
export function applicationsPerWeek(apps: Application[], now: Date, weeks = 8) {
  const rows = Array.from({ length: weeks }, (_, i) => ({ label: `Wk${i + 1}`, applied: 0, shortlisted: 0 }));
  for (const a of apps) {
    const age = Math.floor((now.getTime() - Date.parse(a.applied_at)) / (7 * DAY));
    if (age < 0 || age >= weeks) continue;
    const row = rows[weeks - 1 - age];
    row.applied += 1;
    if (stageRank(a.stage) >= stageRank('interview')) row.shortlisted += 1;
  }
  return rows;
}

export type SourceRow = { source: string; applications: number; hires: number };

/** Applications and hires per source, the biggest source first. */
export function sourceBreakdown(apps: Application[]): SourceRow[] {
  const bySource = new Map<string, SourceRow>();
  for (const a of apps) {
    const source = a.source?.trim() || 'Unknown';
    const row = bySource.get(source) ?? { source, applications: 0, hires: 0 };
    row.applications += 1;
    if (a.stage === 'hired' && a.outcome === 'active') row.hires += 1;
    bySource.set(source, row);
  }
  return [...bySource.values()].sort(
    (a, b) => b.applications - a.applications || a.source.localeCompare(b.source),
  );
}

/** The best-rated live applications, furthest along first among equals. */
export function topCandidates(apps: Application[], limit = 5): Application[] {
  return apps
    .filter((a) => a.outcome === 'active' && a.rating !== null && a.stage !== 'hired')
    .sort(
      (a, b) =>
        (b.rating ?? 0) - (a.rating ?? 0) ||
        stageRank(b.stage) - stageRank(a.stage) ||
        b.applied_at.localeCompare(a.applied_at),
    )
    .slice(0, limit);
}

/** Scheduled interviews still ahead, soonest first. */
export function upcomingInterviews(interviews: Interview[], now: Date, limit = 3): Interview[] {
  return interviews
    .filter((i) => i.status === 'scheduled' && Date.parse(i.scheduled_at) > now.getTime())
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))
    .slice(0, limit);
}

/** Every job with how many applications it has, most applicants first. */
export function applicantsByJob(jobs: Job[], apps: Application[]): { job: Job; applicants: number }[] {
  const counts = new Map<string, number>();
  for (const a of apps) counts.set(a.job_id, (counts.get(a.job_id) ?? 0) + 1);
  return jobs
    .map((job) => ({ job, applicants: counts.get(job.id) ?? 0 }))
    .sort((a, b) => b.applicants - a.applicants || a.job.title.localeCompare(b.job.title));
}

const KIND_LABEL = { video: 'Video', onsite: 'Onsite', phone: 'Phone' } as const;

export type HireOverviewModel = {
  isEmpty: boolean;
  totals: OverviewTotals;
  trend: { label: string; applied: number; shortlisted: number }[];
  sources: SourceRow[];
  funnel: { key: ApplicationStage; label: string; value: number }[];
  interviews: { name: string; role: string; when: string; via: string; soon: boolean }[];
  top: { name: string; role: string; source: string; rating: number }[];
};

export async function buildHireOverviewModel(data: HireData, now: Date): Promise<HireOverviewModel> {
  const [jobs, apps, interviews] = await Promise.all([
    data.listJobs(), data.listApplications(), data.listInterviews(),
  ]);
  const funnel = funnelCounts(apps);
  return {
    isEmpty: jobs.length === 0 && apps.length === 0 && interviews.length === 0,
    totals: overviewTotals(jobs, apps, interviews, now),
    trend: applicationsPerWeek(apps, now),
    sources: sourceBreakdown(apps),
    funnel: APPLICATION_STAGES.map((key) => ({ key, label: STAGE_LABEL[key], value: funnel[key] })),
    interviews: upcomingInterviews(interviews, now, 3).map((i) => ({
      name: i.candidate_name,
      role: i.job_title,
      when: formatWhen(i.scheduled_at, now),
      via: KIND_LABEL[i.kind],
      soon: Date.parse(i.scheduled_at) - now.getTime() < 2 * DAY,
    })),
    top: topCandidates(apps, 5).map((a) => ({
      name: a.candidate_name,
      role: a.job_title,
      source: a.source ?? 'Unknown',
      rating: a.rating ?? 0,
    })),
  };
}
