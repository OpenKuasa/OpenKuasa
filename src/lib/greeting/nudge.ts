import type { OrgRole } from '@/lib/auth/current-org';
import { can } from '@/lib/auth/permissions';
import type { Nudge, NudgeCounts, ProductKey } from './types';

type Signal = keyof NudgeCounts;

const plural = (n: number, one: string, many: string = `${one}s`) => (n === 1 ? one : many);
const isAre = (n: number) => (n === 1 ? 'is' : 'are');

const BUILDERS: Record<Signal, (n: number) => Nudge> = {
  hrApprovals: (n) => ({
    text: `${n} ${plural(n, 'approval')} ${isAre(n)} waiting for you.`,
    question: 'Show me the approvals waiting for me',
  }),
  swapReplies: (n) => ({
    text: `${n} shift swap ${plural(n, 'reply', 'replies')} ${isAre(n)} waiting for you.`,
    question: 'Show me the shift swap replies waiting for me',
  }),
  financeApprovals: (n) => ({
    text: `${n} finance ${plural(n, 'approval')} ${isAre(n)} waiting for you.`,
    question: 'Show me the finance approvals waiting for me',
  }),
  overdueInvoices: (n) => ({
    text: `${n} ${plural(n, 'invoice')} ${isAre(n)} overdue.`,
    question: 'Show me the overdue invoices',
  }),
  overdueBills: (n) => ({
    text: `${n} ${plural(n, 'bill')} ${isAre(n)} overdue.`,
    question: 'Show me the overdue bills',
  }),
  interviewsToday: (n) => ({
    text: `${n} ${plural(n, 'interview')} today.`,
    question: 'What interviews do I have today?',
  }),
  applicationsWaiting: (n) => ({
    text: `${n} ${plural(n, 'application')} ${isAre(n)} waiting for review.`,
    question: 'Show me the applications waiting for review',
  }),
  followUpsDue: (n) => ({
    text: `${n} ${plural(n, 'follow-up')} due.`,
    question: 'Which follow-ups are due?',
  }),
  appointmentsToday: (n) => ({
    text: `${n} ${plural(n, 'appointment')} today.`,
    question: 'What appointments do I have today?',
  }),
  newLeads: (n) => ({
    text: `${n} new ${plural(n, 'lead')} since this week.`,
    question: 'Show me the new leads',
  }),
};

const PRODUCT_ORDER: Record<ProductKey, Signal[]> = {
  people: ['hrApprovals', 'swapReplies'],
  finance: ['financeApprovals', 'overdueInvoices', 'overdueBills'],
  hire: ['interviewsToday', 'applicationsWaiting'],
  crm: ['followUpsDue', 'appointmentsToday'],
  reach: ['newLeads', 'appointmentsToday'],
};

const GLOBAL_ORDER: Signal[] = [
  'hrApprovals',
  'financeApprovals',
  'swapReplies',
  'interviewsToday',
  'appointmentsToday',
  'followUpsDue',
  'overdueInvoices',
  'overdueBills',
  'newLeads',
];

function firstQualifying(order: Signal[], counts: NudgeCounts, role: OrgRole): Nudge | null {
  for (const signal of order) {
    if (signal === 'financeApprovals' && !can(role, 'sign-off-finance')) continue;
    const n = counts[signal];
    if (typeof n === 'number' && n > 0) return BUILDERS[signal](n);
  }
  return null;
}

export function pickProductNudge(
  product: ProductKey,
  counts: NudgeCounts,
  role: OrgRole,
): Nudge | null {
  return firstQualifying(PRODUCT_ORDER[product], counts, role);
}

export function pickTopNudge(counts: NudgeCounts, role: OrgRole): Nudge | null {
  return firstQualifying(GLOBAL_ORDER, counts, role);
}
