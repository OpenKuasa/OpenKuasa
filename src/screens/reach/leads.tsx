import { BarChart3, Filter, Users } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import { BarGroup, FunnelFlow, type Series, type Slice } from '@/components/charts';
import { LeadFunnelTable } from '@/components/reach/lead-funnel-table';
import { createClient } from '@/lib/supabase/server';
import { getReachData } from '@/lib/reach/supabase';
import { clearDanglingPromotions } from '@/lib/reach/leads-view';
import { getViewer } from '@/lib/auth/viewer';
import { can } from '@/lib/auth/permissions';
import { deriveLeadSummary } from '@/lib/ai/tools';
import { LEAD_STAGES, type Lead, type LeadChannel, type LeadStage } from '@/lib/reach/types';

const CHANNEL_LABEL: Record<LeadChannel, string> = {
  whatsapp: 'WhatsApp',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  web: 'Website',
};

const STAGE_LABEL: Record<LeadStage, string> = {
  lead: 'Lead',
  contacted: 'Contacted',
  qualified: 'Qualified',
  booked: 'Booked',
  won: 'Won',
};

const STAGE_COLOR: Record<LeadStage, string> = {
  lead: 'var(--chart-5)',
  contacted: 'var(--chart-2)',
  qualified: 'var(--chart-1)',
  booked: 'var(--chart-3)',
  won: 'var(--chart-4)',
};

const LEADS_BY_CHANNEL_SERIES: Series[] = [
  { key: 'leads', label: 'Leads', color: 'var(--chart-1)' },
];

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export default async function LeadsScreen() {
  const supabase = await createClient();
  const [data, viewer] = await Promise.all([getReachData(supabase), getViewer()]);
  const leads: Lead[] = await data.listLeads();
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  const summary = deriveLeadSummary(leads, new Date());

  // A promoted lead stores the contact's id, but the contact can be deleted in
  // Kasturi (no FK). Show such a lead as promotable again — otherwise its
  // "Promoted ✓" sticks forever even though the contact is gone.
  // Leads read from Kasturi are contacts themselves, so they need no check.
  const promotedIds = leads
    .filter((l) => l.origin !== 'crm')
    .map((l) => l.promoted_contact_id)
    .filter((id): id is string => id !== null);
  let existingContactIds: ReadonlySet<string> = new Set();
  if (promotedIds.length > 0) {
    const { data: contacts } = await supabase
      .from('crm_contacts')
      .select('id')
      .in('id', promotedIds);
    existingContactIds = new Set((contacts ?? []).map((c) => (c as { id: string }).id));
  }
  const displayLeads = clearDanglingPromotions(leads, existingContactIds);

  const funnelSlices: Slice[] = LEAD_STAGES.map((stage) => ({
    key: stage,
    label: STAGE_LABEL[stage],
    value: summary.funnel[stage],
    color: STAGE_COLOR[stage],
  }));
  const byChannel = (Object.keys(CHANNEL_LABEL) as LeadChannel[])
    .map((ch) => ({ label: CHANNEL_LABEL[ch], leads: summary.by_channel[ch] }))
    .filter((r) => r.leads > 0);

  return (
    <ScreenContainer>
      <PageHeader
        title="Lead Funnel"
        subtitle="Track leads from first touch to won. Ad leads are promoted to Kasturi contacts; form, landing page and chatbot leads are Kasturi contacts already."
      />

      <BentoGrid>
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat label="Total leads" value={String(summary.total_leads)} onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Qualified" value={String(summary.funnel.qualified)} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Won" value={String(summary.funnel.won)} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Conversion" value={`${summary.conversion_pct}%`} />
        </BentoCard>

        <BentoCard
          title="Lead funnel"
          subtitle="Leads that reached each stage"
          icon={Filter}
          className="col-span-2 md:col-span-6"
        >
          {summary.total_leads === 0 ? (
            <Muted>No leads yet</Muted>
          ) : (
            <FunnelFlow data={funnelSlices} height={200} />
          )}
        </BentoCard>
        <BentoCard
          title="Leads by channel"
          subtitle="All leads"
          icon={BarChart3}
          className="col-span-2 md:col-span-6"
        >
          {byChannel.length === 0 ? (
            <Muted>No leads yet</Muted>
          ) : (
            <BarGroup data={byChannel} series={LEADS_BY_CHANNEL_SERIES} horizontal height={200} />
          )}
        </BentoCard>

        <BentoCard
          title="Leads"
          subtitle="Newest first"
          icon={Users}
          className="col-span-2 md:col-span-12"
        >
          <LeadFunnelTable leads={displayLeads} canEdit={canEdit} />
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
