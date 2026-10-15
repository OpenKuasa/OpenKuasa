import {
  Compass,
  Megaphone,
  SquareKanban,
  Users,
  UserPlus,
  Landmark,
  Bot,
  Wand2,
  Images,
  ClipboardCheck,
  ClipboardList,
  CalendarDays,
  SlidersHorizontal,
  TrendingUp,
  MessageSquare,
  Zap,
  MonitorSmartphone,
  Calendar,
  CreditCard,
  BarChart3,
  Plug,
  Settings,
  LayoutDashboard,
  Clock,
  Target,
  FileText,
  Archive,
  CircleCheck,
  Heart,
  CalendarClock,
  Banknote,
  Receipt,
  Star,
  GraduationCap,
  Briefcase,
  Inbox,
  Building2,
  ArrowLeftRight,
  BookOpen,
  ListTree,
  Package,
  BadgeCheck,
  ScrollText,
  CircleDollarSign,
  RotateCcw,
  ArrowUpRight,
  type LucideIcon,
} from 'lucide-react';
import type { OrgRole } from '@/lib/auth/current-org';
import { type NavNeed, canSee } from '@/lib/auth/permissions';

/** A live count pill on a nav item, resolved client-side from the nav-badges context. */
export type NavBadgeKey =
  | 'pendingProposals'
  | 'unreadAnnouncements'
  | 'awaitingAcknowledgement'
  | 'waitingLeave'
  | 'waitingTimeOff'
  | 'waitingClaims'
  | 'waitingOvertime';

export type NavItem = {
  label: string;
  slug: string;
  icon: LucideIcon;
  /** Shown only to someone with this capability (or, for `approve-team`, who manages a team). Left out: shown to everyone. */
  needs?: NavNeed;
  /** Shows a live count pill from the nav-badges context (e.g. pending agent proposals). */
  badge?: NavBadgeKey;
  /** The word after the count in the pill's accessible label ("3 waiting"). Default `waiting`. */
  badgeLabel?: string;
};
/** The pill's accessible label: the count and a word (`waiting` unless the item says otherwise). */
export const badgeAriaLabel = (count: number, word: string = 'waiting'): string => `${count} ${word}`;

export type NavSection = { label: string; items: NavItem[] };

export type Product = {
  /** route segment / stable key */
  key: string;
  /** Hang codename shown in the UI */
  name: string;
  tagline: string;
  icon: LucideIcon;
  /** empty sections => full-width module with no secondary panel */
  sections: NavSection[];
};

