import {
  deriveAdsOverview,
  deriveLeadSummary,
  deriveSpendByChannel,
  filterUpcomingAppointments,
  summarizeCampaigns,
} from '@/lib/ai/tools';
import type { LeadChannel, LeadStage, ReachData } from './types';

export type OverviewModel = {
  isEmpty: boolean;
  kpis: {
    leads: { value: number; spark: number[] };
    spendRm: string;        // headline only (no weekly series / delta — no source)
    cplRm: string;
    conversionPct: number;
  };
  leadsTrend: { label: string; leads: number; qualified: number }[];
  channelMix: { key: LeadChannel; label: string; value: number }[];
  spendByChannel: { label: string; spend: number }[];
  funnel: { key: LeadStage; label: string; value: number }[];
  topCampaigns: { name: string; leads: number; cpl: string; status: 'Active' | 'Paused' }[];
  appointments: { name: string; kind: string; when: string; via: string }[];
};

const CHANNEL_LABEL: Record<LeadChannel, string> = {
  whatsapp: 'WhatsApp', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', web: 'Website',
};
const STAGE_LABEL: Record<LeadStage, string> = {
  lead: 'Leads', contacted: 'Contacted', qualified: 'Qualified', booked: 'Booked', won: 'Won',
};

/** "Today · 2:30pm" / "Tomorrow · 10:00am" / "Thu · 4:00pm" relative to now. */
export function formatWhen(iso: string, now: Date): string {
  const TZ = 'Asia/Kuala_Lumpur';
  const d = new Date(iso);
  const dayKey = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD in KL
  const dayDiff = Math.round(
    (Date.parse(`${dayKey(d)}T00:00:00Z`) - Date.parse(`${dayKey(now)}T00:00:00Z`)) / 86_400_000,
  );
  const day = dayDiff === 0 ? 'Today' : dayDiff === 1 ? 'Tomorrow'
    : d.toLocaleDateString('en-MY', { weekday: 'short', timeZone: TZ });
  const time = d.toLocaleTimeString('en-MY', { hour: 'numeric', minute: '2-digit', timeZone: TZ })
    .toLowerCase().replace(/\s/g, '');
  return `${day} · ${time}`;
}

export async function buildOverviewModel(data: ReachData, now: Date): Promise<OverviewModel> {
  const [campaigns, leads, appts] = await Promise.all([
    data.listCampaigns(), data.listLeads(), data.listAppointments(),
  ]);
  const summary = deriveLeadSummary(leads, now);
  const ads = deriveAdsOverview(campaigns);
  const spend = deriveSpendByChannel(campaigns);
  const top = summarizeCampaigns(campaigns);

  return {
    isEmpty: campaigns.length === 0 && leads.length === 0 && appts.length === 0,
    kpis: {
      leads: { value: summary.total_leads, spark: summary.weekly_trend.map((w) => w.leads) },
      spendRm: ads.total_spend,
      cplRm: ads.blended_cpl,
      conversionPct: summary.conversion_pct,
    },
    leadsTrend: summary.weekly_trend.map((w) => ({
      label: `Wk${8 - w.weeks_ago}`, leads: w.leads, qualified: w.qualified,
    })),
    channelMix: (Object.entries(summary.by_channel) as [LeadChannel, number][])
      .map(([key, value]) => ({ key, label: CHANNEL_LABEL[key], value })),
    spendByChannel: spend.by_channel.map((c) => ({ label: CHANNEL_LABEL[c.channel], spend: Math.round(c.spend_cents / 100) })),
    funnel: (Object.keys(summary.funnel) as LeadStage[]).map((key) => ({ key, label: STAGE_LABEL[key], value: summary.funnel[key] })),
    topCampaigns: top.map((c) => ({ name: c.name, leads: c.leads, cpl: c.cpl, status: c.status === 'active' ? 'Active' : 'Paused' })),
    appointments: filterUpcomingAppointments(appts, now).map((a) => ({
      name: a.contact_name, kind: a.kind, when: formatWhen(a.scheduled_at, now), via: a.via,
    })),
  };
}
