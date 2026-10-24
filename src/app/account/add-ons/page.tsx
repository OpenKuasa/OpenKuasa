import {
  BadgeCheck,
  Coins,
  Globe,
  Headset,
  MessageSquare,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireAccess } from '@/lib/auth/viewer';

type AddOn = {
  name: string;
  icon: LucideIcon;
  description: string;
  price: string;
  owned: boolean;
  /** Not built yet: shown, but it cannot be added. */
  comingSoon?: boolean;
};

const ADD_ONS: AddOn[] = [
  {
    name: 'Extra Credits',
    icon: Coins,
    description: 'Top up your monthly AI credits for heavier workloads.',
    price: 'RM 29 / mo',
    owned: true,
  },
  {
    name: 'Extra Seats',
    icon: Users,
    description: 'Add more team members beyond your plan limit.',
    price: 'RM 19 / seat',
    owned: false,
  },
  {
    name: 'WhatsApp API',
    icon: MessageSquare,
    description: 'Send and receive messages through the official API.',
    price: 'RM 49 / mo',
    owned: true,
  },
  {
    name: 'e-Invoice LHDN',
    icon: BadgeCheck,
    description: 'Send e-Invoices to LHDN MyInvois from Bendahara.',
    price: 'Coming soon',
    owned: false,
    comingSoon: true,
  },
  {
    name: 'Priority Support',
    icon: Headset,
    description: 'Jump the queue with a dedicated support channel.',
    price: 'RM 99 / mo',
    owned: false,
  },
  {
    name: 'Custom Domain',
    icon: Globe,
    description: 'Serve your pages and portals from your own domain.',
    price: 'RM 15 / mo',
    owned: false,
  },
];

export default async function AddOnsPage() {
  await requireAccess('manage-billing');

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Add-ons</h1>
        <p className="text-sm text-muted-foreground">Extend your workspace.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ADD_ONS.map((a) => {
          const Icon = a.icon;
          return (
            <div
              key={a.name}
              className="space-y-3 rounded-xl border bg-card p-5 shadow-sm"
            >
              <div className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
                <Icon className="size-5" />
              </div>
              <p className="font-semibold">{a.name}</p>
              <p className="text-sm text-muted-foreground">{a.description}</p>
              <p className="font-semibold">{a.price}</p>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={a.owned || a.comingSoon}
              >
                {a.owned ? 'Added' : a.comingSoon ? 'Coming soon' : 'Add'}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