export const PRODUCTS: Product[] = [
  {
    key: 'command',
    name: 'Tuah',
    tagline: 'Command your business',
    icon: Compass,
    sections: [],
  },
  {
    key: 'reach',
    name: 'Jebat',
    tagline: 'Win new leads with AI ads',
    icon: Megaphone,
    sections: [
      {
        label: 'Overview',
        items: [
          { label: 'Overview', slug: 'assistant', icon: LayoutDashboard },
          { label: 'AI Agents', slug: 'agents', icon: Bot, badge: 'pendingProposals' },
        ],
      },
      {
        label: 'Ads',
        items: [
          { label: 'Ad Studio', slug: 'ad-studio', icon: Wand2 },
          { label: 'Creative Bank', slug: 'creative-bank', icon: Images },
        ],
      },
      {
        label: 'Leads',
        items: [
          { label: 'Lead Funnel', slug: 'leads', icon: Users },
          { label: 'Lead Forms', slug: 'lead-forms', icon: ClipboardList },
        ],
      },
      {
        label: 'Schedule',
        items: [
          { label: 'Appointments', slug: 'appointments', icon: CalendarDays },
        ],
      },
      {
        label: 'Setup',
        items: [
          { label: 'Ad Settings', slug: 'ad-settings', icon: SlidersHorizontal },
        ],
      },
    ],
  },
  {
    key: 'crm',
    name: 'Kasturi',
    tagline: 'Manage & close your pipeline',
    icon: SquareKanban,
    sections: [
      {
        label: 'Overview',
        items: [
          { label: 'Overview', slug: 'assistant', icon: LayoutDashboard },
          { label: 'AI Agents', slug: 'agents', icon: Bot },
        ],
      },
      {
        label: 'Leads',
        items: [
          { label: 'Contacts', slug: 'contacts', icon: Users },
          { label: 'Deals', slug: 'deals', icon: TrendingUp },
          { label: 'Lead Forms', slug: 'lead-forms', icon: ClipboardList },
        ],
      },
      {
        label: 'Engage',
        items: [
          { label: 'Broadcast', slug: 'broadcast', icon: Megaphone },
          { label: 'AI Chatbot', slug: 'chatbot', icon: MessageSquare },
          { label: 'Automations', slug: 'automations', icon: Zap },
          { label: 'Landing Page', slug: 'landing-page', icon: MonitorSmartphone },
        ],
      },
      {
        label: 'Schedule',
        items: [
          { label: 'Appointments', slug: 'appointments', icon: CalendarDays },
          { label: 'Calendar', slug: 'calendar', icon: Calendar },
        ],
      },
      {
        label: 'Finance',
        items: [{ label: 'Billings', slug: 'billings', icon: CreditCard }],
      },
      {
        label: 'Analytics',
        items: [{ label: 'Reports', slug: 'reports', icon: BarChart3 }],
      },
      {
        label: 'Configuration',
        items: [
          { label: 'Plugins', slug: 'plugins', icon: Plug },
          { label: 'Settings', slug: 'settings', icon: Settings },
        ],
      },
    ],
  },
  {
    key: 'people',
    name: 'Lekiu',
    tagline: 'Build & manage your team',
    icon: Users,
    sections: [
      {
        label: 'General',
        items: [
          { label: 'Overview', slug: 'assistant', icon: LayoutDashboard },
          { label: 'Dashboard', slug: 'dashboard', icon: TrendingUp },
          { label: 'Calendar', slug: 'calendar', icon: Calendar },
          { label: 'Announcements', slug: 'announcements', icon: Megaphone, badge: 'unreadAnnouncements', badgeLabel: 'unread' },
          { label: 'My Attendance', slug: 'my-attendance', icon: Clock },
          { label: 'My Goals', slug: 'my-goals', icon: Target },
          { label: 'My Documents', slug: 'my-documents', icon: FileText, badge: 'awaitingAcknowledgement', badgeLabel: 'awaiting your acknowledgement' },
          { label: 'My Payslips', slug: 'my-payslips', icon: Receipt },
          { label: 'Records', slug: 'records', icon: Archive },
        ],
      },
      {
        label: 'Applications',
        items: [
          { label: 'Leave', slug: 'leave', icon: CircleCheck },
          { label: 'Time-Off', slug: 'time-off', icon: CircleCheck },
          { label: 'Financial Claims', slug: 'claims', icon: CircleCheck },
          { label: 'OT Claims', slug: 'ot-claims', icon: CircleCheck },
        ],
      },
      {
        label: 'Management',
        items: [
          { label: 'Employees', slug: 'employees', icon: Users },
          { label: 'Attendance', slug: 'attendance', icon: ClipboardList, needs: 'approve-team' },
        ],
      },
      {
        label: 'Approvals',
        items: [
          { label: 'Leave', slug: 'approve-leave', icon: CircleCheck, needs: 'approve-team', badge: 'waitingLeave' },
          { label: 'Financial Claims', slug: 'approve-claims', icon: CircleCheck, needs: 'approve-team', badge: 'waitingClaims' },
          { label: 'Overtime', slug: 'approve-overtime', icon: CircleCheck, needs: 'approve-team', badge: 'waitingOvertime' },
          { label: 'Time-Off', slug: 'approve-time-off', icon: CircleCheck, needs: 'approve-team', badge: 'waitingTimeOff' },
          { label: 'Public Holidays', slug: 'public-holidays', icon: Heart },
          { label: 'Letters', slug: 'letters', icon: FileText },
        ],
      },
      {
        label: 'Attendance',
        items: [
          { label: 'Timesheet', slug: 'timesheet', icon: Clock },
          { label: 'Shift Calendar', slug: 'shift-calendar', icon: CalendarClock },
          { label: 'Overtime', slug: 'overtime', icon: Clock },
        ],
      },
      {
        label: 'Payroll',
        items: [
          { label: 'Payroll', slug: 'payroll', icon: Banknote, needs: 'approve' },
          { label: 'Payment Vouchers', slug: 'payment-vouchers', icon: Receipt, needs: 'approve' },
        ],
      },
      {
        label: 'Performance',
        items: [
          { label: 'Scorecard', slug: 'scorecard', icon: Star },
          { label: 'Review Scores', slug: 'review-scores', icon: Star },
          { label: 'Training', slug: 'training', icon: GraduationCap },
        ],
      },
      {
        label: 'Configuration',
        items: [{ label: 'Settings', slug: 'settings', icon: Settings, needs: 'approve' }],
      },
    ],
  },
  {
    key: 'hire',
    name: 'Lekir',
    tagline: 'Recruit & hire your next team',
    icon: UserPlus,
    sections: [
      {
        label: 'Overview',
        items: [
          { label: 'Overview', slug: 'assistant', icon: LayoutDashboard },
          { label: 'Dashboard', slug: 'dashboard', icon: TrendingUp },
        ],
      },
      {
        label: 'Pipeline',
        items: [
          { label: 'Jobs', slug: 'jobs', icon: Briefcase },
          { label: 'Candidates', slug: 'candidates', icon: Users },
          { label: 'Applications', slug: 'applications', icon: ClipboardList },
          { label: 'Interviews', slug: 'interviews', icon: CalendarDays },
        ],
      },
      {
        label: 'Sourcing',
        items: [
          { label: 'Talent Pool', slug: 'talent-pool', icon: UserPlus },
          { label: 'Careers Page', slug: 'careers-page', icon: MonitorSmartphone },
        ],
      },
      {
        label: 'Configuration',
        items: [{ label: 'Settings', slug: 'settings', icon: Settings }],
      },
    ],
  },
  {
    key: 'finance',
    name: 'Bendahara',
    tagline: 'Accounting & e-Invois LHDN',
    icon: Landmark,
    sections: [
      {
        label: 'Overview',
        items: [
          { label: 'Overview', slug: 'assistant', icon: LayoutDashboard },
          { label: 'AI Agents', slug: 'agents', icon: Bot },
          { label: 'Dashboard', slug: 'dashboard', icon: TrendingUp },
        ],
      },
      {
        label: 'Cash Book',
        items: [
          { label: 'Cash Receipts', slug: 'cash-receipts', icon: Receipt },
          { label: 'Payment Vouchers', slug: 'payment-vouchers', icon: Receipt },
        ],
      },
      {
        label: 'Sales',
        items: [
          { label: 'Quotations', slug: 'quotations', icon: ClipboardList },
          { label: 'Invoices', slug: 'invoices', icon: FileText },
          { label: 'Credit Notes', slug: 'credit-notes', icon: RotateCcw },
          { label: 'Payments In', slug: 'payments-in', icon: CircleDollarSign },
          { label: 'Refunds', slug: 'refunds', icon: ArrowLeftRight },
        ],
      },
      {
        label: 'Purchases',
        items: [
          { label: 'Expenses', slug: 'expenses', icon: CreditCard },
          { label: 'Receipts Inbox', slug: 'receipts-inbox', icon: Inbox },
          { label: 'RFQs', slug: 'rfqs', icon: MessageSquare },
          { label: 'Purchase Orders', slug: 'purchase-orders', icon: ClipboardCheck },
          { label: 'Supplier Bills', slug: 'supplier-bills', icon: Building2 },
          { label: 'Payments Out', slug: 'payments-out', icon: ArrowUpRight },
          { label: 'Banking', slug: 'banking', icon: Landmark },
        ],
      },
      {
        label: 'Compliance',
        items: [
          { label: 'e-Invoice LHDN', slug: 'e-invoice', icon: BadgeCheck },
          { label: 'SST Report', slug: 'sst-report', icon: ScrollText },
          { label: 'Audit Trail', slug: 'audit-trail', icon: FileText },
        ],
      },
      {
        label: 'Records',
        items: [
          {
            label: 'Customers & Suppliers',
            slug: 'customers-suppliers',
            icon: Users,
          },
          { label: 'Products', slug: 'products', icon: Package },
        ],
      },
      {
        label: 'Analytics',
        items: [
          { label: 'Reports', slug: 'reports', icon: BarChart3 },
          { label: 'Journals', slug: 'journals', icon: BookOpen },
          { label: 'Chart of Accounts', slug: 'chart-of-accounts', icon: ListTree },
          { label: 'Contra Entries', slug: 'contra-entries', icon: ArrowLeftRight },
          // FX Revaluation returns when Bendahara has currencies to revalue (#224).
        ],
      },
      {
        label: 'Configuration',
        items: [
          { label: 'Accounting Settings', slug: 'settings', icon: Settings },
        ],
      },
    ],
  },
];

