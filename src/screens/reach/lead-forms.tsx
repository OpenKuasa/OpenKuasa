import { headers } from 'next/headers';
import { BarChart3, Filter, PieChart, TrendingUp } from 'lucide-react';
import { BentoCard, BentoStat } from '@/components/bento/bento';
import {
  AreaTrend,
  BarGroup,
  DonutStat,
  FunnelFlow,
  Sparkline,
  type Series,
  type Slice,
} from '@/components/charts';
import {
  LeadFormsView,
  type LeadFormActions,
  type LeadFormSubmissionActions,
} from '@/components/reach/lead-forms-view';
import {
  createFormAction,
  deleteFormAction,
  deleteFormSubmissionAction,
  listFormSubmissionsAction,
  setFormStatusAction,
  updateFormAction,
} from '@/app/(app)/reach/actions';
import { getViewer } from '@/lib/auth/viewer';
import { can } from '@/lib/auth/permissions';
import { formKpis } from '@/lib/reach/forms';
import {
  type SubmissionsTrendPoint,
  originFromHeaders,
  submissionsToday,
  submissionsTrend,
  submissionsTrendStart,
} from '@/lib/reach/form-submissions';
import type { Form, ReachData } from '@/lib/reach/types';
import { loadReachData } from './parts';

/*
 * ---- demo-only values: no live source yet (shown only to demo viewers) ----
 *
 * The demo workspace's forms are samples with no public page behind them, so
 * it has counts but no submissions to count from. A real workspace gets "New
 * today" and "Submissions over time" from its own submissions (below), and is
 * not shown the rest: a form start is not recorded, and a submission does not
 * say which channel it came from.
 */

/* KPI sparkline trends ------------------------------------------------ */
const SPARK_FORMS = [2, 3, 3, 4, 4, 5, 5, 6];
const SPARK_LEADS = [268, 296, 318, 347, 371, 392, 410, 428];
const SPARK_CONV = [14.1, 14.8, 15.2, 16.0, 16.6, 17.2, 17.6, 18.0];
const SPARK_TODAY = [6, 8, 9, 11, 8, 10, 13, 12];

/* Submissions over time (last 14 days) — ends at 12 = new today ------- */
const SUBMISSIONS_TREND = [
  { label: '26', submissions: 6 },
  { label: '27', submissions: 8 },
  { label: '28', submissions: 7 },
  { label: '29', submissions: 9 },
  { label: '30', submissions: 11 },
  { label: '1', submissions: 8 },
  { label: '2', submissions: 10 },
  { label: '3', submissions: 13 },
  { label: '4', submissions: 9 },
  { label: '5', submissions: 11 },
  { label: '6', submissions: 14 },
  { label: '7', submissions: 10 },
  { label: '8', submissions: 13 },
  { label: '9', submissions: 12 },
];
const SUBMISSIONS_SERIES: Series[] = [
  { key: 'submissions', label: 'Submissions', color: 'var(--chart-1)' },
];

/* Conversion funnel --------------------------------------------------- */
const FUNNEL: Slice[] = [
  { key: 'views', label: 'Views', value: 2378, color: 'var(--chart-1)' },
  { key: 'starts', label: 'Form starts', value: 1150, color: 'var(--chart-2)' },
  { key: 'submits', label: 'Submits', value: 428, color: 'var(--chart-5)' },
];

/* Top forms by contacts ----------------------------------------------- */
const TOP_FORMS = [
  { label: 'Raya Promo', contacts: 128 },
  { label: 'Free Consult', contacts: 96 },
  { label: 'Newsletter', contacts: 84 },
  { label: 'Product Demo', contacts: 62 },
  { label: 'eBook', contacts: 38 },
  { label: 'Event RSVP', contacts: 20 },
];
const TOP_FORMS_SERIES: Series[] = [
  { key: 'contacts', label: 'Contacts', color: 'var(--chart-1)' },
];

