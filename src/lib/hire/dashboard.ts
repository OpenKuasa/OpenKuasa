// src/lib/hire/dashboard.ts
import { STAGE_LABEL, funnelCounts } from './applications-view';
import { applicantsByJob, overviewTotals, sourceBreakdown, type OverviewTotals, type SourceRow } from './overview';
import { APPLICATION_STAGES, type Application, type ApplicationStage, type HireData, type Interview } from './types';

const DAY = 86_400_000;
const TZ = 'Asia/Kuala_Lumpur';

export type TimeToHire = {
  /** Average days from applying to an offer, to one decimal; null when there were no offers. */
  days_to_offer: number | null;
  days_to_hire: number | null;
  offers: number;
  hires: number;
};

/** A hire counts only while the application is live: a hired application later withdrawn is not a hire. */
const isLiveHire = (a: Application) => a.hired_at !== null && a.outcome === 'active';
const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY;
const average = (values: number[]): number | null =>
  values.length === 0 ? null : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;

export function timeToHire(apps: Application[]): TimeToHire {
  const offers = apps.filter((a) => a.offered_at !== null).map((a) => days(a.applied_at, a.offered_at!));
  const hires = apps.filter(isLiveHire).map((a) => days(a.applied_at, a.hired_at!));
  return {
    days_to_offer: average(offers),
    days_to_hire: average(hires),
    offers: offers.length,
    hires: hires.length,
  };
}

const monthKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 7); // YYYY-MM
// A fixed list: a locale's own short month names vary ("Sep" or "Sept").
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (d: Date) => MONTHS[Number(monthKey(d).slice(5, 7)) - 1];

/** Average days to offer and to hire for each of the last `months` months, by when it happened. */
export function timeToHireByMonth(apps: Application[], now: Date, months = 8) {
  return Array.from({ length: months }, (_, i) => {
    // The 15th keeps the month right across time zones and month lengths.
    const [year, month] = monthKey(now).split('-').map(Number);
    const d = new Date(Date.UTC(year, month - 1 - (months - 1 - i), 15));
    const key = monthKey(d);
    const offered = apps.filter((a) => a.offered_at !== null && monthKey(new Date(a.offered_at)) === key);
    const hired = apps.filter((a) => isLiveHire(a) && monthKey(new Date(a.hired_at!)) === key);
    return {
      label: monthLabel(d),
      hire: average(hired.map((a) => days(a.applied_at, a.hired_at!))),
      offer: average(offered.map((a) => days(a.applied_at, a.offered_at!))),
    };
  });
}

/** "30m", "3h", "2d": how long before `now`. Anything not in the past is "now". */
export function ago(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!(ms > 0)) return 'now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (60 * 24))}d`;
}

/** The latest things that happened, read off the timestamps the tables hold. */
export function recentActivity(apps: Application[], interviews: Interview[], now: Date, limit = 5) {
  const events: { at: string; text: string }[] = [];
  for (const a of apps) {
    events.push({ at: a.applied_at, text: `${a.candidate_name} applied${a.source ? ` via ${a.source}` : ''} — ${a.job_title}` });
    if (a.offered_at) events.push({ at: a.offered_at, text: `Offer sent to ${a.candidate_name} — ${a.job_title}` });
    if (a.hired_at && a.outcome === 'active') events.push({ at: a.hired_at, text: `${a.candidate_name} hired — ${a.job_title}` });
  }
  for (const i of interviews) {
    if (i.status === 'completed') events.push({ at: i.scheduled_at, text: `${i.candidate_name} completed an interview — ${i.job_title}` });
  }
  return events
    .filter((e) => Date.parse(e.at) <= now.getTime())
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
    .map((e) => ({ text: e.text, when: ago(e.at, now) }));
}

export type HireDashboardModel = {
  isEmpty: boolean;
  totals: OverviewTotals;
  time: TimeToHire;
  timeByMonth: { label: string; hire: number | null; offer: number | null }[];
  byJob: { label: string; applications: number }[];
  hiresBySource: SourceRow[];
  funnel: { key: ApplicationStage; label: string; value: number }[];
  activity: { text: string; when: string }[];
};

export async function buildHireDashboardModel(data: HireData, now: Date): Promise<HireDashboardModel> {
  const [jobs, apps, interviews] = await Promise.all([
    data.listJobs(), data.listApplications(), data.listInterviews(),
  ]);
  const funnel = funnelCounts(apps);
  return {
    isEmpty: jobs.length === 0 && apps.length === 0 && interviews.length === 0,
    totals: overviewTotals(jobs, apps, interviews, now),
    time: timeToHire(apps),
    timeByMonth: timeToHireByMonth(apps, now),
    byJob: applicantsByJob(jobs, apps)
      .filter((row) => row.applicants > 0)
      .slice(0, 6)
      .map((row) => ({ label: row.job.title, applications: row.applicants })),
    hiresBySource: sourceBreakdown(apps).filter((row) => row.hires > 0),
    funnel: APPLICATION_STAGES.map((key) => ({ key, label: STAGE_LABEL[key], value: funnel[key] })),
    activity: recentActivity(apps, interviews, now, 5),
  };
}