/** The cross-app AI assistant. */
export const ASSISTANT = {
  name: 'Taming Sari',
  short: 'Sari',
  tagline: 'Ask anything',
} as const;

export function getProduct(key: string | undefined): Product | undefined {
  return PRODUCTS.find((p) => p.key === key);
}

/** First navigable item of a product (its default landing item). */
export function firstItem(product: Product): NavItem | undefined {
  return product.sections[0]?.items[0];
}

/**
 * Canonical href for a product's dashboard. Modules with a secondary panel
 * resolve straight to their first item (e.g. `/reach/assistant`); a module with
 * no sections (Tuah) is its own full-width route (`/command`). Linking here
 * avoids the product-root redirect, so no-JS clients (crawlers, link unfurlers)
 * land on the dashboard instead of a soft-404.
 */
export function productHref(product: Product): string {
  const first = firstItem(product);
  return first ? `/${product.key}/${first.slug}` : `/${product.key}`;
}

export function findItem(
  product: Product,
  slug: string | undefined,
): NavItem | undefined {
  for (const section of product.sections) {
    const hit = section.items.find((i) => i.slug === slug);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * A product's navigation for one viewer: items they may not use are left out,
 * and so is a section with nothing left in it. Demo visitors see everything.
 */
export function visibleSections(
  product: Product,
  viewer: { role: OrgRole; isDemo: boolean; managesTeam?: boolean },
): NavSection[] {
  return product.sections
    .map((section) => ({ ...section, items: section.items.filter((item) => canSee(viewer, item.needs)) }))
    .filter((section) => section.items.length > 0);
}