/* Submissions by source ----------------------------------------------- */
const SOURCE_MIX: Slice[] = [
  { key: 'whatsapp', label: 'WhatsApp', value: 182, color: 'var(--chart-1)' },
  { key: 'facebook', label: 'Facebook', value: 118, color: 'var(--chart-2)' },
  { key: 'instagram', label: 'Instagram', value: 84, color: 'var(--chart-5)' },
  { key: 'tiktok', label: 'TikTok', value: 44, color: 'var(--chart-3)' },
];

/* ---- live ----------------------------------------------------------- */

const TOP_FORMS_LIMIT = 6;

/** The forms with the most contacts, for the live bar chart. */
function topForms(forms: Form[]) {
  return [...forms]
    .filter((f) => f.submissions_count > 0)
    .sort((a, b) => b.submissions_count - a.submissions_count)
    .slice(0, TOP_FORMS_LIMIT)
    .map((f) => ({ label: f.name, contacts: f.submissions_count }));
}

/** What a real workspace's own submissions add to the screen. */
type SubmissionFigures = { today: number; trend: SubmissionsTrendPoint[] };

/**
 * "New today" and the 14-day trend, counted from when each submission came in.
 * Null when they cannot be read (a provider with no submissions, or a database
 * that does not have the table yet): the screen then shows what it showed
 * before, rather than failing.
 */
async function loadSubmissionFigures(data: ReachData, now: Date): Promise<SubmissionFigures | null> {
  if (!data.listFormSubmissionTimes) return null;
  try {
    const times = await data.listFormSubmissionTimes(submissionsTrendStart(now));
    return { today: submissionsToday(times, now), trend: submissionsTrend(times, now) };
  } catch (error) {
    console.error('[lead-forms] reading submissions failed:', error);
    return null;
  }
}

/* ------------------------------------------------------------------ */

/**
 * Lead Forms, shown by Jebat at /reach/lead-forms and by Kasturi at
 * /crm/lead-forms. Both read the same workspace's forms through the reach
 * provider, and both write through the reach capabilities.
 */
