import { LEAD_CHANNELS, type Appointment, type Campaign, type LeadChannel, type Lead, type LeadStage } from '@/lib/reach/types';
import { deriveLeadSummary } from '@/lib/ai/tools';

export type ReportRange = '7d' | '30d' | '90d';
const RANGE_DAYS: Record<ReportRange, number> = { '7d': 7, '30d': 30, '90d': 90 };
const QUALIFIED_OR_BEYOND: LeadStage[] = ['qualified', 'booked', 'won'];

export type ReportsModel = {
  range: ReportRange;
  totalLeads: number;
  leadsTrend: { label: string; leads: number; qualified: number }[];
  leadsByChannel: { channel: LeadChannel; leads: number }[];
  funnel: ReturnType<typeof deriveLeadSummary>['funnel'];
  topChannels: { channel: LeadChannel; leads: number; qualified: number; conv_pct: number }[];
  appointmentStats: {
    scheduled: number; completed: number; cancelled: number; no_show: number;
    show_rate_pct: number | null;
  };
};

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

export function deriveReportsModel(
  leads: Lead[],
  _campaigns: Campaign[],
  appointments: Appointment[],
  range: ReportRange,
  now: Date,
): ReportsModel {
  const cutoff = now.getTime() - RANGE_DAYS[range] * 86_400_000;
  const inRange = (iso: string) => new Date(iso).getTime() >= cutoff;
  const ls = leads.filter((l) => inRange(l.created_at));
  const appts = appointments.filter((a) => inRange(a.created_at));
  const qualified = (l: Lead) => QUALIFIED_OR_BEYOND.includes(l.stage);

  const weeks = Math.max(1, Math.ceil(RANGE_DAYS[range] / 7));
  const leadsTrend = Array.from({ length: weeks }, (_, i) => {
    const from = cutoff + i * 7 * 86_400_000;
    const to = from + 7 * 86_400_000;
    const isLast = i === weeks - 1;
    const wk = ls.filter((l) => {
      const t = new Date(l.created_at).getTime();
      return t >= from && (isLast || t < to);
    });
    return { label: `Wk ${i + 1}`, leads: wk.length, qualified: wk.filter(qualified).length };
  });

  const leadsByChannel = LEAD_CHANNELS.map((channel) => ({
    channel,
    leads: ls.filter((l) => l.channel === channel).length,
  })).filter((r) => r.leads > 0);

  const topChannels = LEAD_CHANNELS.map((channel) => {
    const chLeads = ls.filter((l) => l.channel === channel);
    const q = chLeads.filter(qualified).length;
    return { channel, leads: chLeads.length, qualified: q, conv_pct: pct(q, chLeads.length) };
  })
    .filter((r) => r.leads > 0)
    .sort((a, b) => b.leads - a.leads);

  const by = (s: Appointment['status']) => appts.filter((a) => a.status === s).length;
  const completed = by('completed');
  const no_show = by('no_show');

  return {
    range,
    totalLeads: ls.length,
    leadsTrend,
    leadsByChannel,
    funnel: deriveLeadSummary(ls, now).funnel,
    topChannels,
    appointmentStats: {
      scheduled: by('scheduled'),
      completed,
      cancelled: by('cancelled'),
      no_show,
      show_rate_pct: completed + no_show > 0 ? pct(completed, completed + no_show) : null,
    },
  };
}
