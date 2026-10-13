import { describe, expect, it } from 'vitest';
import {
  createReachTools,
  deriveAdsOverview,
  deriveContacts,
  deriveLeadSummary,
  deriveSpendByChannel,
  filterUpcomingAppointments,
  rm,
  summarizeAutomations,
  summarizeBroadcasts,
  summarizeCampaigns,
  summarizeForms,
} from '@/lib/ai/tools';
import {
  createSeedReachData,
  seedAppointments,
  seedAutomations,
  seedBroadcasts,
  seedCampaigns,
  seedForms,
  seedLeads,
} from '@/lib/reach/seed';
import type { Appointment } from '@/lib/reach/types';

const NOW = new Date('2026-10-09T00:00:00.000Z');

describe('rm() money formatting', () => {
  it('formats cents as RM with two decimals', () => {
    expect(rm(688)).toBe('RM 6.88');
    expect(rm(123456)).toBe('RM 1,234.56');
    expect(rm(0)).toBe('RM 0.00');
  });
});

describe('deriveLeadSummary', () => {
  const summary = deriveLeadSummary(seedLeads(NOW), NOW);

  it('derives the funnel from lead stages', () => {
    expect(summary.funnel).toEqual({
      lead: 342,
      contacted: 264,
      qualified: 158,
      booked: 96,
      won: 48,
    });
  });

  it('derives channel mix and total', () => {
    expect(summary.total_leads).toBe(342);
    expect(summary.by_channel).toEqual({ whatsapp: 142, facebook: 96, instagram: 68, tiktok: 36, web: 0 });
  });

  it('computes conversion rate (won ÷ total)', () => {
    expect(summary.conversion_pct).toBe(14);
  });

  it('builds an 8-week rising trend, oldest first, summing to the total', () => {
    expect(summary.weekly_trend).toHaveLength(8);
    expect(summary.weekly_trend[0].weeks_ago).toBe(7);
    expect(summary.weekly_trend.at(-1)?.weeks_ago).toBe(0);
    const total = summary.weekly_trend.reduce((a, w) => a + w.leads, 0);
    expect(total).toBe(342);
    expect(summary.weekly_trend[0].leads).toBeLessThan(summary.weekly_trend[7].leads);
  });

  it('scopes to a recent window when sinceDays is given', () => {
    const recent = deriveLeadSummary(seedLeads(NOW), NOW, 14);
    expect(recent.since_days).toBe(14);
    expect(recent.total_leads).toBeLessThan(342);
    expect(recent.total_leads).toBeGreaterThan(0);
  });
});

describe('deriveSpendByChannel', () => {
  const spend = deriveSpendByChannel(seedCampaigns(NOW));

  it('totals spend across campaigns', () => {
    // 210000 (fb) + 184800 (tiktok) + 63990 (ig) + 41968 (wa)
    expect(spend.total_spend_cents).toBe(500758);
  });

  it('sorts channels by spend, highest first', () => {
    expect(spend.by_channel[0].channel).toBe('facebook');
    expect(spend.by_channel.map((c) => c.spend_cents)).toEqual(
      [...spend.by_channel.map((c) => c.spend_cents)].sort((a, b) => b - a),
    );
  });
});

describe('summarizeCampaigns', () => {
  it('sorts cheapest cost-per-lead first', () => {
    const rows = summarizeCampaigns(seedCampaigns(NOW));
    expect(rows[0].name).toBe('Lead Magnet — eBook');
    expect(rows[0].cpl).toBe('RM 6.88');
    expect(rows.at(-1)?.name).toBe('Brand Awareness');
  });

  it('filters by status', () => {
    const active = summarizeCampaigns(seedCampaigns(NOW), 'active');
    expect(active).toHaveLength(3);
    expect(active.every((c) => c.status === 'active')).toBe(true);
  });
});

