import { findItem, getProduct } from './nav';

/**
 * Screens that read and write the workspace's own data, keyed by
 * `${productKey}/${itemSlug}`. Every other screen still shows sample data and
 * carries the work-in-progress banner.
 *
 * When a screen is connected to the database, add its key here.
 */
export const LIVE_SCREENS: ReadonlySet<string> = new Set([
  // Jebat
  'reach/assistant',
  'reach/ad-studio',
  'reach/creative-bank',
  'reach/leads',
  'reach/lead-forms',
  'reach/ad-settings',
  'reach/appointments',
  'reach/agents',

  // Kasturi
  'crm/assistant',
  'crm/contacts',
  'crm/deals',
  'crm/lead-forms',
  'crm/appointments',
  'crm/calendar',
  // Reads Bendahara's invoices; they are created and changed on finance/invoices.
  'crm/billings',
  'crm/landing-page',
  // Sends by email through the workspace's own Resend key.
  'crm/broadcast',
  'crm/automations',
  // Set-up and a signed-in preview; on a public landing page the bot answers visitors
  // (/api/p/<page id>/chat). WhatsApp, Instagram and Messenger are not connected.
  'crm/chatbot',
  // Shared with Jebat's analytics (registry 'reach/reports'); /reach/reports
  // is not a nav item, so the screen is served at /crm/reports.
  'crm/reports',
  // The deal rule, the person's own notifications and the contacts export; the rest links to where it is set.
  'crm/settings',

  // Lekir: jobs, applications, candidates, interviews and the talent pool can be changed.
  // Settings saves the application form and links to where the rest is set.
  'hire/assistant',
  'hire/dashboard',
  'hire/jobs',
  'hire/candidates',
  'hire/applications',
  'hire/interviews',
  'hire/talent-pool',
  'hire/careers-page',
  'hire/settings',

  // Lekiu: every screen reads the workspace's HR data.
  'people/assistant',
  'people/dashboard',
  'people/announcements',
  'people/my-attendance',
  'people/my-goals',
  'people/my-documents',
  'people/my-payslips',
  'people/records',
  'people/leave',
  'people/time-off',
  'people/claims',
  'people/ot-claims',
  'people/employees',
  'people/attendance',
  'people/approve-leave',
  'people/approve-claims',
  'people/approve-overtime',
  'people/approve-time-off',
  'people/approve-shift-swaps',
  'people/public-holidays',
  'people/letters',
  'people/timesheet',
  'people/shift-calendar',
  'people/calendar',
  'people/overtime',
  'people/payroll',
  'people/payment-vouchers',
  'people/scorecard',
  'people/review-scores',
  'people/training',
  'people/settings',

  // Bendahara. Dashboard and Overview read the books (2026-10-23); the Overview's cards with no
  // source say so, and its demo still shows fixed figures.
  'finance/assistant',
  'finance/dashboard',
  'finance/customers-suppliers',
  'finance/products',
  'finance/invoices',
  'finance/payments-in',
  'finance/quotations',
  'finance/rfqs',
  'finance/purchase-orders',
  'finance/credit-notes',
  'finance/refunds',
  'finance/supplier-bills',
  'finance/payments-out',
  'finance/cash-receipts',
  'finance/payment-vouchers',
  'finance/expenses',
  'finance/banking',
  'finance/receipts-inbox',
  'finance/chart-of-accounts',
  'finance/journals',
  'finance/contra-entries',
  // Month-end revaluation of foreign-currency balances (#224).
  'finance/fx-revaluation',
  'finance/reports',
  // SST settings are live (#222 stage 1); the return below them is still sample until stage 2.
  'finance/sst-report',
  // Reads the finance rows of the activity log (2026-10-23); history starts on the go-live date.
  'finance/audit-trail',
  // Financial year, books lock, numbering, and the company details from Account → Company (2026-10-23).
  'finance/settings',
]);

/** Whether the app path is a screen that is not connected to live data yet. */
export function isSampleScreen(pathname: string): boolean {
  const [, key, slug] = pathname.split('/');
  const product = getProduct(key);
  // Tuah has no sections: it is the chat itself, not a sample screen.
  if (!product || !findItem(product, slug)) return false;
  return !LIVE_SCREENS.has(`${key}/${slug}`);
}
