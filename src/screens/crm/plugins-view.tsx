import { Clock, Plug } from 'lucide-react';
import { BentoCard, BentoGrid } from '@/components/bento/bento';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import type { CrmConnections } from '@/lib/crm/connections';
import { ConnectionRows } from './connection-rows';

export const PLUGINS_TITLE = 'Plugins';
export const PLUGINS_SUBTITLE = 'What Kasturi is connected to, and where each connection is set up.';

/** Asked for often, not built. Listed so nobody looks for a switch that is not there. */
export const NOT_AVAILABLE: { name: string; note: string }[] = [
  { name: 'WhatsApp', note: 'For the chatbot and for broadcasts.' },
  { name: 'Instagram and Messenger', note: 'For the chatbot.' },
  { name: 'Online payments', note: 'Such as Stripe or Billplz, to collect on invoices.' },
  { name: 'Google Calendar', note: 'To sync appointments both ways.' },
  { name: 'Zapier', note: 'To connect other apps.' },
  {
    name: 'LHDN MyInvois',
    note: 'Bendahara keeps the e-invoice details on each invoice, but nothing is sent to LHDN yet.',
  },
];

/** Kasturi's connections: the ones that work, with their state, and the ones that do not exist yet. */
export function PluginsView({ connections }: { connections: CrmConnections }) {
  return (
    <ScreenContainer>
      <PageHeader title={PLUGINS_TITLE} subtitle={PLUGINS_SUBTITLE} />
      <BentoGrid>
        <BentoCard
          title="Connected services"
          subtitle="Each one is set up on the screen it links to"
          icon={Plug}
          className="col-span-2 md:col-span-6"
        >
          <ConnectionRows connections={connections} />
        </BentoCard>
        <BentoCard
          title="Not available yet"
          subtitle="Nothing to switch on for these today"
          icon={Clock}
          className="col-span-2 md:col-span-6"
        >
          <ul className="space-y-1">
            {NOT_AVAILABLE.map((item) => (
              <li key={item.name} className="rounded-lg border bg-background/50 px-3 py-2">
                <p className="text-sm font-medium">{item.name}</p>
                <p className="text-xs text-muted-foreground">{item.note}</p>
              </li>
            ))}
          </ul>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
