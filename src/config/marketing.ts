import {
  Compass,
  Megaphone,
  SquareKanban,
  Users,
  UserPlus,
  Landmark,
  type LucideIcon,
} from 'lucide-react';

/** Top-bar links (Products opens the mega-menu, handled separately). */
export const NAV_LINKS: { label: string; href: string }[] = [
  { label: 'Home', href: '/' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Marketplace Apps', href: '#marketplace' },
  { label: 'Tutorials & Docs', href: '/account/docs' },
  { label: 'Contact Support', href: '/account/support' },
];

export type MegaItem = { label: string; desc: string };
export type MegaColumn = {
  name: string;
  tagline: string;
  href: string;
  icon: LucideIcon;
  items: MegaItem[];
};

/** The Products mega-menu — our six modules grouped into four families. */
export const MEGA_MENU: MegaColumn[] = [
  {
    name: 'Tuah',
    tagline: 'Your AI command center',
    href: '/command',
    icon: Compass,
    items: [
      { label: 'Daily Briefing', desc: 'Your business, briefed every morning' },
      { label: 'CMO · Marketing', desc: 'Campaign decisions, by voice' },
      { label: 'CHRO · People', desc: 'Hiring and performance' },
      { label: 'CFO · Finance', desc: 'Cash, margin and runway' },
      { label: 'Ask Sari', desc: 'Talk to your whole business, live' },
    ],
  },
  {
    name: 'Jebat & Kasturi',
    tagline: 'Get, manage & close leads',
    href: '/reach/assistant',
    icon: Megaphone,
    items: [
      { label: 'Ad Studio', desc: 'AI ads that launch and optimise' },
      { label: 'Creative Bank', desc: 'Copy, image and video creatives' },
      { label: 'CRM & Deals', desc: 'Pipeline and deal operations' },
      { label: 'Lead Forms', desc: 'Capture, score and route leads' },
      { label: 'AI Chatbot', desc: 'WhatsApp replies that qualify' },
      { label: 'Automations', desc: 'Follow-ups that run themselves' },
    ],
  },
  {
    name: 'Lekiu & Lekir',
    tagline: 'Hire, manage & pay your team',
    href: '/people/assistant',
    icon: Users,
    items: [
      { label: 'Employees', desc: 'Records, documents and self-service' },
      { label: 'Attendance & Leave', desc: 'Clock-in, shifts and leave' },
      { label: 'Payroll', desc: 'Payroll with statutory built in' },
      { label: 'Claims', desc: 'Claims and reimbursements' },
      { label: 'Recruit', desc: 'Candidates, jobs and interviews' },
      { label: 'Assessments', desc: 'Skill tests and scoring' },
    ],
  },
  {
    name: 'Bendahara',
    tagline: 'Accounting with e-invoicing',
    href: '/finance/assistant',
    icon: Landmark,
    items: [
      { label: 'Invoicing', desc: 'Quote, invoice and get paid' },
      { label: 'e-Invoice LHDN', desc: 'MyInvois submission, built in' },
      { label: 'Expenses & Bills', desc: 'Supplier bills and payments' },
      { label: 'Banking', desc: 'Statements, receipts, vouchers' },
      { label: 'Receipts Inbox', desc: 'Snap a receipt, AI books it' },
      { label: 'Reports & SST', desc: 'P&L, balance sheet, SST' },
    ],
  },
];

export type ProductCard = {
  key: string;
  name: string;
  category: string;
  tagline: string;
  blurb: string;
  href: string;
  icon: LucideIcon;
  features: string[];
};

/** The six product cards for the landing showcase. */
export const PRODUCT_CARDS: ProductCard[] = [
  {
    key: 'command',
    name: 'Tuah',
    category: 'AI command center',
    tagline: 'Command your business',
    blurb: 'An AI leadership team that briefs you daily and answers in plain language.',
    href: '/command',
    icon: Compass,
    features: ['Daily briefing', 'CMO / CHRO / CFO agents', 'Ask Sari, live'],
  },
  {
    key: 'reach',
    name: 'Jebat',
    category: 'Ads',
    tagline: 'Win new leads with AI ads',
    blurb: 'Launch, optimise and report on ad campaigns without an agency.',
    href: '/reach/assistant',
    icon: Megaphone,
    features: ['Ad Studio', 'Creative Bank', 'Lead forms & scoring'],
  },
  {
    key: 'crm',
    name: 'Kasturi',
    category: 'CRM',
    tagline: 'Manage & close your pipeline',
    blurb: 'Deals, broadcasts and automations that move leads to paid.',
    href: '/crm/assistant',
    icon: SquareKanban,
    features: ['Pipeline & deals', 'WhatsApp chatbot', 'Automations'],
  },
  {
    key: 'people',
    name: 'Lekiu',
    category: 'Team',
    tagline: 'Build & manage your team',
    blurb: 'Attendance, leave, payroll and performance in one HR system.',
    href: '/people/assistant',
    icon: Users,
    features: ['Attendance & leave', 'Payroll + statutory', 'Performance'],
  },
  {
    key: 'hire',
    name: 'Lekir',
    category: 'Recruit',
    tagline: 'Recruit & hire your next team',
    blurb: 'Jobs, candidates and interviews with AI assessment built in.',
    href: '/hire/assistant',
    icon: UserPlus,
    features: ['Jobs & candidates', 'Interview scheduling', 'Assessments'],
  },
  {
    key: 'finance',
    name: 'Bendahara',
    category: 'Accounting',
    tagline: 'Accounting & e-Invois LHDN',
    blurb: 'Invoicing, expenses and compliant e-Invoicing straight to LHDN.',
    href: '/finance/assistant',
    icon: Landmark,
    features: ['Invoicing & quotes', 'e-Invoice MyInvois', 'Reports & SST'],
  },
];

/** Source repository. */
export const REPO_URL = 'https://github.com/OpenKuasa/OpenKuasaOS';
