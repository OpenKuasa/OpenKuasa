/**
 * The list of built screens. Nothing in the app imports this file: importing
 * it would put every screen's scripts on every page.
 *
 * `scripts/gen-screen-routes.mjs` reads it and writes one route file per
 * screen under `src/app/(app)/<product>/<item>/page.tsx`.
 *
 * To add a screen: import it and add its key below (the key must be an item in
 * `src/config/nav.ts`), then run `pnpm gen:routes` and commit the new
 * `page.tsx` with your change. `pnpm dev` and `pnpm build` run it for you.
 */
import type { ComponentType } from 'react';

// Jebat (reach)
import AssistantScreen from '@/screens/reach/assistant';
import AgentsScreen from '@/screens/reach/agents';
import AdStudioScreen from '@/screens/reach/ad-studio';
import CreativeBankScreen from '@/screens/reach/creative-bank';
import ReportsScreen from '@/screens/reach/reports';
import ContactsScreen from '@/screens/reach/contacts';
import LeadsScreen from '@/screens/reach/leads';
import LeadFormsScreen from '@/screens/reach/lead-forms';
import AppointmentsScreen from '@/screens/reach/appointments';
import AdSettingsScreen from '@/screens/reach/ad-settings';

// Kasturi (crm)
import CrmAssistantScreen from '@/screens/crm/assistant';
import CrmAgentsScreen from '@/screens/crm/agents';
import DealsScreen from '@/screens/crm/deals';
import BroadcastScreen from '@/screens/crm/broadcast';
import ChatbotScreen from '@/screens/crm/chatbot';
import AutomationsScreen from '@/screens/crm/automations';
import CrmLandingPageScreen from '@/screens/crm/landing-page';
import CalendarScreen from '@/screens/crm/calendar';
import BillingsScreen from '@/screens/crm/billings';
import PluginsScreen from '@/screens/crm/plugins';
import CrmSettingsScreen from '@/screens/crm/settings';

// Lekiu (people / HIRA)
import HrAssistantScreen from '@/screens/people/assistant';
import DashboardScreen from '@/screens/people/dashboard';
import AnnouncementsScreen from '@/screens/people/announcements';
import MyAttendanceScreen from '@/screens/people/my-attendance';
import MyGoalsScreen from '@/screens/people/my-goals';
import MyDocumentsScreen from '@/screens/people/my-documents';
import MyPayslipsScreen from '@/screens/people/my-payslips';
import RecordsScreen from '@/screens/people/records';
import LeaveScreen from '@/screens/people/leave';
import TimeOffScreen from '@/screens/people/time-off';
import ClaimsScreen from '@/screens/people/claims';
import OtClaimsScreen from '@/screens/people/ot-claims';
import EmployeesScreen from '@/screens/people/employees';
import TeamAttendanceScreen from '@/screens/people/attendance';
import ApproveLeaveScreen from '@/screens/people/approve-leave';
import ApproveClaimsScreen from '@/screens/people/approve-claims';
import ApproveOvertimeScreen from '@/screens/people/approve-overtime';
import ApproveTimeOffScreen from '@/screens/people/approve-time-off';
import PublicHolidaysScreen from '@/screens/people/public-holidays';
import LettersScreen from '@/screens/people/letters';
import TimesheetScreen from '@/screens/people/timesheet';
import ShiftCalendarScreen from '@/screens/people/shift-calendar';
import OvertimeScreen from '@/screens/people/overtime';
import PayrollScreen from '@/screens/people/payroll';
import PaymentVouchersScreen from '@/screens/people/payment-vouchers';
import ScorecardScreen from '@/screens/people/scorecard';
import ReviewScoresScreen from '@/screens/people/review-scores';
import TrainingScreen from '@/screens/people/training';
import HrSettingsScreen from '@/screens/people/settings';

// Lekir (hire / HIRA Recruit)
import HireAssistantScreen from '@/screens/hire/assistant';
import RecruitDashboardScreen from '@/screens/hire/dashboard';
import JobsScreen from '@/screens/hire/jobs';
import CandidatesScreen from '@/screens/hire/candidates';
import ApplicationsScreen from '@/screens/hire/applications';
import InterviewsScreen from '@/screens/hire/interviews';
import TalentPoolScreen from '@/screens/hire/talent-pool';
import CareersPageScreen from '@/screens/hire/careers-page';
import HireSettingsScreen from '@/screens/hire/settings';

// Bendahara (finance / Safa)
import FinAssistantScreen from '@/screens/finance/assistant';
import FinAgentsScreen from '@/screens/finance/agents';
import FinDashboardScreen from '@/screens/finance/dashboard';
import CashReceiptsScreen from '@/screens/finance/cash-receipts';
import FinPaymentVouchersScreen from '@/screens/finance/payment-vouchers';
import InvoicesScreen from '@/screens/finance/invoices';
import QuotationsScreen from '@/screens/finance/quotations';
import RfqsScreen from '@/screens/finance/rfqs';
import CreditNotesScreen from '@/screens/finance/credit-notes';
import PaymentsInScreen from '@/screens/finance/payments-in';
import RefundsScreen from '@/screens/finance/refunds';
import ExpensesScreen from '@/screens/finance/expenses';
import ReceiptsInboxScreen from '@/screens/finance/receipts-inbox';
import SupplierBillsScreen from '@/screens/finance/supplier-bills';
import PaymentsOutScreen from '@/screens/finance/payments-out';
import BankingScreen from '@/screens/finance/banking';
import EInvoiceScreen from '@/screens/finance/e-invoice';
import SstReportScreen from '@/screens/finance/sst-report';
import AuditTrailScreen from '@/screens/finance/audit-trail';
import CustomersSuppliersScreen from '@/screens/finance/customers-suppliers';
import ProductsScreen from '@/screens/finance/products';
import FinReportsScreen from '@/screens/finance/reports';
import JournalsScreen from '@/screens/finance/journals';
import ChartOfAccountsScreen from '@/screens/finance/chart-of-accounts';
import ContraEntriesScreen from '@/screens/finance/contra-entries';
import FxRevaluationScreen from '@/screens/finance/fx-revaluation';
import FinSettingsScreen from '@/screens/finance/settings';