export default async function LeadFormsScreen() {
  const [data, viewer, requestHeaders] = await Promise.all([
    loadReachData(),
    getViewer(),
    headers(),
  ]);
  const forms: Form[] = await data.listForms();
  const kpis = formKpis(forms);
  const isDemo = viewer.isDemo;
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  const actions: LeadFormActions | undefined = canEdit
    ? {
        create: createFormAction,
        update: updateFormAction,
        setStatus: setFormStatusAction,
        remove: deleteFormAction,
      }
    : undefined;

  // A real workspace's forms have public pages; the demo's are samples.
  const figures = isDemo ? null : await loadSubmissionFigures(data, new Date());
  const publicOrigin = isDemo
    ? undefined
    : (originFromHeaders((name) => requestHeaders.get(name)) ?? undefined);
  const submissions: LeadFormSubmissionActions | undefined = isDemo
    ? undefined
    : {
        list: listFormSubmissionsAction,
        remove: canEdit ? deleteFormSubmissionAction : undefined,
      };

  const totalForms = kpis.total_forms.toLocaleString('en-US');
  const totalLeads = kpis.total_leads.toLocaleString('en-US');
  const liveTopForms = topForms(forms);

  // The three figures are counted from the forms themselves in every mode. Only
  // the demo adds the sample deltas, sparklines and the widgets with no source.
  const top = isDemo ? (
    <>
      <BentoCard tone="primary" className="col-span-1 md:col-span-3">
        <BentoStat
          label="Total forms"
          value={totalForms}
          delta="+1"
          onPrimary
          chart={
            <Sparkline data={SPARK_FORMS} color="var(--primary-foreground)" height={36} />
          }
        />
      </BentoCard>
      <BentoCard className="col-span-1 md:col-span-3">
        <BentoStat
          label="Total leads"
          value={totalLeads}
          delta="+8%"
          deltaTone="up"
          chart={<Sparkline data={SPARK_LEADS} color="var(--chart-2)" height={36} />}
        />
      </BentoCard>
      <BentoCard className="col-span-1 md:col-span-3">
        <BentoStat
          label="Conversion"
          value={kpis.conversion}
          delta="+1.4pt"
          deltaTone="up"
          chart={<Sparkline data={SPARK_CONV} color="var(--chart-1)" height={36} />}
        />
      </BentoCard>
      <BentoCard className="col-span-1 md:col-span-3">
        <BentoStat
          label="New today"
          value="12"
          delta="+3"
          deltaTone="up"
          chart={<Sparkline data={SPARK_TODAY} color="var(--chart-3)" height={36} />}
        />
      </BentoCard>

      {/* Submissions trend + conversion funnel */}
      <BentoCard
        title="Submissions over time"
        subtitle="Last 14 days"
        icon={TrendingUp}
        className="col-span-2 md:col-span-8"
      >
        <AreaTrend data={SUBMISSIONS_TREND} series={SUBMISSIONS_SERIES} height={240} />
      </BentoCard>
      <BentoCard
        title="Conversion funnel"
        subtitle="Views → starts → submits"
        icon={Filter}
        className="col-span-2 md:col-span-4"
      >
        <FunnelFlow data={FUNNEL} height={240} />
      </BentoCard>
    </>
  ) : figures ? (
    <>
      <BentoCard tone="primary" className="col-span-1 md:col-span-3">
        <BentoStat label="Total forms" value={totalForms} onPrimary />
      </BentoCard>
      <BentoCard className="col-span-1 md:col-span-3">
        <BentoStat label="Total leads" value={totalLeads} />
      </BentoCard>
      <BentoCard className="col-span-1 md:col-span-3">
        <BentoStat label="Conversion" value={kpis.conversion} />
      </BentoCard>
      <BentoCard className="col-span-1 md:col-span-3">
        <BentoStat label="New today" value={figures.today.toLocaleString('en-US')} />
      </BentoCard>

      {/* No funnel beside it: a form start is not recorded. */}
      <BentoCard
        title="Submissions over time"
        subtitle="Last 14 days"
        icon={TrendingUp}
        className="col-span-2 md:col-span-12"
      >
        <AreaTrend data={figures.trend} series={SUBMISSIONS_SERIES} height={240} />
      </BentoCard>
    </>
  ) : (
    <>
      <BentoCard tone="primary" className="col-span-2 md:col-span-4">
        <BentoStat label="Total forms" value={totalForms} onPrimary />
      </BentoCard>
      <BentoCard className="col-span-1 md:col-span-4">
        <BentoStat label="Total leads" value={totalLeads} />
      </BentoCard>
      <BentoCard className="col-span-1 md:col-span-4">
        <BentoStat label="Conversion" value={kpis.conversion} />
      </BentoCard>
    </>
  );

  const bottom = isDemo ? (
    <>
      <BentoCard
        title="Top forms by contacts"
        subtitle="This quarter"
        icon={BarChart3}
        className="col-span-2 md:col-span-8"
      >
        <BarGroup data={TOP_FORMS} series={TOP_FORMS_SERIES} horizontal height={220} />
      </BentoCard>
      <BentoCard
        title="Submissions by source"
        icon={PieChart}
        className="col-span-2 md:col-span-4"
      >
        <DonutStat data={SOURCE_MIX} height={220} centerValue="428" centerLabel="leads" />
      </BentoCard>
    </>
  ) : liveTopForms.length > 0 ? (
    <BentoCard
      title="Top forms by contacts"
      subtitle="All time"
      icon={BarChart3}
      className="col-span-2 md:col-span-12"
    >
      <BarGroup data={liveTopForms} series={TOP_FORMS_SERIES} horizontal height={220} />
    </BentoCard>
  ) : null;

  return (
    <LeadFormsView
      forms={forms}
      actions={actions}
      publicOrigin={publicOrigin}
      submissions={submissions}
      top={top}
      bottom={bottom}
    />
  );
}
