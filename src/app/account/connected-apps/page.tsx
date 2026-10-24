import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type App = {
  name: string;
  category: string;
  description: string;
  connected: boolean;
  /** Not built yet: shown, but it cannot be connected. */
  comingSoon?: boolean;
};

const APPS: App[] = [
  {
    name: 'WhatsApp Business',
    category: 'Messaging',
    description: 'Chat with customers and send broadcasts on WhatsApp.',
    connected: true,
  },
  {
    name: 'Meta Ads',
    category: 'Advertising',
    description: 'Sync ad leads and campaign spend into your CRM.',
    connected: true,
  },
  {
    name: 'Stripe',
    category: 'Payments',
    description: 'Accept card payments and reconcile payouts.',
    connected: true,
  },
  {
    name: 'Google Calendar',
    category: 'Scheduling',
    description: 'Two-way sync for appointments and meetings.',
    connected: false,
  },
  {
    name: 'LHDN MyInvois',
    category: 'Compliance',
    description: 'Send e-Invoices to LHDN MyInvois from Bendahara.',
    connected: false,
    comingSoon: true,
  },
  {
    name: 'Telegram',
    category: 'Messaging',
    description: 'Reach customers and receive alerts via Telegram bots.',
    connected: false,
  },
];

export default function ConnectedAppsPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Connected apps</h1>
        <p className="text-sm text-muted-foreground">
          Integrations linked to your workspace.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {APPS.map((a) => (
          <div
            key={a.name}
            className="space-y-3 rounded-xl border bg-card p-5 shadow-sm"
          >
            <div className="flex items-start justify-between">
              <div className="grid size-10 place-items-center rounded-xl bg-muted text-sm font-bold">
                {a.name.charAt(0)}
              </div>
              <span
                className={cn(
                  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                  a.connected
                    ? 'bg-emerald-500/15 text-emerald-600'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {a.connected ? 'Connected' : a.comingSoon ? 'Coming soon' : 'Not connected'}
              </span>
            </div>
            <div>
              <p className="font-semibold">{a.name}</p>
              <p className="text-xs text-muted-foreground">{a.category}</p>
            </div>
            <p className="text-sm text-muted-foreground">{a.description}</p>
            <Button variant="outline" size="sm" className="w-full" disabled={a.comingSoon}>
              {a.connected ? 'Manage' : a.comingSoon ? 'Coming soon' : 'Connect'}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
