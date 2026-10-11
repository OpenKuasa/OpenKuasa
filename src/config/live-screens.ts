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
  // Shared with People (registry 'people/calendar'), which still shows the sample.
  'crm/calendar',
  // Shared with Jebat's analytics (registry 'reach/reports'); /reach/reports
  // is not a nav item, so the screen is served at /crm/reports.
  'crm/reports',

  // Lekir (read-only for now; Settings joins in a later slice)
  'hire/assistant',
  'hire/dashboard',
  'hire/jobs',
  'hire/candidates',
  'hire/applications',
  'hire/interviews',
  'hire/talent-pool',
  'hire/careers-page',

  // Lekiu: every screen reads the workspace's HR data. Its Calendar is the CRM's shared screen (see above).
  'people/assistant',
  'people/dashboard',
  'people/announcements',
  'people/my-attendance',
  'people/my-goals',
  'people/my-documents',
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
  'people/public-holidays',
  'people/letters',
  'people/timesheet',
  'people/shift-calendar',
  'people/overtime',
  'people/payroll',
  'people/payment-vouchers',
  'people/scorecard',
  'people/review-scores',
  'people/training',
  'people/settings',

  // Bendahara
  'finance/customers-suppliers',
  'finance/products',
  'finance/invoices',
  'finance/payments-in',
  // Read-only so far: their forms and row actions join in the next slice.
  'finance/quotations',
  'finance/credit-notes',
  'finance/refunds',
  'finance/supplier-bills',
  'finance/payments-out',
]);

/** Whether the app path is a screen that is not connected to live data yet. */
export function isSampleScreen(pathname: string): boolean {
  const [, key, slug] = pathname.split('/');
  const product = getProduct(key);
  // Tuah has no sections: it is the chat itself, not a sample screen.
  if (!product || !findItem(product, slug)) return false;
  return !LIVE_SCREENS.has(`${key}/${slug}`);
}
