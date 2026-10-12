import { DEFAULT_PEOPLE_SETTINGS, type PeopleData } from '@/lib/people/types';

/**
 * The sample data as the database would hand it to a member who is not an HR
 * admin and is linked to `employeeId`: the directory and other shared tables in
 * full, personal rows only when they are their own, no payroll runs, no payslip that is still a draft, only their
 * own RELEASED reviews, only their own ISSUED letters, no letter template, and only published announcements.
 */
export function asMember(data: PeopleData, employeeId: string): PeopleData {
  const mine = <T extends { employee_id: string }>(rows: T[]) => rows.filter((row) => row.employee_id === employeeId);
  return {
    ...data,
    getEmployeePrivate: async (id) => (id === employeeId ? data.getEmployeePrivate(id) : null),
    listLeaveRequests: async () => mine(await data.listLeaveRequests()),
    listLeaveBalances: async (year) => mine(await data.listLeaveBalances(year)),
    listTimeOffRequests: async () => mine(await data.listTimeOffRequests()),
    listClaims: async () => mine(await data.listClaims()),
    listOvertime: async () => mine(await data.listOvertime()),
    listAttendance: async (from, to) => mine(await data.listAttendance(from, to)),
    listTimesheet: async (from, to) => mine(await data.listTimesheet(from, to)),
    listShifts: async (from, to) => mine(await data.listShifts(from, to)),
    listPayrollRuns: async () => [],
    // The database gives a member their own payslip only once it is paid.
    listPayslips: async () => mine(await data.listPayslips()).filter((slip) => slip.status === 'paid'),
    listGoals: async () => mine(await data.listGoals()),
    // The database gives a member their own review only once it is released.
    listReviews: async () => mine(await data.listReviews()).filter((review) => review.status === 'released'),
    listTrainingEnrolments: async () => mine(await data.listTrainingEnrolments()),
    // The database gives a member an announcement only once it is published.
    listAnnouncements: async () => (await data.listAnnouncements()).filter((post) => post.status === 'published'),
    listDocuments: async () => mine(await data.listDocuments()),
    // The database gives a member their own letter only once it is issued, and no template at all.
    listLetters: async () => mine(await data.listLetters()).filter((letter) => letter.status === 'issued'),
    listLetterTemplates: async () => [],
    listPaymentVouchers: async () => [],
    getSettings: async () => structuredClone(DEFAULT_PEOPLE_SETTINGS),
  };
}