/**
 * Built-out screens, keyed by `${productKey}/${itemSlug}`.
 * Anything not here falls back to a generic placeholder.
 */
export const SCREENS: Record<string, ComponentType> = {
  // Jebat (ARA Get)
  'reach/assistant': AssistantScreen,
  'reach/agents': AgentsScreen,
  'reach/ad-studio': AdStudioScreen,
  'reach/creative-bank': CreativeBankScreen,
  'reach/reports': ReportsScreen,
  'reach/leads': LeadsScreen,
  'reach/lead-forms': LeadFormsScreen,
  'reach/appointments': AppointmentsScreen,
  'reach/ad-settings': AdSettingsScreen,

  // Kasturi (ARA Manage)
  'crm/assistant': CrmAssistantScreen,
  'crm/agents': CrmAgentsScreen,
  'crm/contacts': ContactsScreen,
  'crm/deals': DealsScreen,
  'crm/lead-forms': LeadFormsScreen,
  'crm/broadcast': BroadcastScreen,
  'crm/chatbot': ChatbotScreen,
  'crm/automations': AutomationsScreen,
  'crm/landing-page': CrmLandingPageScreen,
  'crm/appointments': AppointmentsScreen,
  'crm/calendar': CalendarScreen,
  'crm/billings': BillingsScreen,
  'crm/reports': ReportsScreen,
  'crm/plugins': PluginsScreen,
  'crm/settings': CrmSettingsScreen,

  // Lekiu (HIRA Team)
  'people/assistant': HrAssistantScreen,
  'people/dashboard': DashboardScreen,
  'people/calendar': CalendarScreen,
  'people/announcements': AnnouncementsScreen,
  'people/my-attendance': MyAttendanceScreen,
  'people/my-goals': MyGoalsScreen,
  'people/my-documents': MyDocumentsScreen,
  'people/my-payslips': MyPayslipsScreen,
  'people/records': RecordsScreen,
  'people/leave': LeaveScreen,
  'people/time-off': TimeOffScreen,
  'people/claims': ClaimsScreen,
  'people/ot-claims': OtClaimsScreen,
  'people/employees': EmployeesScreen,
  'people/attendance': TeamAttendanceScreen,
  'people/approve-leave': ApproveLeaveScreen,
  'people/approve-claims': ApproveClaimsScreen,
  'people/approve-overtime': ApproveOvertimeScreen,
  'people/approve-time-off': ApproveTimeOffScreen,
  'people/public-holidays': PublicHolidaysScreen,
  'people/letters': LettersScreen,
  'people/timesheet': TimesheetScreen,
  'people/shift-calendar': ShiftCalendarScreen,
  'people/overtime': OvertimeScreen,
  'people/payroll': PayrollScreen,
  'people/payment-vouchers': PaymentVouchersScreen,
  'people/scorecard': ScorecardScreen,
  'people/review-scores': ReviewScoresScreen,
  'people/training': TrainingScreen,
  'people/settings': HrSettingsScreen,

  // Lekir (HIRA Recruit)
  'hire/assistant': HireAssistantScreen,
  'hire/dashboard': RecruitDashboardScreen,
  'hire/jobs': JobsScreen,
  'hire/candidates': CandidatesScreen,
  'hire/applications': ApplicationsScreen,
  'hire/interviews': InterviewsScreen,
  'hire/talent-pool': TalentPoolScreen,
  'hire/careers-page': CareersPageScreen,
  'hire/settings': HireSettingsScreen,

  // Bendahara (Safa — Accounting & e-Invois)
  'finance/assistant': FinAssistantScreen,
  'finance/agents': FinAgentsScreen,
  'finance/dashboard': FinDashboardScreen,
  'finance/cash-receipts': CashReceiptsScreen,
  'finance/payment-vouchers': FinPaymentVouchersScreen,
  'finance/invoices': InvoicesScreen,
  'finance/quotations': QuotationsScreen,
  'finance/rfqs': RfqsScreen,
  'finance/credit-notes': CreditNotesScreen,
  'finance/payments-in': PaymentsInScreen,
  'finance/refunds': RefundsScreen,
  'finance/expenses': ExpensesScreen,
  'finance/receipts-inbox': ReceiptsInboxScreen,
  'finance/supplier-bills': SupplierBillsScreen,
  'finance/payments-out': PaymentsOutScreen,
  'finance/banking': BankingScreen,
  'finance/e-invoice': EInvoiceScreen,
  'finance/sst-report': SstReportScreen,
  'finance/audit-trail': AuditTrailScreen,
  'finance/customers-suppliers': CustomersSuppliersScreen,
  'finance/products': ProductsScreen,
  'finance/reports': FinReportsScreen,
  'finance/journals': JournalsScreen,
  'finance/chart-of-accounts': ChartOfAccountsScreen,
  'finance/contra-entries': ContraEntriesScreen,
  'finance/fx-revaluation': FxRevaluationScreen,
  'finance/settings': FinSettingsScreen,
};
