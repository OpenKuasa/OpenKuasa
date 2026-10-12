import {
  Bell,
  Briefcase,
  Building2,
  Code2,
  CreditCard,
  FileText,
  KeyRound,
  LayoutGrid,
  Lock,
  Puzzle,
  ScrollText,
  Sparkles,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { canSee, type Capability } from '@/lib/auth/permissions';
import type { OrgRole } from '@/lib/auth/current-org';

export type AccountNavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  needs?: Capability;
};

export type AccountNavSection = {
  label: string;
  needs?: Capability;
  items: AccountNavItem[];
};

/** The account screens. The sidebar and the jump-to search both read this list. */
export const ACCOUNT_SECTIONS: AccountNavSection[] = [
  {
    label: 'Account',
    items: [
      { label: 'My profile', href: '/account/profile', icon: UserRound },
      { label: 'Security', href: '/account/security', icon: Lock },
      { label: 'Notifications', href: '/account/notifications', icon: Bell },
    ],
  },
  {
    label: 'Organisation',
    items: [
      { label: 'Company details', href: '/account/company', icon: Building2 },
      { label: 'Team', href: '/account/team', icon: Users },
      { label: 'Client accounts', href: '/account/clients', icon: Briefcase },
      { label: 'Activity log', href: '/account/activity', icon: ScrollText },
    ],
  },
  {
    label: 'Billing',
    needs: 'manage-billing',
    items: [
      { label: 'My subscriptions', href: '/account/subscriptions', icon: CreditCard },
      { label: 'Change plan', href: '/account/plan', icon: KeyRound },
      { label: 'Add-ons', href: '/account/add-ons', icon: Puzzle },
      { label: 'Payment methods', href: '/account/payment-methods', icon: Wallet },
      { label: 'Transaction records', href: '/account/transactions', icon: FileText },
    ],
  },
  {
    label: 'Apps',
    items: [
      { label: 'Connected apps', href: '/account/connected-apps', icon: LayoutGrid },
      { label: 'AI key', href: '/account/ai', icon: Sparkles },
      { label: 'Developers', href: '/account/developers', icon: Code2, needs: 'manage-developers' },
    ],
  },
];

/**
 * The account navigation for one viewer: sections and items they may not use
 * are left out, and so is a section with nothing left in it. Demo visitors see
 * everything.
 */
export function visibleAccountSections(viewer: { role: OrgRole; isDemo: boolean }): AccountNavSection[] {
  return ACCOUNT_SECTIONS.filter((section) => canSee(viewer, section.needs))
    .map((section) => ({ ...section, items: section.items.filter((item) => canSee(viewer, item.needs)) }))
    .filter((section) => section.items.length > 0);
}