describe('filterUpcomingAppointments', () => {
  it('returns future appointments soonest-first and respects the limit', () => {
    const upcoming = filterUpcomingAppointments(seedAppointments(NOW), NOW, 2);
    expect(upcoming).toHaveLength(2);
    expect(upcoming[0].contact_name).toBe('Aisyah Rahim');
    const times = upcoming.map((a) => new Date(a.scheduled_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('carries each appointment id and status so the model can target one', () => {
    const [first] = filterUpcomingAppointments(seedAppointments(NOW), NOW, 1);
    expect(typeof first.id).toBe('string');
    expect(first.id.length).toBeGreaterThan(0);
    expect(first.status).toBe('scheduled');
  });

  it('excludes appointments already in the past', () => {
    const past: Appointment = {
      id: 'past',
      contact_name: 'Ghani Omar',
      kind: 'Old call',
      via: 'Call',
      status: 'scheduled',
      scheduled_at: new Date(NOW.getTime() - 3600_000).toISOString(),
      created_at: new Date(NOW.getTime() - 7200_000).toISOString(),
    };
    const upcoming = filterUpcomingAppointments([past, ...seedAppointments(NOW)], NOW);
    expect(upcoming.some((a) => a.contact_name === 'Ghani Omar')).toBe(false);
    expect(upcoming).toHaveLength(2);
  });
});

describe('filterUpcomingAppointments status', () => {
  it('omits future appointments that are not scheduled', () => {
    const cancelled: Appointment = {
      id: 'c1',
      contact_name: 'Cancelled Person',
      kind: 'Call',
      via: 'Call',
      status: 'cancelled',
      scheduled_at: new Date(NOW.getTime() + 3600_000).toISOString(),
      created_at: NOW.toISOString(),
    };
    const upcoming = filterUpcomingAppointments([cancelled], NOW);
    expect(upcoming).toHaveLength(0);
  });
});

describe('deriveAdsOverview', () => {
  const o = deriveAdsOverview(seedCampaigns(NOW));

  it('totals spend, leads and blended CPL', () => {
    expect(o.total_spend_cents).toBe(500758);
    expect(o.total_spend).toBe('RM 5,007.58');
    expect(o.total_leads).toBe(299);
    expect(o.blended_cpl_cents).toBe(Math.round(500758 / 299));
  });

  it('counts active vs paused campaigns', () => {
    expect(o.active_campaigns).toBe(3);
    expect(o.paused_campaigns).toBe(2);
  });

  it('handles no campaigns', () => {
    expect(deriveAdsOverview([]).blended_cpl_cents).toBe(0);
  });
});

describe('deriveContacts', () => {
  const leads = seedLeads(NOW);

  it('sorts newest first and respects the limit', () => {
    const rows = deriveContacts(leads, { limit: 5 });
    expect(rows).toHaveLength(5);
    const times = rows.map((r) => new Date(r.created_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('filters by stage and channel', () => {
    const won = deriveContacts(leads, { stage: 'won', limit: 50 });
    expect(won).toHaveLength(48);
    expect(won.every((r) => r.stage === 'won')).toBe(true);
    const tt = deriveContacts(leads, { channel: 'tiktok', limit: 50 });
    expect(tt).toHaveLength(36);
    expect(tt.every((r) => r.channel === 'tiktok')).toBe(true);
  });
});

describe('forms / broadcasts / automations summaries', () => {
  it('lists forms most-submitted first', () => {
    const rows = summarizeForms(seedForms());
    expect(rows).toHaveLength(6);
    expect(rows[0].submissions).toBe(128);
    // The id and the link ride along so Jebat can chain a read into a write.
    expect(rows[0]).toMatchObject({ id: 'form_1', slug: 'raya-promo', category: 'Promotions', views: 612, status: 'active' });
    expect(summarizeForms(seedForms(), 2)).toHaveLength(2);
  });

  it('lists broadcasts newest first with open rate', () => {
    const rows = summarizeBroadcasts(seedBroadcasts(NOW));
    expect(rows).toHaveLength(5);
    expect(rows[0].name).toBe('Peringatan Troli Tertinggal');
    expect(rows[0].open_rate_pct).toBe(87.3);
  });

  it('lists automations most-run first', () => {
    const rows = summarizeAutomations(seedAutomations(NOW));
    expect(rows).toHaveLength(4);
    expect(rows[0].runs).toBe(342);
  });
});

describe('createReachTools', () => {
  it('exposes the full read-only tool set', () => {
    const tools = createReachTools(createSeedReachData(NOW), NOW);
    expect(Object.keys(tools).sort()).toEqual([
      'getAdSettings',
      'getAdsOverview',
      'getCampaigns',
      'getCreatives',
      'getLeadSummary',
      'getSpendByChannel',
      'getUpcomingAppointments',
      'listAutomations',
      'listBroadcasts',
      'listContacts',
      'listForms',
    ]);
  });
});
