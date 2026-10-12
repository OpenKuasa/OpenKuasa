import { describe, expect, it } from 'vitest';
import { approvalDetail, approvalTitle, collectNames, nameIn } from '@/lib/chat/change-titles';

const EMP = '22222222-2222-4222-8222-222222222222';
const DEPT = '11111111-1111-4111-8111-111111111111';
const results = [
  { tool: 'listEmployees', output: { total: 1, employees: [{ id: EMP, name: 'Faiz Hakim' }] } },
  { tool: 'listDepartments', output: { total: 1, departments: [{ id: DEPT, name: 'Marketing', headcount: 3 }] } },
];
const named = nameIn(results);

describe('approval cards for HR changes', () => {
  it('names the employee a change is about', () => {
    expect(approvalTitle('createEmployee', { name: 'Farah Idris' })).toBe('Add employee “Farah Idris”?');
    expect(approvalTitle('updateEmployee', { id: EMP, designation: 'Lead' }, named)).toBe(
      'Save changes to employee “Faiz Hakim”?',
    );
    expect(approvalTitle('setEmployeeStatus', { id: EMP, status: 'inactive' }, named)).toBe(
      'Deactivate employee “Faiz Hakim”?',
    );
    expect(approvalTitle('setEmployeeStatus', { id: EMP, status: 'active' }, named)).toBe(
      'Reactivate employee “Faiz Hakim”?',
    );
    expect(approvalTitle('deleteEmployee', { id: EMP }, named)).toBe('Delete employee “Faiz Hakim”?');
  });

  it('says what linking does', () => {
    expect(approvalTitle('linkEmployeeToMember', { id: EMP, memberEmail: 'faiz@example.com' }, named)).toBe(
      'Link employee “Faiz Hakim” to the account faiz@example.com?',
    );
    expect(approvalTitle('linkEmployeeToMember', { id: EMP, memberEmail: null }, named)).toBe(
      'Unlink employee “Faiz Hakim” from their account?',
    );
    // Only an explicit null unlinks; a blank or missing email is not a request to.
    expect(approvalTitle('linkEmployeeToMember', { id: EMP, memberEmail: '  ' }, named)).toBe('Approve this change?');
    expect(approvalTitle('linkEmployeeToMember', { id: EMP }, named)).toBe('Approve this change?');
  });

  it('names the department a change is about', () => {
    expect(approvalTitle('createDepartment', { name: 'Legal' })).toBe('Add department “Legal”?');
    expect(approvalTitle('updateDepartment', { id: DEPT, name: 'Brand' }, named)).toBe(
      'Rename department “Marketing” to “Brand”?',
    );
    expect(approvalTitle('deleteDepartment', { id: DEPT }, named)).toBe('Delete department “Marketing”?');
  });

  it('falls back to plain words when the name is not known', () => {
    expect(approvalTitle('deleteEmployee', { id: EMP })).toBe('Delete this employee?');
    expect(approvalTitle('updateDepartment', { id: DEPT, name: 'Brand' })).toBe('Rename this department to “Brand”?');
  });

  it('never puts a name of the wrong kind on a card', () => {
    // An employee change given a department's id, and the other way round.
    expect(approvalTitle('deleteEmployee', { id: DEPT }, named)).toBe('Delete this employee?');
    expect(approvalTitle('deleteDepartment', { id: EMP }, named)).toBe('Delete this department?');
  });

  it('warns what goes with a deleted employee', () => {
    expect(approvalDetail('deleteEmployee')).toBe(
      'Their leave, claims, draft payslips and every other HR record are deleted too, including their documents, the files attached to them and their letters. This cannot be undone. Someone with a paid payslip cannot be deleted: make them inactive instead.',
    );
    expect(approvalDetail('deleteDepartment')).toBe('This cannot be undone.');
    expect(approvalDetail('updateEmployee')).toBeNull();
  });

  it('says what an employee update sets', () => {
    expect(
      approvalDetail('updateEmployee', { id: EMP, designation: 'Lead', private: { base_salary: 4500 } }),
    ).toBe('Changes: designation, monthly salary (RM 4,500.00)');
  });

  it('says a bank account is cleared without showing it', () => {
    expect(approvalDetail('updateEmployee', { id: EMP, private: { bank_account: null } })).toBe(
      'Changes: bank account (cleared)',
    );
    expect(approvalDetail('updateEmployee', { id: EMP, work_email: '' })).toBe('Changes: work email (cleared)');
  });

  it('shows a status change and a work email sent through updateEmployee', () => {
    expect(approvalDetail('updateEmployee', { id: EMP, status: 'inactive', work_email: 'f@example.com' })).toBe(
      'Changes: work email (f@example.com), status (inactive)',
    );
  });

  it('names sensitive fields on an update but never shows their values', () => {
    const detail = approvalDetail('updateEmployee', {
      id: EMP,
      private: { nric: '900101-14-5678', phone: '012-3456789', address: '1 Jalan Satu', tax_no: 'SG123' },
    });
    expect(detail).toBe('Changes: NRIC, phone, address, tax number');
  });

  it('lists what a new employee is given, without the NRIC value', () => {
    const detail = approvalDetail('createEmployee', {
      name: 'Farah Idris',
      private: { base_salary: 4500, nric: '900101-14-5678' },
    });
    expect(detail).toBe('Sets: monthly salary (RM 4,500.00), NRIC');
    expect(detail).not.toContain('900101');
  });

  it('gives a new employee with only a name no detail line', () => {
    expect(approvalDetail('createEmployee', { name: 'Farah Idris' })).toBeNull();
  });

  it('remembers employee and department names by kind for later turns', () => {
    expect(collectNames(results)).toEqual({ [`employee:${EMP}`]: 'Faiz Hakim', [`department:${DEPT}`]: 'Marketing' });
  });
});

describe('approval cards for leave and time-off', () => {
  const REQ = '44444444-4444-4444-8444-444444444444';
  const TOREQ = '55555555-5555-4555-8555-555555555555';
  const leave = [
    { tool: 'listEmployees', output: { employees: [{ id: EMP, name: 'Farah Idris' }] } },
    {
      tool: 'listLeaveRequests',
      output: {
        requests: [
          { id: REQ, employee: 'Amirul Hakim', type: 'Annual leave', leave_type: 'annual', start_date: '2026-10-16', end_date: '2026-10-16', status: 'pending' },
        ],
      },
    },
    {
      tool: 'listTimeOffRequests',
      output: { requests: [{ id: TOREQ, employee: 'Amirul Hakim', off_date: '2026-10-16', start_time: '14:00', end_time: '16:00' }] },
    },
  ];
  const find = nameIn(leave);

  it('words an application from its own input, with no day count or balance', () => {
    const input = { leave_type: 'annual', start_date: '2026-10-20', end_date: '2026-10-22' };
    expect(approvalTitle('applyLeave', input)).toBe('Apply for annual leave for yourself, 20–22 Oct?');
    expect(approvalTitle('applyLeave', { ...input, leave_type: 'medical', end_date: '2026-10-20' })).toBe('Apply for medical leave for yourself, 20 Oct?');
    expect(approvalTitle('applyLeave', { ...input, start_date: '2026-10-30', end_date: '2026-11-02' })).toBe(
      'Apply for annual leave for yourself, 30 Oct–2 Nov?',
    );
    expect(approvalTitle('applyLeave', { ...input, end_date: '2026-10-20', half_day: true })).toBe(
      'Apply for annual leave for yourself, 20 Oct (half day)?',
    );
    expect(approvalTitle('applyTimeOff', { off_date: '2026-10-20', start_time: '14:00', end_time: '16:00' })).toBe(
      'Request time-off for yourself, 20 Oct, 14:00–16:00?',
    );
    expect(approvalDetail('applyLeave', input)).toBeNull();
    // What will be saved under the person's name is quoted and labelled.
    expect(approvalDetail('applyLeave', { ...input, reason: ' Family trip ' })).toBe('Reason: “Family trip”');
    expect(approvalDetail('applyTimeOff', { off_date: '2026-10-20', reason: 'Clinic' })).toBe('Reason: “Clinic”');
    expect(approvalDetail('applyTimeOff', { off_date: '2026-10-20' })).toBeNull();
  });

  it('a member’s card, which has no employee, names no one; an owner’s names who it is for', () => {
    const input = { leave_type: 'annual', start_date: '2026-10-20', end_date: '2026-10-22' };
    expect(approvalTitle('applyLeave', input, find)).toBe('Apply for annual leave for yourself, 20–22 Oct?');
    expect(approvalTitle('applyLeave', { ...input, employee_id: EMP }, find)).toBe('Apply for annual leave for Farah Idris, 20–22 Oct?');
  });

  it('an employee id of the wrong kind never names someone', () => {
    const input = { leave_type: 'annual', start_date: '2026-10-20', end_date: '2026-10-22' };
    // A request's id, a department's id and an unknown id are not employees.
    // It must not read like a member's own card, which has no employee at all.
    for (const id of [REQ, DEPT, 'nobody']) {
      expect(approvalTitle('applyLeave', { ...input, employee_id: id }, find)).toBe(
        'Apply for annual leave for this employee, 20–22 Oct?',
      );
      expect(approvalTitle('applyTimeOff', { employee_id: id, off_date: '2026-10-20', start_time: '14:00', end_time: '16:00' }, find)).toBe(
        'Request time-off for this employee, 20 Oct, 14:00–16:00?',
      );
    }
    expect(approvalTitle('setLeaveEntitlement', { employee_id: REQ, leave_type: 'annual', year: 2026, days: 18 }, find)).toBe(
      "Set this employee's annual leave for 2026 to 18 days?",
    );
    // And an employee's id never labels a request.
    expect(approvalTitle('decideLeave', { id: EMP, approve: true }, find)).toBe('Approve a leave request that was not in the list above?');
    expect(approvalTitle('cancelLeaveRequest', { id: EMP }, find)).toBe('Cancel a leave request that was not in the list above?');
  });

  it('names the request being cancelled, approved or rejected', () => {
    expect(approvalTitle('cancelLeaveRequest', { id: REQ }, find)).toBe("Cancel Amirul Hakim's annual leave, 16 Oct?");
    expect(approvalTitle('cancelTimeOffRequest', { id: TOREQ }, find)).toBe("Cancel Amirul Hakim's time-off, 16 Oct?");
    expect(approvalTitle('decideLeave', { id: REQ, approve: true }, find)).toBe("Approve Amirul Hakim's annual leave, 16 Oct?");
    expect(approvalTitle('decideLeave', { id: REQ, approve: false }, find)).toBe("Reject Amirul Hakim's annual leave, 16 Oct?");
    expect(approvalTitle('decideTimeOff', { id: TOREQ, approve: true }, find)).toBe("Approve Amirul Hakim's time-off, 16 Oct?");
    // A request no lookup named says so, rather than reading like a known one.
    expect(approvalTitle('decideLeave', { id: REQ, approve: true })).toBe('Approve a leave request that was not in the list above?');
    expect(approvalTitle('decideLeave', { id: REQ, approve: false })).toBe('Reject a leave request that was not in the list above?');
    expect(approvalTitle('decideTimeOff', { id: TOREQ, approve: true })).toBe('Approve a time-off request that was not in the list above?');
    expect(approvalTitle('decideTimeOff', { id: TOREQ, approve: false })).toBe('Reject a time-off request that was not in the list above?');
    expect(approvalTitle('cancelTimeOffRequest', { id: TOREQ })).toBe('Cancel a time-off request that was not in the list above?');
  });

  it('shows the rejection note as the detail, and nothing for an approval', () => {
    expect(approvalDetail('decideLeave', { id: REQ, approve: false, note: ' Busy week ' })).toBe('Note: “Busy week”');
    expect(approvalDetail('decideTimeOff', { id: TOREQ, approve: false, note: 'Clash' })).toBe('Note: “Clash”');
    expect(approvalDetail('decideLeave', { id: REQ, approve: false })).toBeNull();
    expect(approvalDetail('decideLeave', { id: REQ, approve: true, note: 'ignored' })).toBeNull();
  });

  it('words an entitlement with the employee’s name', () => {
    expect(approvalTitle('setLeaveEntitlement', { employee_id: EMP, leave_type: 'annual', year: 2026, days: 18 }, find)).toBe(
      "Set Farah Idris's annual leave for 2026 to 18 days?",
    );
    expect(approvalTitle('setLeaveEntitlement', { employee_id: EMP, leave_type: 'medical', year: 2026, days: 1 }, find)).toBe(
      "Set Farah Idris's medical leave for 2026 to 1 day?",
    );
  });

  it('falls back to plain words for dates that are not dates, and does no arithmetic', () => {
    expect(approvalTitle('applyLeave', { leave_type: 'annual', start_date: 'soon', end_date: '2026-13-40' })).toBe('Apply for annual leave for yourself?');
    expect(approvalTitle('applyLeave', {})).toBe('Apply for leave for yourself?');
  });

  it('remembers a request by kind for later turns', () => {
    expect(collectNames(leave)).toEqual({
      [`employee:${EMP}`]: 'Farah Idris',
      [`leave:${REQ}`]: "Amirul Hakim's annual leave, 16 Oct",
      [`time-off:${TOREQ}`]: "Amirul Hakim's time-off, 16 Oct",
    });
  });
});

describe('approval cards for claims and overtime', () => {
  const CLAIM_ID = '66666666-6666-4666-8666-666666666666';
  const OT_ID = '77777777-7777-4777-8777-777777777777';
  const EMPLOYEE = '88888888-8888-4888-8888-888888888888';
  const UNLISTED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const lookups = [
    { tool: 'listEmployees', output: { employees: [{ id: EMPLOYEE, name: 'Amirul Hakim' }] } },
    {
      tool: 'listClaims',
      output: {
        claims: [
          { id: CLAIM_ID, employee: 'Amirul Hakim', category: 'Travel claim', category_code: 'travel', amount: 'RM 85.00', status: 'pending' },
          { id: '99999999-9999-4999-8999-999999999999', employee: 'Farah Idris', category: 'Medical claim', category_code: 'medical', amount: 'RM 1,120.00' },
        ],
      },
    },
    {
      tool: 'listOvertime',
      output: { overtime: [{ id: OT_ID, employee: 'Amirul Hakim', work_date: '2026-10-10', hours: 3, status: 'pending' }] },
    },
  ];
  const find = nameIn(lookups);
  const claim = { category: 'travel', amount_cents: 8500, claim_date: '2026-10-09' };

  it('words a claim from its own input, in Ringgit from the sen, with the date', () => {
    expect(approvalTitle('submitClaim', claim)).toBe('Claim RM 85.00 for travel, 9 Oct, for yourself?');
    expect(approvalTitle('submitClaim', { ...claim, amount_cents: 112050, category: 'medical' })).toBe('Claim RM 1,120.50 for medical, 9 Oct, for yourself?');
    expect(approvalTitle('submitClaim', { ...claim, amount_cents: 5, category: 'other' })).toBe('Claim RM 0.05 for other expenses, 9 Oct, for yourself?');
  });

  it('names the employee only when an owner or admin gave one, and never on a member’s card', () => {
    // A member's input has no employee at all: the card names nobody, whatever the lookups hold.
    expect(approvalTitle('submitClaim', claim, find)).not.toContain('Amirul');
    expect(approvalTitle('submitOvertime', { work_date: '2026-10-10', hours: 3 }, find)).toBe('Claim 3 hours of overtime on 10 Oct for yourself?');
    expect(approvalTitle('submitClaim', { ...claim, employee_id: EMPLOYEE }, find)).toBe('Claim RM 85.00 for travel, 9 Oct, for Amirul Hakim?');
    // An employee no lookup named is never taken for the caller.
    expect(approvalTitle('submitClaim', { ...claim, employee_id: EMP }, find)).toBe('Claim RM 85.00 for travel, 9 Oct, for this employee?');
    expect(approvalTitle('submitOvertime', { employee_id: EMP, work_date: '2026-10-10', hours: 1 }, find)).toBe(
      'Claim 1 hour of overtime on 10 Oct for this employee?',
    );
  });

  it('says whether a receipt goes with the claim, from the conversation and not from the input', () => {
    expect(approvalDetail('submitClaim', claim, { state: 'attached' })).toBe('Sent with the attached receipt');
    expect(approvalDetail('submitClaim', claim, { state: 'none' })).toBe('Sent with no receipt');
    // The model cannot make a card say a receipt goes with the claim.
    expect(approvalDetail('submitClaim', { ...claim, receipt_attached: true }, { state: 'none' })).toBe('Sent with no receipt');
    expect(approvalDetail('submitClaim', { ...claim, receipt_attached: true }, { state: 'unusable', problem: 'Keep the file to 5 MB or less.' })).toBe(
      'The attached file cannot be used as a receipt (Keep the file to 5 MB or less.): sent with no receipt',
    );
  });

  it('says nothing about a receipt where the conversation is not known, and quotes the description', () => {
    expect(approvalDetail('submitClaim', claim)).toBeNull();
    expect(approvalDetail('submitClaim', { ...claim, description: ' Taxi to the client ' }, { state: 'attached' })).toBe(
      'Sent with the attached receipt · Description: “Taxi to the client”',
    );
    expect(approvalDetail('submitClaim', { ...claim, description: 'Taxi' })).toBe('Description: “Taxi”');
  });

  it('carries no amount on an overtime card, and quotes the reason', () => {
    const input = { work_date: '2026-10-10', hours: 2.5, reason: 'Stocktake' };
    expect(approvalTitle('submitOvertime', input)).toBe('Claim 2.5 hours of overtime on 10 Oct for yourself?');
    expect(approvalTitle('submitOvertime', input)).not.toMatch(/RM/);
    expect(approvalDetail('submitOvertime', input)).toBe('Reason: “Stocktake”');
    expect(approvalDetail('submitOvertime', { work_date: '2026-10-10', hours: 2 })).toBeNull();
  });

  it('names a claim or overtime record from the lookup that listed it', () => {
    expect(approvalTitle('cancelClaim', { id: CLAIM_ID }, find)).toBe("Cancel Amirul Hakim's RM 85.00 travel claim?");
    expect(approvalTitle('decideClaim', { id: CLAIM_ID, approve: true }, find)).toBe("Approve Amirul Hakim's RM 85.00 travel claim?");
    expect(approvalTitle('decideClaim', { id: CLAIM_ID, approve: false }, find)).toBe("Reject Amirul Hakim's RM 85.00 travel claim?");
    expect(approvalTitle('markClaimPaid', { id: CLAIM_ID, paid_on: '2026-10-10' }, find)).toBe("Mark Amirul Hakim's RM 85.00 travel claim as paid?");
    expect(approvalTitle('unmarkClaimPaid', { id: CLAIM_ID }, find)).toBe("Undo the paid mark on Amirul Hakim's RM 85.00 travel claim?");
    expect(approvalTitle('cancelOvertime', { id: OT_ID }, find)).toBe("Cancel Amirul Hakim's 3 hours of overtime on 10 Oct?");
    expect(approvalTitle('decideOvertime', { id: OT_ID, approve: true }, find)).toBe("Approve Amirul Hakim's 3 hours of overtime on 10 Oct?");
  });

  it('reads as a request not in the lists above when no lookup named it, and never borrows another kind’s name', () => {
    expect(approvalTitle('cancelClaim', { id: UNLISTED }, find)).toBe('Cancel a claim that was not in the list above?');
    expect(approvalTitle('decideOvertime', { id: UNLISTED, approve: true }, find)).toBe('Approve an overtime record that was not in the list above?');
    // A claim's id on an overtime card, and the other way round.
    expect(approvalTitle('cancelOvertime', { id: CLAIM_ID }, find)).toBe('Cancel an overtime record that was not in the list above?');
    expect(approvalTitle('cancelClaim', { id: OT_ID }, find)).toBe('Cancel a claim that was not in the list above?');
    expect(approvalTitle('cancelClaim', { id: EMPLOYEE }, find)).toBe('Cancel a claim that was not in the list above?');
  });

  it('shows the rejection note, and the paid date and reference', () => {
    expect(approvalDetail('decideClaim', { id: CLAIM_ID, approve: false, note: ' Receipt unreadable ' })).toBe('Note: “Receipt unreadable”');
    expect(approvalDetail('decideOvertime', { id: OT_ID, approve: false, note: 'Not agreed' })).toBe('Note: “Not agreed”');
    expect(approvalDetail('decideClaim', { id: CLAIM_ID, approve: true, note: 'ignored' })).toBeNull();
    expect(approvalDetail('markClaimPaid', { id: CLAIM_ID, paid_on: '2026-10-10' })).toBe('Paid on 10 Oct 2026');
    expect(approvalDetail('markClaimPaid', { id: CLAIM_ID, paid_on: '2026-10-10', reference: 'TRX-9' })).toBe(
      'Paid on 10 Oct 2026 · Reference: “TRX-9”',
    );
  });

  it('falls back to plain words for an amount or date that is not one, and does no arithmetic', () => {
    expect(approvalTitle('submitClaim', { category: 'travel', amount_cents: 85.5, claim_date: 'soon' })).toBe('Claim for travel, for yourself?');
    expect(approvalTitle('submitClaim', {})).toBe('Claim, for yourself?');
    expect(approvalTitle('submitOvertime', { work_date: '2026-13-40', hours: 'lots' })).toBe('Claim overtime for yourself?');
  });

  it('remembers a claim and an overtime record by kind for later turns', () => {
    expect(collectNames(lookups)).toMatchObject({
      [`claim:${CLAIM_ID}`]: "Amirul Hakim's RM 85.00 travel claim",
      [`overtime:${OT_ID}`]: "Amirul Hakim's 3 hours of overtime on 10 Oct",
    });
  });
});

describe('approval cards for an owner or admin’s own request', () => {
  const find = nameIn([{ tool: 'listEmployees', output: { total: 1, employees: [{ id: EMP, name: 'Faiz Hakim' }] } }]);
  const leave = { leave_type: 'annual', start_date: '2026-10-20', end_date: '2026-10-22' };
  const claim = { category: 'meals', amount_cents: 2340, claim_date: '2026-10-11' };

  it('reads as the caller’s own, never “for this employee”, when no employee is in the input', () => {
    for (const title of [
      approvalTitle('applyLeave', leave, find),
      approvalTitle('applyTimeOff', { off_date: '2026-10-20', start_time: '14:00', end_time: '16:00' }, find),
      approvalTitle('submitClaim', claim, find),
      approvalTitle('submitOvertime', { work_date: '2026-10-08', hours: 3 }, find),
    ]) {
      expect(title).not.toContain(' for this employee');
      expect(title).not.toContain('Faiz');
    }
    expect(approvalTitle('submitClaim', claim, find)).toBe('Claim RM 23.40 for meals, 11 Oct, for yourself?');
  });

  it('still names the employee when one is given, and never names a wrong-kind id', () => {
    expect(approvalTitle('submitClaim', { ...claim, employee_id: EMP }, find)).toBe('Claim RM 23.40 for meals, 11 Oct, for Faiz Hakim?');
    expect(approvalTitle('submitClaim', { ...claim, employee_id: DEPT }, find)).toBe('Claim RM 23.40 for meals, 11 Oct, for this employee?');
  });
});

describe('approval cards for attendance, holidays and attendance settings', () => {
  const HOLIDAY = '55555555-5555-4555-8555-555555555555';
  const lookups = [
    { tool: 'listEmployees', output: { total: 1, employees: [{ id: EMP, name: 'Amirul Hakim' }] } },
    { tool: 'listPublicHolidays', output: { holidays: [{ id: HOLIDAY, name: 'Deepavali', date: '2026-11-08', scope: 'national', state: null }] } },
    {
      tool: 'getAttendanceSettings',
      output: { id: 'attendance-settings', work_week: ['mon', 'tue', 'wed', 'thu', 'fri'], work_start_time: '09:00', work_start_label: '9:00 am', late_grace_minutes: 15 },
    },
  ];
  const find = nameIn(lookups);
  const day = { work_date: '2026-10-09' };

  it('the two clock cards carry no time, whatever the input holds', () => {
    expect(approvalTitle('clockIn', {})).toBe('Clock in now?');
    expect(approvalTitle('clockOut', {})).toBe('Clock out now?');
    expect(approvalTitle('clockIn', { time: '2026-10-01T03:00:00Z', employee_id: EMP }, find)).toBe('Clock in now?');
    expect(approvalDetail('clockIn', {})).toBeNull();
    expect(approvalDetail('clockOut', {})).toBeNull();
  });

  it('names the employee and the day, with the times as "9:00 am"', () => {
    expect(approvalTitle('correctAttendance', { employee_id: EMP, ...day, status: 'present', clock_in: '09:00', clock_out: '18:00' }, find)).toBe(
      "Correct Amirul Hakim's attendance on Fri, 9 Oct 2026 to present, 9:00 am to 6:00 pm?",
    );
    expect(approvalTitle('correctAttendance', { employee_id: EMP, ...day, status: 'late', clock_in: '10:05' }, find)).toBe(
      "Correct Amirul Hakim's attendance on Fri, 9 Oct 2026 to late, from 10:05 am?",
    );
    expect(approvalTitle('correctAttendance', { employee_id: EMP, ...day, status: 'on_leave' }, find)).toBe(
      "Correct Amirul Hakim's attendance on Fri, 9 Oct 2026 to on leave?",
    );
  });

  it('shows the times the tool will save: one-digit hours and seconds are read as the tool reads them', () => {
    expect(approvalTitle('correctAttendance', { employee_id: EMP, ...day, status: 'present', clock_in: '9:00', clock_out: '18:00' }, find)).toBe(
      "Correct Amirul Hakim's attendance on Fri, 9 Oct 2026 to present, 9:00 am to 6:00 pm?",
    );
    expect(approvalTitle('correctAttendance', { employee_id: EMP, ...day, status: 'late', clock_in: '09:00:00', clock_out: ' 18:30:00 ' }, find)).toBe(
      "Correct Amirul Hakim's attendance on Fri, 9 Oct 2026 to late, 9:00 am to 6:30 pm?",
    );
    expect(approvalTitle('correctAttendance', { employee_id: EMP, ...day, status: 'present', clock_in: '9:05', clock_out: '' }, find)).toBe(
      "Correct Amirul Hakim's attendance on Fri, 9 Oct 2026 to present, from 9:05 am?",
    );
  });

  it('shows no times for an absence, even when the input holds some', () => {
    expect(approvalTitle('correctAttendance', { employee_id: EMP, ...day, status: 'absent', clock_in: '09:00', clock_out: '18:00' }, find)).toBe(
      "Correct Amirul Hakim's attendance on Fri, 9 Oct 2026 to absent?",
    );
  });

  it('quotes the note on the second line, as typed', () => {
    expect(approvalDetail('correctAttendance', { note: 'Forgot to clock out' })).toBe('Note: “Forgot to clock out”');
    expect(approvalDetail('correctAttendance', { note: '  ' })).toBeNull();
    expect(approvalDetail('correctAttendance', {})).toBeNull();
  });

  it('a wrong-kind id never names someone: a holiday id is not an employee, and an unlisted employee is "this employee"', () => {
    expect(approvalTitle('correctAttendance', { employee_id: HOLIDAY, ...day, status: 'absent' }, find)).toBe(
      "Correct this employee's attendance on Fri, 9 Oct 2026 to absent?",
    );
    expect(approvalTitle('correctAttendance', { employee_id: EMP, ...day, status: 'absent' })).toBe(
      "Correct this employee's attendance on Fri, 9 Oct 2026 to absent?",
    );
    // And an employee id is not a holiday.
    expect(approvalTitle('removeHoliday', { id: EMP }, find)).toBe('Remove a public holiday that was not in the list above?');
    expect(approvalTitle('saveHoliday', { id: EMP, name: 'Deepavali', holiday_date: '2026-11-09' }, find)).toBe(
      'Change a public holiday that was not in the list above to Deepavali, 9 Nov 2026?',
    );
  });

  it('adds, changes and removes a holiday, naming it from the lookup', () => {
    expect(approvalTitle('saveHoliday', { name: 'Deepavali', holiday_date: '2026-11-08' }, find)).toBe('Add public holiday: Deepavali, 8 Nov 2026?');
    expect(approvalTitle('saveHoliday', { id: null, name: 'Deepavali', holiday_date: '2026-11-08' }, find)).toBe(
      'Add public holiday: Deepavali, 8 Nov 2026?',
    );
    expect(approvalTitle('saveHoliday', { id: HOLIDAY, name: 'Deepavali', holiday_date: '2026-11-09' }, find)).toBe(
      'Change public holiday Deepavali, 8 Nov 2026 to Deepavali, 9 Nov 2026?',
    );
    expect(approvalTitle('removeHoliday', { id: HOLIDAY }, find)).toBe('Remove public holiday: Deepavali, 8 Nov 2026?');
    expect(approvalTitle('removeHoliday', { id: HOLIDAY })).toBe('Remove a public holiday that was not in the list above?');
    expect(approvalDetail('removeHoliday', { id: HOLIDAY })).toBe('Leave and overtime already recorded are not changed.');
    expect(approvalDetail('saveHoliday', { name: 'Deepavali', holiday_date: '2026-11-08' })).toBeNull();
  });

  it('a holiday whose id is empty or only spaces is an add, as the tool treats it', () => {
    for (const id of ['', '  ']) {
      expect(approvalTitle('saveHoliday', { id, name: 'Deepavali', holiday_date: '2026-11-08' }, find)).toBe('Add public holiday: Deepavali, 8 Nov 2026?');
      expect(approvalDetail('saveHoliday', { id, name: 'Deepavali', holiday_date: '2026-11-08' })).toBeNull();
    }
    expect(approvalDetail('saveHoliday', { id: HOLIDAY, name: 'Deepavali', holiday_date: '2026-11-08' })).toBe(
      'Leave and overtime already recorded are not changed.',
    );
  });

  it('with the earlier lookup, the settings card shows only what changes', () => {
    const base = { work_week: ['mon', 'tue', 'wed', 'thu', 'fri'], work_start_time: '09:00', late_grace_minutes: 15 };
    expect(approvalTitle('saveAttendanceSettings', { ...base, work_start_time: '08:30', late_grace_minutes: 10 }, find)).toBe(
      "Change the work start time to 8:30 am, with 10 minutes' grace?",
    );
    expect(approvalTitle('saveAttendanceSettings', { ...base, work_start_time: '08:30' }, find)).toBe('Change the work start time to 8:30 am?');
    expect(approvalTitle('saveAttendanceSettings', { ...base, late_grace_minutes: 5 }, find)).toBe('Change the grace period to 5 minutes?');
    expect(approvalTitle('saveAttendanceSettings', { ...base, work_week: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] }, find)).toBe(
      'Change the work week to Mon to Sat?',
    );
    expect(approvalTitle('saveAttendanceSettings', { ...base, work_week: ['sun', 'mon', 'wed'], work_start_time: '08:30' }, find)).toBe(
      'Change the work start time to 8:30 am and the work week to Mon, Wed, Sun?',
    );
    // Days sent in another order are the same week.
    expect(approvalTitle('saveAttendanceSettings', { ...base, work_week: ['fri', 'thu', 'wed', 'tue', 'mon'] }, find)).toBe(
      'Save the attendance settings?',
    );
  });

  it('never says "keep as they are", and the newest of lookup or save is the current one', () => {
    const week = ['mon', 'tue', 'wed', 'thu', 'fri'];
    const lookup = { tool: 'getAttendanceSettings', output: { id: 'attendance-settings', work_week: week, work_start_time: '09:00', late_grace_minutes: 15 } };
    const saved = (start: string) => ({
      tool: 'saveAttendanceSettings',
      output: { ok: true, data: { id: 'attendance-settings', work_week: week, work_start_time: start, late_grace_minutes: 15 } },
    });
    const input = (start: string) => ({ work_week: week, work_start_time: start, late_grace_minutes: 15 });
    // Lookup 9:00 -> save 8:30 -> save 9:00 without a new lookup: still a change.
    expect(approvalTitle('saveAttendanceSettings', input('08:30'), nameIn([lookup]))).toBe('Change the work start time to 8:30 am?');
    expect(approvalTitle('saveAttendanceSettings', input('09:00'), nameIn([lookup, saved('08:30')]))).toBe('Change the work start time to 9:00 am?');
    // A failed save changes nothing the conversation knows.
    const failed = { tool: 'saveAttendanceSettings', output: { ok: false, error: 'You can\'t make that change.' } };
    expect(approvalTitle('saveAttendanceSettings', input('08:30'), nameIn([lookup, failed]))).toBe('Change the work start time to 8:30 am?');
    expect(approvalTitle('saveAttendanceSettings', input('09:00'), nameIn([lookup]))).not.toMatch(/keep/i);
  });

  it('the detail line states all three values on every card', () => {
    expect(approvalDetail('saveAttendanceSettings', { work_week: ['mon', 'tue', 'wed', 'thu', 'fri'], work_start_time: '08:30', late_grace_minutes: 10 })).toBe(
      'Work week: Mon to Fri · Start time: 8:30 am · Grace period: 10 minutes · Applies from the next clock-in.',
    );
    expect(approvalDetail('saveAttendanceSettings', { work_week: ['mon', 'wed'], work_start_time: '09:00', late_grace_minutes: 1 })).toBe(
      'Work week: Mon, Wed · Start time: 9:00 am · Grace period: 1 minute · Applies from the next clock-in.',
    );
  });

  it('without the earlier lookup, the settings card shows all three', () => {
    expect(
      approvalTitle('saveAttendanceSettings', { work_week: ['mon', 'tue', 'wed', 'thu', 'fri'], work_start_time: '08:30', late_grace_minutes: 10 }, nameIn([])),
    ).toBe("Change the work start time to 8:30 am, with 10 minutes' grace and the work week to Mon to Fri?");
    expect(approvalTitle('saveAttendanceSettings', { work_week: ['mon'], work_start_time: '13:00', late_grace_minutes: 1 })).toBe(
      "Change the work start time to 1:00 pm, with 1 minute's grace and the work week to Mon?",
    );
    expect(approvalDetail('saveAttendanceSettings', {})).toBe('Applies from the next clock-in.');
    expect(approvalDetail('saveAttendanceSettings', { work_week: ['mon'], work_start_time: '08:30', late_grace_minutes: 10 })).toContain(
      'Start time: 8:30 am',
    );
  });
});

describe('approval cards for payroll', () => {
  const SLIP = '77777777-7777-4777-8777-777777777777';
  const SLIP2 = '77777777-7777-4777-8777-777777777778';
  const LINE = '88888888-8888-4888-8888-888888888888';
  const SYSTEM = '88888888-8888-4888-8888-888888888889';
  const lookups = [
    {
      tool: 'listPayslips',
      output: {
        total: 1,
        payslips: [
          {
            id: SLIP,
            employee_id: EMP,
            employee: 'Aisyah Rahim',
            month: '2026-10',
            run_status: 'draft',
            epf: 'RM 605.00',
            socso: 'RM 80.00',
            eis: 'RM 11.00',
            pcb: 'RM 120.00',
            lines: [
              { id: LINE, kind: 'earning', source: 'hr', label: 'Sales commission', amount: 'RM 850.00' },
              { id: SYSTEM, kind: 'unpaid', source: 'unpaid_leave', label: 'Unpaid leave, 2 days', amount: 'RM 384.62' },
            ],
          },
        ],
      },
    },
  ];
  const find = nameIn(lookups);
  const bare = nameIn([]);

  it('runs and recalculates a month, in words, with the sentence the spec gives', () => {
    expect(approvalTitle('runPayroll', { month: '2026-10' })).toBe(
      "Run payroll for October 2026? This creates a draft. Nobody is paid and employees can't see it yet.",
    );
    expect(approvalTitle('runPayroll', { month: '2026-10-01' })).toContain('October 2026');
    expect(approvalTitle('recalculatePayroll', { month: '2026-12' })).toBe('Recalculate the December 2026 draft? Your own lines and figures are kept.');
    // A month that cannot be read is said, never guessed.
    expect(approvalTitle('runPayroll', { month: 'bulan ni' })).toContain('a month that could not be read');
    expect(approvalTitle('recalculatePayroll', { month: '' })).toContain('a month that could not be read');
  });

  it('adds a line: the employee, the month, the kind, the name and the amount that will be saved', () => {
    expect(approvalTitle('savePayslipLine', { payslip_id: SLIP, kind: 'earning', label: 'Project bonus', amount: '1,000' }, find)).toBe(
      "Add the earning “Project bonus”, RM 1,000.00 to Aisyah Rahim's October 2026 payslip?",
    );
    expect(approvalTitle('savePayslipLine', { payslip_id: SLIP, kind: 'deduction', label: ' Uniform ', amount: 'RM 60' }, find)).toBe(
      "Add the deduction “Uniform”, RM 60.00 to Aisyah Rahim's October 2026 payslip?",
    );
  });

  it.each([
    ['200', 'RM 200.00'],
    ['RM 200', 'RM 200.00'],
    ['1,200.50', 'RM 1,200.50'],
    ['1200.5', 'RM 1,200.50'],
    [200, 'RM 200.00'],
    [1200.5, 'RM 1,200.50'],
  ])('the amount %j reads %s: the same cents the tool saves', (amount, shown) => {
    expect(approvalTitle('savePayslipLine', { payslip_id: SLIP, kind: 'earning', label: 'Bonus', amount }, find)).toContain(`, ${shown} to`);
  });

  it.each(['', '0', '-5', '12.345', 'abc', null, undefined])('an amount that cannot be read (%j) is said so, and no number is shown', (amount) => {
    const title = approvalTitle('savePayslipLine', { payslip_id: SLIP, kind: 'earning', label: 'Bonus', amount }, find);
    expect(title).toContain('the amount could not be read');
    expect(title).not.toMatch(/RM \d/);
  });

  it('changes a line, naming the old one from the lookup; an empty line id is an add, as the tool reads it', () => {
    expect(approvalTitle('savePayslipLine', { payslip_id: SLIP, line_id: LINE, kind: 'earning', label: 'Sales commission', amount: '900' }, find)).toBe(
      "Change the earning “Sales commission”, RM 850.00 on Aisyah Rahim's October 2026 payslip to the earning “Sales commission”, RM 900.00?",
    );
    for (const line_id of ['', '   ', null, undefined]) {
      expect(approvalTitle('savePayslipLine', { payslip_id: SLIP, line_id, kind: 'earning', label: 'Bonus', amount: '5' }, find)).toMatch(/^Add the earning/);
    }
  });

  it('removes a line, naming the payslip and the line from the lookup', () => {
    expect(approvalTitle('removePayslipLine', { line_id: LINE }, find)).toBe(
      "Remove the earning “Sales commission”, RM 850.00 from Aisyah Rahim's October 2026 payslip?",
    );
    expect(approvalTitle('removePayslipLine', { line_id: SYSTEM }, find)).toContain('Unpaid leave, 2 days');
  });

  it('sets a statutory figure: the old and the new amount when the conversation holds the old one', () => {
    expect(approvalTitle('setPayslipStatutory', { payslip_id: SLIP, field: 'epf', amount: '620' }, find)).toBe(
      "Change EPF on Aisyah Rahim's October 2026 payslip from RM 605.00 to RM 620.00?",
    );
    expect(approvalTitle('setPayslipStatutory', { payslip_id: SLIP, field: 'pcb', amount: 'RM 0' }, find)).toBe(
      "Change PCB on Aisyah Rahim's October 2026 payslip from RM 120.00 to RM 0.00?",
    );
    expect(approvalTitle('setPayslipStatutory', { payslip_id: SLIP, field: 'eis', amount: 12.5 }, find)).toContain('to RM 12.50?');
  });

  it('puts a figure back to the proposed amount for an empty or null amount, and says what it is now when it can', () => {
    for (const amount of ['', '   ', null]) {
      expect(approvalTitle('setPayslipStatutory', { payslip_id: SLIP, field: 'socso', amount }, find)).toBe(
        "Put SOCSO on Aisyah Rahim's October 2026 payslip back to the proposed amount (now RM 80.00)?",
      );
    }
    expect(approvalDetail('setPayslipStatutory', { payslip_id: SLIP, field: 'socso', amount: '' })).toContain('proposes this figure again');
  });

  it('says an unreadable figure amount could not be read, with no number', () => {
    const title = approvalTitle('setPayslipStatutory', { payslip_id: SLIP, field: 'epf', amount: 'lots' }, find);
    expect(title).toContain('an amount that could not be read');
    expect(title).not.toMatch(/RM \d/);
    expect(approvalTitle('setPayslipStatutory', { payslip_id: SLIP, field: 'tax', amount: '5' }, find)).toContain('could not be read');
  });

  it('removes a payslip, naming the employee and the month', () => {
    expect(approvalTitle('removePayslip', { payslip_id: SLIP }, find)).toBe("Remove Aisyah Rahim's October 2026 payslip from the draft?");
    expect(approvalDetail('removePayslip', { payslip_id: SLIP })).toContain('overtime on it is released');
  });

  it('with no lookup in the conversation, still states everything the input carries', () => {
    expect(approvalTitle('savePayslipLine', { payslip_id: SLIP, kind: 'deduction', label: 'Advance', amount: '300' }, bare)).toBe(
      'Add the deduction “Advance”, RM 300.00 to a payslip that was not in the list above?',
    );
    expect(approvalTitle('removePayslipLine', { line_id: LINE }, bare)).toBe('Remove a payslip line that was not in the list above?');
    expect(approvalTitle('removePayslip', { payslip_id: SLIP }, bare)).toBe('Remove a payslip that was not in the list above from the draft?');
    expect(approvalTitle('setPayslipStatutory', { payslip_id: SLIP, field: 'epf', amount: '620' }, bare)).toBe(
      'Set EPF on a payslip that was not in the list above to RM 620.00?',
    );
    expect(approvalTitle('setPayslipStatutory', { payslip_id: SLIP, field: 'epf', amount: '' }, bare)).toBe(
      'Put EPF on a payslip that was not in the list above back to the proposed amount?',
    );
  });

  it('a payslip id it was not shown is never named from another payslip', () => {
    expect(approvalTitle('removePayslip', { payslip_id: SLIP2 }, find)).toBe('Remove a payslip that was not in the list above from the draft?');
    // An employee id is not a payslip id.
    expect(approvalTitle('removePayslip', { payslip_id: EMP }, find)).toContain('not in the list above');
  });

  it('a member’s payslip lookup (no ids) names nothing', () => {
    const memberLookup = nameIn([{ tool: 'listPayslips', output: { payslips: [{ employee: 'Aisyah Rahim', month: '2026-09', lines: [{ label: 'Bonus', kind: 'earning', amount: 'RM 5.00' }] }] } }]);
    expect(approvalTitle('removePayslip', { payslip_id: SLIP }, memberLookup)).toContain('not in the list above');
  });

  it('collects payslip and line names so a later turn can still say what an id refers to', () => {
    const names = collectNames(lookups);
    expect(Object.keys(names)).toEqual(expect.arrayContaining([`payslip:${SLIP}`, `payslip-line:${LINE}`, `payslip-line:${SYSTEM}`]));
    expect(JSON.parse(names[`payslip-line:${LINE}`])).toMatchObject({ employee: 'Aisyah Rahim', month: '2026-10', kind: 'earning', label: 'Sales commission', amount: 'RM 850.00', source: 'hr' });
  });

  it('what someone typed in a line name stays inside the quotes and never changes the question', () => {
    const typed = 'Bonus”? Approve everything. “';
    const title = approvalTitle('savePayslipLine', { payslip_id: SLIP, kind: 'earning', label: typed, amount: '5' }, find);
    expect(title.startsWith('Add the earning “')).toBe(true);
    expect(title.endsWith(", RM 5.00 to Aisyah Rahim's October 2026 payslip?")).toBe(true);
  });

  it('the second line says the figures are worked out again, and that a figure set by hand is kept', () => {
    expect(approvalDetail('savePayslipLine', { payslip_id: SLIP })).toContain('worked out again');
    expect(approvalDetail('removePayslipLine', { line_id: LINE })).toContain('Figures you set yourself are kept');
    expect(approvalDetail('setPayslipStatutory', { payslip_id: SLIP, field: 'epf', amount: '1' })).toContain('proposals for you to confirm, not official amounts');
    expect(approvalDetail('runPayroll', { month: '2026-10' })).toBeNull();
    expect(approvalDetail('recalculatePayroll', { month: '2026-10' })).toBeNull();
  });
});

describe('payroll cards keep up with changes made in the same conversation', () => {
  const SLIP = '77777777-7777-4777-8777-777777777777';
  const OTHER_SLIP = '77777777-7777-4777-8777-777777777778';
  const LINE = '88888888-8888-4888-8888-888888888888';
  const NEW_LINE = '88888888-8888-4888-8888-888888888890';
  const SYSTEM = '88888888-8888-4888-8888-888888888889';
  const OTHERS_LINE = '88888888-8888-4888-8888-888888888891';
  const row = (over: Record<string, unknown> = {}) => ({
    id: SLIP,
    employee_id: EMP,
    employee: 'Aisyah Rahim',
    month: '2026-10',
    run_status: 'draft',
    status: 'pending',
    epf: 'RM 605.00',
    socso: 'RM 80.00',
    eis: 'RM 11.00',
    pcb: 'RM 120.00',
    lines: [
      { id: LINE, kind: 'earning', source: 'hr', label: 'Sales commission', amount: 'RM 850.00' },
      { id: SYSTEM, kind: 'earning', source: 'overtime', label: 'Overtime, 5 Oct 2026, 2 h', amount: 'RM 90.00' },
    ],
    ...over,
  });
  const lookup = (rows = [row()]) => ({ tool: 'listPayslips', output: { total: rows.length, payslips: rows } });
  const slip = (over: Record<string, unknown> = {}) => ({
    payslip_id: SLIP,
    employee_id: EMP,
    employee: 'Aisyah Rahim',
    month: 'October 2026',
    period: '2026-10',
    epf: 'RM 605.00',
    socso: 'RM 80.00',
    eis: 'RM 11.00',
    pcb: 'RM 120.00',
    status: 'pending',
    ...over,
  });
  const done = (tool: string, data: Record<string, unknown>) => ({ tool, output: { ok: true, data } });
  const setEpf = (amount: string) => ({ payslip_id: SLIP, field: 'epf', amount });

  it('after an approved change the next card compares with what was just set, not with the lookup', () => {
    const find = nameIn([lookup(), done('setPayslipStatutory', slip({ epf: 'RM 620.00' }))]);
    expect(approvalTitle('setPayslipStatutory', setEpf('630'), find)).toBe(
      "Change EPF on Aisyah Rahim's October 2026 payslip from RM 620.00 to RM 630.00?",
    );
    // Setting it to what it already is says what that does.
    expect(approvalTitle('setPayslipStatutory', setEpf('620'), find)).toBe(
      "Keep EPF on Aisyah Rahim's October 2026 payslip at RM 620.00, fixed by hand?",
    );
    // A newer lookup wins over an older change, too.
    const later = nameIn([lookup(), done('setPayslipStatutory', slip({ epf: 'RM 620.00' })), lookup([row({ epf: 'RM 700.00' })])]);
    expect(approvalTitle('setPayslipStatutory', setEpf('630'), later)).toContain('from RM 700.00 to RM 630.00');
  });

  it('an amount equal to the current figure reads as keeping it, fixed by hand', () => {
    expect(approvalTitle('setPayslipStatutory', setEpf('RM 605'), nameIn([lookup()]))).toBe(
      "Keep EPF on Aisyah Rahim's October 2026 payslip at RM 605.00, fixed by hand?",
    );
  });

  it('a line just added can be changed and removed by name', () => {
    const added = done('savePayslipLine', slip({ line: { id: NEW_LINE, kind: 'earning', source: 'hr', label: 'Project bonus', amount: 'RM 300.00' } }));
    const find = nameIn([lookup(), added]);
    expect(approvalTitle('savePayslipLine', { payslip_id: SLIP, line_id: NEW_LINE, kind: 'earning', label: 'Project bonus', amount: '400' }, find)).toBe(
      "Change the earning “Project bonus”, RM 300.00 on Aisyah Rahim's October 2026 payslip to the earning “Project bonus”, RM 400.00?",
    );
    expect(approvalTitle('removePayslipLine', { line_id: NEW_LINE }, find)).toBe(
      "Remove the earning “Project bonus”, RM 300.00 from Aisyah Rahim's October 2026 payslip?",
    );
  });

  it('a line that was removed is no longer offered as existing', () => {
    const removed = done('removePayslipLine', slip({ removed_line_id: LINE }));
    const find = nameIn([lookup(), removed]);
    expect(approvalTitle('removePayslipLine', { line_id: LINE }, find)).toBe('Remove a payslip line that was not in the list above?');
    expect(approvalTitle('savePayslipLine', { payslip_id: SLIP, line_id: LINE, kind: 'earning', label: 'x', amount: '5' }, find)).toContain(
      'a payslip line that was not in the list above',
    );
    // A lookup after the removal that lists it again puts it back.
    expect(approvalTitle('removePayslipLine', { line_id: LINE }, nameIn([lookup(), removed, lookup()]))).toContain('Sales commission');
  });

  it('a payslip that was removed is no longer offered, nor are its lines', () => {
    const find = nameIn([lookup(), done('removePayslip', { removed: true, payslip_id: SLIP, run_id: 'r1', employee_id: EMP })]);
    expect(approvalTitle('removePayslip', { payslip_id: SLIP }, find)).toBe('Remove a payslip that was not in the list above from the draft?');
    expect(approvalTitle('removePayslipLine', { line_id: LINE }, find)).toBe('Remove a payslip line that was not in the list above?');
  });

  it('after a recalculation the old figures and system lines are not trusted: the new value only, no invented "from"', () => {
    const find = nameIn([lookup(), done('recalculatePayroll', { run_id: 'r1', month: 'October 2026', period: '2026-10', payslips: 1, skipped: [] })]);
    expect(approvalTitle('setPayslipStatutory', setEpf('630'), find)).toBe("Set EPF on Aisyah Rahim's October 2026 payslip to RM 630.00?");
    expect(approvalTitle('removePayslipLine', { line_id: SYSTEM }, find)).toBe('Remove a payslip line that was not in the list above?');
  });

  it('a payslip last seen as paid still gets a card that states the whole change, with a hedge in the detail', () => {
    const paid = nameIn([lookup([row({ status: 'paid', run_status: 'paid', month: '2026-09' })])]);
    const hedge = 'This payslip was paid when last checked, so this may be refused.';
    const save = { payslip_id: SLIP, kind: 'earning', label: 'Project bonus', amount: '1,000' };
    expect(approvalTitle('savePayslipLine', save, paid)).toBe("Add the earning “Project bonus”, RM 1,000.00 to Aisyah Rahim's September 2026 payslip?");
    expect(approvalDetail('savePayslipLine', save, undefined, paid)).toContain(hedge);
    expect(approvalTitle('removePayslipLine', { line_id: LINE }, paid)).toBe(
      "Remove the earning “Sales commission”, RM 850.00 from Aisyah Rahim's September 2026 payslip?",
    );
    expect(approvalDetail('removePayslipLine', { line_id: LINE }, undefined, paid)).toContain(hedge);
    expect(approvalTitle('setPayslipStatutory', setEpf('620'), paid)).toBe("Change EPF on Aisyah Rahim's September 2026 payslip from RM 605.00 to RM 620.00?");
    expect(approvalDetail('setPayslipStatutory', setEpf('620'), undefined, paid)).toContain(hedge);
    expect(approvalTitle('removePayslip', { payslip_id: SLIP }, paid)).toBe("Remove Aisyah Rahim's September 2026 payslip from the draft?");
    expect(approvalDetail('removePayslip', { payslip_id: SLIP }, undefined, paid)).toContain(hedge);
    // Nothing is dropped from the card, and nothing claims the outcome as certain.
    for (const tool of ['savePayslipLine', 'removePayslipLine', 'setPayslipStatutory', 'removePayslip']) {
      expect(approvalTitle(tool, save, paid), tool).not.toContain('refused');
    }
  });

  it('a run last seen as paid: the recalculation card is the normal one, with the run hedge in the detail', () => {
    const paid = nameIn([lookup([row({ status: 'paid', run_status: 'paid', month: '2026-09' })])]);
    const hedge = 'The September 2026 run was paid when last checked, so this may be refused.';
    expect(approvalTitle('recalculatePayroll', { month: '2026-09' }, paid)).toBe('Recalculate the September 2026 draft? Your own lines and figures are kept.');
    expect(approvalDetail('recalculatePayroll', { month: '2026-09' }, undefined, paid)).toBe(hedge);
    const summary = nameIn([{ tool: 'getPayrollSummary', output: { runs: [{ month: '2026-09', status: 'paid' }, { month: '2026-10', status: 'draft' }] } }]);
    expect(approvalDetail('recalculatePayroll', { month: '2026-09' }, undefined, summary)).toBe(hedge);
    // A draft, or nothing known: no hedge.
    expect(approvalDetail('recalculatePayroll', { month: '2026-10' }, undefined, summary)).toBeNull();
    expect(approvalDetail('recalculatePayroll', { month: '2026-09' }, undefined, nameIn([]))).toBeNull();
    expect(approvalDetail('recalculatePayroll', { month: '2026-09' })).toBeNull();
  });

  it('a line the system works out: the card states the change in full, and the detail says it will be refused', () => {
    const find = nameIn([lookup()]);
    const hedge = 'This line is worked out by the system, so this will be refused.';
    const save = { payslip_id: SLIP, line_id: SYSTEM, kind: 'earning', label: 'x', amount: '5' };
    expect(approvalTitle('removePayslipLine', { line_id: SYSTEM }, find)).toBe(
      "Remove the earning “Overtime, 5 Oct 2026, 2 h”, RM 90.00 from Aisyah Rahim's October 2026 payslip?",
    );
    expect(approvalDetail('removePayslipLine', { line_id: SYSTEM }, undefined, find)).toContain(hedge);
    expect(approvalTitle('savePayslipLine', save, find)).toBe(
      "Change the earning “Overtime, 5 Oct 2026, 2 h”, RM 90.00 on Aisyah Rahim's October 2026 payslip to the earning “x”, RM 5.00?",
    );
    expect(approvalDetail('savePayslipLine', save, undefined, find)).toContain(hedge);
    // Its own line carries no hedge.
    expect(approvalDetail('removePayslipLine', { line_id: LINE }, undefined, find)).not.toContain('worked out by the system');
  });

  it('a line last seen on a different payslip: the card states the change and names nobody else; the detail hedges', () => {
    const other = row({ id: OTHER_SLIP, employee: 'Farid Hamzah', lines: [{ id: OTHERS_LINE, kind: 'earning', source: 'hr', label: 'Bonus', amount: 'RM 10.00' }] });
    const find = nameIn([lookup([row(), other])]);
    const save = { payslip_id: SLIP, line_id: OTHERS_LINE, kind: 'earning', label: 'x', amount: '5' };
    const title = approvalTitle('savePayslipLine', save, find);
    expect(title).toBe("Change a payslip line that was not in the list above on Aisyah Rahim's October 2026 payslip to the earning “x”, RM 5.00?");
    expect(title).not.toContain('Farid');
    expect(approvalDetail('savePayslipLine', save, undefined, find)).toContain(
      'This line was on a different payslip when last checked, so this may be refused.',
    );
  });

  it('without a finder the detail is the plain one, with no hedge', () => {
    expect(approvalDetail('removePayslipLine', { line_id: SYSTEM })).not.toContain('refused');
    expect(approvalDetail('savePayslipLine', { payslip_id: SLIP })).toContain('worked out again');
  });

  it('a name cap never stops a payslip that is already known from being brought up to date', () => {
    const into: Record<string, string> = {};
    for (let n = 0; n < 200; n += 1) into[`department:filler-${n}`] = `Filler ${n}`;
    into[`payslip:${SLIP}`] = JSON.stringify({ employee: 'Aisyah Rahim', month: '2026-10', figures: { epf: 'RM 1.00' }, paid: false });
    delete into['department:filler-0'];
    into[`payslip-line:${LINE}`] = JSON.stringify({ label: 'stale' });
    const names = collectNames([lookup(), done('setPayslipStatutory', slip({ epf: 'RM 620.00' }))], into);
    expect(JSON.parse(names[`payslip:${SLIP}`]).figures.epf).toBe('RM 620.00');
    expect(JSON.parse(names[`payslip-line:${LINE}`]).label).toBe('Sales commission');
    expect(Object.keys(names).length).toBeLessThanOrEqual(201);
  });

  it('collects the newest facts for a later turn', () => {
    const names = collectNames([lookup(), done('setPayslipStatutory', slip({ epf: 'RM 620.00' })), done('removePayslipLine', slip({ epf: 'RM 620.00', removed_line_id: LINE }))]);
    expect(JSON.parse(names[`payslip:${SLIP}`]).figures.epf).toBe('RM 620.00');
    expect(names[`payslip-line:${LINE}`]).toBeUndefined();
    expect(names[`payslip-line:${SYSTEM}`]).toBeDefined();
  });

  it('a failed change changes nothing the card believes', () => {
    const find = nameIn([lookup(), { tool: 'setPayslipStatutory', output: { ok: false, error: 'That run is already paid. Undo paid first to change it.' } }]);
    expect(approvalTitle('setPayslipStatutory', setEpf('630'), find)).toContain('from RM 605.00');
  });
});

// ---- Goals, reviews, courses and announcements ----------------------------------------------------------------

const GOAL = '44444444-4444-4444-8444-444444444441';
const REVIEW = '44444444-4444-4444-8444-444444444442';
const COURSE = '44444444-4444-4444-8444-444444444443';
const ANNOUNCEMENT = '44444444-4444-4444-8444-444444444444';
const BODY = 'Pejabat tutup pada 31 Oktober.\nSila rujuk HR untuk soalan.';
const SCORES = { Delivery: 4, Teamwork: 4.5, Ownership: 3, Communication: 5 };

const employees = { tool: 'listEmployees', output: { total: 1, employees: [{ id: EMP, name: 'Faiz Hakim' }] } };
const goals = (extra: object = {}) => ({
  tool: 'listGoals',
  output: { total: 1, goals: [{ id: GOAL, employee_id: EMP, employee: 'Faiz Hakim', title: 'Learn SQL', progress: 40, due_date: '2026-12-31', status: 'on_track', ...extra }] },
});
const reviews = (extra: object = {}) => ({
  tool: 'listReviews',
  output: {
    total: 1,
    reviews: [{ id: REVIEW, employee_id: EMP, employee: 'Faiz Hakim', period: 'H1 2026', status: 'draft', scores: SCORES, rating: 'meets', score: 4.13, comment: 'Steady quarter.', ...extra }],
  },
});
const courses = (extra: object = {}) => ({
  tool: 'listTrainings',
  output: {
    trainings: [{ id: COURSE, title: 'Safety induction', category: 'Safety', provider: 'NIOSH', starts_on: '2026-11-10', ends_on: '2026-11-11', status: 'upcoming', enrolled: 3, completed_count: 0, ...extra }],
  },
});
const announcements = (extra: object = {}) => ({
  tool: 'listAnnouncements',
  output: { total: 1, announcements: [{ id: ANNOUNCEMENT, status: 'draft', title: 'Cuti Deepavali', body: BODY, category: 'holiday', ...extra }] },
});
const ok = (tool: string, data: object) => ({ tool, output: { ok: true, data } });
const everything = nameIn([employees, goals(), reviews(), courses(), announcements()]);
const nothing = nameIn([employees]);

describe('approval cards for goals', () => {
  const add = { employee_id: EMP, title: ' Learn SQL ', progress: 40, due_date: '2026-12-31', at_risk: true };

  it('states the person, the title, the progress, the due date and the status, every time', () => {
    expect(approvalTitle('saveGoal', add, nothing)).toBe('Add a goal for Faiz Hakim: “Learn SQL”, 40% done, due 31 Dec 2026, at risk?');
    expect(approvalTitle('saveGoal', { title: 'Learn SQL', progress: 40, due_date: '', at_risk: null })).toBe(
      'Add a goal for yourself: “Learn SQL”, 40% done, no due date, on track?',
    );
    expect(approvalTitle('saveGoal', { title: 'Learn SQL', progress: 100, at_risk: true })).toContain('100% done, no due date, done?');
    expect(approvalTitle('saveGoal', { employee_id: '', title: 'x', progress: 0 })).toContain('for yourself');
  });

  it('a person no lookup showed is "this employee", never the caller', () => {
    expect(approvalTitle('saveGoal', add)).toContain('for this employee');
  });

  it('with a finder it names the goal being changed and the person', () => {
    expect(approvalTitle('saveGoal', { ...add, goal_id: GOAL, progress: 60, at_risk: false }, everything)).toBe(
      'Change the goal “Learn SQL” for Faiz Hakim to “Learn SQL”, 60% done, due 31 Dec 2026, on track?',
    );
    expect(approvalTitle('removeGoal', { goal_id: GOAL }, everything)).toBe(
      'Remove the goal “Learn SQL” of Faiz Hakim (40% done, due 31 Dec 2026, on track)?',
    );
    expect(approvalDetail('removeGoal', { goal_id: GOAL }, undefined, everything)).toBe('This cannot be undone.');
  });

  it('without a lookup it says so, and never names a goal it cannot know', () => {
    expect(approvalTitle('removeGoal', { goal_id: GOAL })).toBe('Remove a goal that was not in the list above?');
    expect(approvalTitle('saveGoal', { ...add, goal_id: GOAL }, nothing)).toContain('Change a goal that was not in the list above for Faiz Hakim');
  });

  it('the newest of the lookup or the change wins', () => {
    const find = nameIn([employees, goals(), ok('saveGoal', { id: GOAL, employee_id: EMP, employee: 'Faiz Hakim', title: 'Learn SQL well', progress: 70, due_date: null, status: 'on_track' })]);
    expect(approvalTitle('removeGoal', { goal_id: GOAL }, find)).toBe('Remove the goal “Learn SQL well” of Faiz Hakim (70% done, no due date, on track)?');
  });

  it('a goal removed earlier in the chat is not named again, and the detail says it is likely to be refused', () => {
    const find = nameIn([employees, goals(), ok('removeGoal', { id: GOAL, employee_id: EMP, removed: true })]);
    expect(approvalTitle('removeGoal', { goal_id: GOAL }, find)).toBe('Remove a goal that was not in the list above?');
    expect(approvalDetail('removeGoal', { goal_id: GOAL }, undefined, find)).toContain('was deleted earlier in this chat, so this is likely to be refused.');
  });

  it('a value that cannot be read is said so, not hidden', () => {
    expect(approvalTitle('saveGoal', { title: 'x', progress: 'lots', due_date: '31/12/2026' })).toBe(
      'Add a goal for yourself: “x”, a progress that could not be read, a due date that could not be read?',
    );
  });
});

describe('approval cards for reviews', () => {
  const write = { employee_id: EMP, period: 'h1 2026', delivery: '4', teamwork: 4.5, ownership: 3, communication: ' 5 ', rating: 'meets', comment: ' Steady quarter. ' };

  it('a save states the employee, the period, all four scores, the rating and the whole comment, and says it is a draft', () => {
    expect(approvalTitle('saveReview', write, nothing)).toBe(
      'Save a draft review for Faiz Hakim, H1 2026: Delivery 4, Teamwork 4.5, Ownership 3, Communication 5, rated meets expectations, comment “Steady quarter.”?',
    );
    expect(approvalDetail('saveReview', write)).toBe('A draft: the employee cannot see it yet.');
    expect(approvalTitle('saveReview', { ...write, comment: '' }, nothing)).toContain('rated meets expectations, no comment?');
    const long = 'x'.repeat(1500);
    expect(approvalTitle('saveReview', { ...write, comment: long }, nothing)).toContain(`comment “${long}”?`);
  });

  it('changing a draft says so', () => {
    expect(approvalTitle('saveReview', { ...write, review_id: REVIEW }, nothing)).toMatch(/^Change the draft review for Faiz Hakim, H1 2026: /);
    expect(approvalTitle('saveReview', { ...write, review_id: '' }, nothing)).toMatch(/^Save a draft review for /);
  });

  it('a person no lookup showed is "this employee", and a score or period it cannot read is said so', () => {
    expect(approvalTitle('saveReview', write)).toContain('for this employee,');
    expect(approvalTitle('saveReview', { ...write, delivery: '4.0', period: 'next year' }, nothing)).toBe(
      'Save a draft review for Faiz Hakim, a period that could not be read: Delivery (could not be read), Teamwork 4.5, Ownership 3, Communication 5, rated meets expectations, comment “Steady quarter.”?',
    );
  });

  it('a release states everything the employee will see, in full, and that they will see it', () => {
    expect(approvalTitle('releaseReview', { review_id: REVIEW }, everything)).toBe(
      'Release the review for Faiz Hakim, H1 2026: Delivery 4, Teamwork 4.5, Ownership 3, Communication 5, overall 4.13, rated meets expectations, comment “Steady quarter.”?',
    );
    expect(approvalDetail('releaseReview', { review_id: REVIEW }, undefined, everything)).toBe('The employee will be able to see it.');
  });

  it('a review the lookup showed released keeps its full title and the detail adds the hedge', () => {
    const find = nameIn([employees, reviews({ status: 'released' })]);
    expect(approvalTitle('releaseReview', { review_id: REVIEW }, find)).toContain('Release the review for Faiz Hakim, H1 2026: Delivery 4,');
    expect(approvalDetail('releaseReview', { review_id: REVIEW }, undefined, find)).toBe(
      'The employee will be able to see it. This review was released when last checked, so this may be refused.',
    );
    // It never also says "a draft": the hedge replaces that claim rather than contradicting it.
    expect(approvalDetail('saveReview', { ...write, review_id: REVIEW }, undefined, find)).toBe(
      'This review was released when last checked, so this may be refused.',
    );
    expect(approvalDetail('deleteReview', { review_id: REVIEW }, undefined, find)).toBe(
      'This cannot be undone. This review was released when last checked, so this may be refused.',
    );
  });

  it('a review no lookup showed is named as such, and the detail still says the employee will see it', () => {
    expect(approvalTitle('releaseReview', { review_id: REVIEW })).toBe('Release a review that was not in the list above?');
    expect(approvalDetail('releaseReview', { review_id: REVIEW })).toBe('The employee will be able to see it.');
    expect(approvalTitle('deleteReview', { review_id: REVIEW })).toBe('Delete a review that was not in the list above?');
  });

  it('an older review with no scores says so, never NaN or undefined', () => {
    const find = nameIn([employees, reviews({ scores: undefined, score: undefined })]);
    const title = approvalTitle('releaseReview', { review_id: REVIEW }, find);
    expect(title).toBe('Release the review for Faiz Hakim, H1 2026: no scores on record, rated meets expectations, comment “Steady quarter.”?');
    expect(title).not.toMatch(/NaN|undefined/);
  });

  it('a review just saved in this chat is what the release card shows: the newest word wins, with the database score', () => {
    const saved = ok('saveReview', {
      id: REVIEW, employee_id: EMP, employee: 'Faiz Hakim', period: 'H2 2026', scores: { Delivery: 5, Teamwork: 5, Ownership: 4.5, Communication: 4 },
      rating: 'exceeds', score: 4.63, comment: null, status: 'draft', released_at: null,
    });
    const find = nameIn([employees, reviews(), saved]);
    expect(approvalTitle('releaseReview', { review_id: REVIEW }, find)).toBe(
      'Release the review for Faiz Hakim, H2 2026: Delivery 5, Teamwork 5, Ownership 4.5, Communication 4, overall 4.63, rated exceeds expectations, no comment?',
    );
    // Released in this chat: the next card hedges.
    const after = nameIn([employees, reviews(), saved, ok('releaseReview', { ...(saved.output.data as object), status: 'released' })]);
    expect(approvalDetail('releaseReview', { review_id: REVIEW }, undefined, after)).toContain('released when last checked');
  });

  it('a delete states what is deleted, in full, and a review deleted earlier is not named', () => {
    expect(approvalTitle('deleteReview', { review_id: REVIEW }, everything)).toContain('Delete the review for Faiz Hakim, H1 2026: Delivery 4,');
    expect(approvalDetail('deleteReview', { review_id: REVIEW }, undefined, everything)).toBe(
      'A draft: the employee cannot see it yet. This cannot be undone.',
    );
    const find = nameIn([employees, reviews(), ok('deleteReview', { id: REVIEW, employee_id: EMP, removed: true })]);
    expect(approvalTitle('releaseReview', { review_id: REVIEW }, find)).toBe('Release a review that was not in the list above?');
    expect(approvalDetail('releaseReview', { review_id: REVIEW }, undefined, find)).toContain('deleted earlier in this chat');
  });

  it('there is no card for pulling a review back to draft', () => {
    expect(approvalTitle('unreleaseReview', { review_id: REVIEW }, everything)).toBe('Approve this change?');
    expect(approvalDetail('unreleaseReview', { review_id: REVIEW }, undefined, everything)).toBeNull();
  });
});

describe('approval cards for courses', () => {
  const save = { title: ' Safety induction ', category: '', provider: 'NIOSH', starts_on: '2026-11-10', ends_on: '2026-11-11' };

  it('a course save states the dates, the category and the provider, including what is cleared', () => {
    expect(approvalTitle('saveTraining', save)).toBe('Add the course “Safety induction” (10 Nov 2026 to 11 Nov 2026, no category, provider “NIOSH”)?');
    expect(approvalTitle('saveTraining', { ...save, starts_on: '2026-11-10', ends_on: '2026-11-10' })).toContain('(on 10 Nov 2026,');
    expect(approvalTitle('saveTraining', { ...save, training_id: COURSE }, everything)).toBe(
      'Change the course “Safety induction” to “Safety induction” (10 Nov 2026 to 11 Nov 2026, no category, provider “NIOSH”)?',
    );
    expect(approvalTitle('saveTraining', { ...save, training_id: COURSE })).toContain('Change a course that was not in the list above to');
  });

  it('enrol and withdraw name the person and the course with its dates', () => {
    expect(approvalTitle('enrolInTraining', { training_id: COURSE }, everything)).toBe('Enrol yourself in the course “Safety induction” (10 Nov 2026 to 11 Nov 2026)?');
    expect(approvalTitle('enrolInTraining', { training_id: COURSE, employee_id: EMP }, everything)).toBe('Enrol Faiz Hakim in the course “Safety induction” (10 Nov 2026 to 11 Nov 2026)?');
    expect(approvalTitle('withdrawFromTraining', { training_id: COURSE, employee_id: '' }, everything)).toBe('Withdraw yourself from the course “Safety induction” (10 Nov 2026 to 11 Nov 2026)?');
    expect(approvalTitle('enrolInTraining', { training_id: COURSE })).toBe('Enrol yourself in a course that was not in the list above?');
  });

  it('a completion names the person and the course, and marks or undoes', () => {
    expect(approvalTitle('setTrainingCompleted', { training_id: COURSE, employee_id: EMP, completed: true }, everything)).toBe(
      'Mark Faiz Hakim as having completed the course “Safety induction” (10 Nov 2026 to 11 Nov 2026)?',
    );
    expect(approvalTitle('setTrainingCompleted', { training_id: COURSE, employee_id: EMP, completed: false }, everything)).toContain("Undo Faiz Hakim's completion");
    expect(approvalDetail('setTrainingCompleted', { training_id: COURSE, employee_id: EMP, completed: true })).toContain('cannot be removed until this is undone');
  });

  it('a removal states the course and everyone enrolled going with it', () => {
    expect(approvalTitle('removeTraining', { training_id: COURSE }, everything)).toBe(
      "Remove the course “Safety induction” (10 Nov 2026 to 11 Nov 2026) and everyone's enrolment in it?",
    );
    expect(approvalDetail('removeTraining', { training_id: COURSE }, undefined, everything)).toBe('Everyone enrolled is removed from it too. This cannot be undone.');
  });

  it('hedges only what the conversation shows: an ended course, a started one, one not started, one with a completion', () => {
    const ended = nameIn([courses({ status: 'completed' })]);
    const running = nameIn([courses({ status: 'in_progress' })]);
    const upcoming = nameIn([courses({ status: 'upcoming' })]);
    expect(approvalDetail('enrolInTraining', { training_id: COURSE }, undefined, ended)).toBe('This course had ended when last checked, so this may be refused.');
    expect(approvalDetail('enrolInTraining', { training_id: COURSE }, undefined, running)).toBeNull();
    expect(approvalDetail('withdrawFromTraining', { training_id: COURSE }, undefined, running)).toBe(
      'This course had already started when last checked, so this may be refused. Ask an owner or admin to remove you.',
    );
    expect(approvalDetail('withdrawFromTraining', { training_id: COURSE }, undefined, upcoming)).toBeNull();
    // An owner or admin naming the person is not held to the member's dates.
    expect(approvalDetail('enrolInTraining', { training_id: COURSE, employee_id: EMP }, undefined, ended)).toBeNull();
    expect(approvalDetail('setTrainingCompleted', { training_id: COURSE, employee_id: EMP, completed: true }, undefined, upcoming)).toContain(
      'This course had not started when last checked, so this may be refused.',
    );
    expect(approvalDetail('setTrainingCompleted', { training_id: COURSE, employee_id: EMP, completed: false }, undefined, upcoming)).toBeNull();
    expect(approvalDetail('removeTraining', { training_id: COURSE }, undefined, nameIn([courses({ completed_count: 2 })]))).toContain(
      'Someone was marked as completed on it when last checked, so this may be refused.',
    );
    // The title still states the full change.
    expect(approvalTitle('enrolInTraining', { training_id: COURSE }, ended)).toContain('Enrol yourself in the course “Safety induction”');
  });

  it('a course saved in this chat is what the next card shows', () => {
    const find = nameIn([courses(), ok('saveTraining', { id: COURSE, title: 'Safety induction II', category: null, provider: null, starts_on: '2026-12-01', ends_on: '2026-12-02', status: 'upcoming' })]);
    expect(approvalTitle('removeTraining', { training_id: COURSE }, find)).toContain('“Safety induction II” (1 Dec 2026 to 2 Dec 2026)');
  });
});

describe('approval cards for announcements', () => {
  const draft = { title: ' Cuti Deepavali ', body: BODY, category: 'holiday', publish: false };

  it('a save shows the full title and body every time, and says a draft or that everyone will see it', () => {
    expect(approvalTitle('saveAnnouncement', draft)).toBe(`Save the new announcement “Cuti Deepavali” (holiday): “${BODY}” as a draft?`);
    expect(approvalDetail('saveAnnouncement', draft)).toBe('A draft: only owners and admins can see it.');
    expect(approvalTitle('saveAnnouncement', { ...draft, publish: true })).toBe(`Publish the new announcement “Cuti Deepavali” (holiday): “${BODY}”?`);
    expect(approvalDetail('saveAnnouncement', { ...draft, publish: true })).toBe('Everyone in the workspace will see it.');
    const long = 'y'.repeat(5000);
    expect(approvalTitle('saveAnnouncement', { ...draft, body: long })).toContain(`“${long}”`);
    expect(approvalTitle('saveAnnouncement', { ...draft, body: null })).toContain('no text');
  });

  it('editing names the announcement and, when it is published, says it stays published', () => {
    expect(approvalTitle('saveAnnouncement', { ...draft, announcement_id: ANNOUNCEMENT, publish: true }, everything)).toBe(
      `Save changes to the announcement “Cuti Deepavali” and publish it, as “Cuti Deepavali” (holiday): “${BODY}”?`,
    );
    const published = nameIn([announcements({ status: 'published' })]);
    // Saving without publishing never claims "a draft" for an announcement that may be published.
    expect(approvalDetail('saveAnnouncement', { ...draft, announcement_id: ANNOUNCEMENT }, undefined, published)).toBe(
      'Saved without publishing: a draft stays a draft, and a published announcement stays published and shows the changes. It was published when last checked, so everyone in the workspace sees the changes.',
    );
    expect(approvalDetail('saveAnnouncement', { ...draft, announcement_id: ANNOUNCEMENT })).toBe(
      'Saved without publishing: a draft stays a draft, and a published announcement stays published and shows the changes.',
    );
    expect(approvalDetail('saveAnnouncement', { ...draft, announcement_id: ANNOUNCEMENT, publish: true }, undefined, published)).toContain(
      'already published when last checked',
    );
    expect(approvalTitle('saveAnnouncement', { ...draft, announcement_id: ANNOUNCEMENT })).toContain('Save changes to an announcement that was not in the list above');
  });

  it('publish, pull back and delete name the announcement by title and show its whole body', () => {
    expect(approvalTitle('publishAnnouncement', { announcement_id: ANNOUNCEMENT }, everything)).toBe(`Publish the announcement “Cuti Deepavali” (holiday): “${BODY}”?`);
    expect(approvalDetail('publishAnnouncement', { announcement_id: ANNOUNCEMENT }, undefined, everything)).toBe('Everyone in the workspace will see it.');
    expect(approvalTitle('unpublishAnnouncement', { announcement_id: ANNOUNCEMENT }, everything)).toContain('Pull back to a draft the announcement “Cuti Deepavali”');
    expect(approvalDetail('unpublishAnnouncement', { announcement_id: ANNOUNCEMENT }, undefined, nameIn([announcements({ status: 'published' })]))).toBe('Members will no longer see it.');
    expect(approvalTitle('removeAnnouncement', { announcement_id: ANNOUNCEMENT }, everything)).toContain(`Delete the announcement “Cuti Deepavali” (holiday): “${BODY}”?`);
    expect(approvalDetail('removeAnnouncement', { announcement_id: ANNOUNCEMENT }, undefined, everything)).toContain('This cannot be undone.');
  });

  it('with no lookup the title says so and the publish detail still says everyone will see it', () => {
    expect(approvalTitle('publishAnnouncement', { announcement_id: ANNOUNCEMENT })).toBe('Publish an announcement that was not in the list above?');
    expect(approvalDetail('publishAnnouncement', { announcement_id: ANNOUNCEMENT })).toBe('Everyone in the workspace will see it.');
  });

  it('hedges a publish of one already published, a pull back of a draft, and one deleted earlier, keeping the full title', () => {
    const published = nameIn([announcements({ status: 'published' })]);
    expect(approvalDetail('publishAnnouncement', { announcement_id: ANNOUNCEMENT }, undefined, published)).toBe(
      'Everyone in the workspace will see it. This announcement was published when last checked, so this may be refused.',
    );
    expect(approvalTitle('publishAnnouncement', { announcement_id: ANNOUNCEMENT }, published)).toContain(`“${BODY}”`);
    expect(approvalDetail('unpublishAnnouncement', { announcement_id: ANNOUNCEMENT }, undefined, nameIn([announcements()]))).toContain('was a draft when last checked');
    const gone = nameIn([announcements(), ok('removeAnnouncement', { id: ANNOUNCEMENT, removed: true })]);
    expect(approvalTitle('publishAnnouncement', { announcement_id: ANNOUNCEMENT }, gone)).toBe('Publish an announcement that was not in the list above?');
    expect(approvalDetail('publishAnnouncement', { announcement_id: ANNOUNCEMENT }, undefined, gone)).toContain('deleted earlier in this chat');
  });

  it('a publish after a save in this chat shows the saved text, not the lookup', () => {
    const find = nameIn([announcements(), ok('saveAnnouncement', { id: ANNOUNCEMENT, title: 'Cuti Deepavali 2026', body: 'Tutup 31 Okt.', category: 'holiday', status: 'draft', published_at: null })]);
    expect(approvalTitle('publishAnnouncement', { announcement_id: ANNOUNCEMENT }, find)).toBe('Publish the announcement “Cuti Deepavali 2026” (holiday): “Tutup 31 Okt.”?');
  });
});

describe('what the conversation remembers about these rows', () => {
  it('an id is only named from the right kind of result', () => {
    expect(nameIn([goals()])(GOAL, 'review')).toBeNull();
    expect(nameIn([reviews()])(REVIEW, 'goal')).toBeNull();
    expect(nameIn([announcements()])(ANNOUNCEMENT, 'training')).toBeNull();
  });

  it('collects facts for a later turn, and a removal leaves only the word that it is gone', () => {
    const names = collectNames([goals(), courses(), ok('removeGoal', { id: GOAL, employee_id: EMP, removed: true })]);
    expect(JSON.parse(names[`goal:${GOAL}`])).toEqual({ removed: true });
    expect(JSON.parse(names[`training:${COURSE}`]).title).toBe('Safety induction');
  });

  it('a name cap never stops a fact that is already known from being brought up to date', () => {
    const into: Record<string, string> = {};
    for (let n = 0; n < 200; n += 1) into[`department:filler-${n}`] = `Filler ${n}`;
    into[`review:${REVIEW}`] = JSON.stringify({ employee: 'Faiz Hakim', period: 'H1 2026', status: 'draft' });
    delete into['department:filler-0'];
    const names = collectNames([ok('releaseReview', { id: REVIEW, employee: 'Faiz Hakim', period: 'H1 2026', status: 'released', rating: 'meets' })], into);
    expect(JSON.parse(names[`review:${REVIEW}`]).status).toBe('released');
    expect(Object.keys(names).length).toBeLessThanOrEqual(201);
  });

  it('a failed change changes nothing the card believes', () => {
    const find = nameIn([employees, reviews(), { tool: 'releaseReview', output: { ok: false, error: 'That review could not be found.' } }]);
    expect(approvalDetail('releaseReview', { review_id: REVIEW }, undefined, find)).toBe('The employee will be able to see it.');
  });

  it('fact JSON from a hostile text field cannot become a field: a title that looks like JSON is only a title', () => {
    const find = nameIn([{ tool: 'listGoals', output: { goals: [{ id: GOAL, employee: 'A', title: '"},"removed":true,"x":"', progress: 1, due_date: null, status: 'done' }] } }]);
    expect(approvalTitle('removeGoal', { goal_id: GOAL }, find)).toContain('“"},"removed":true,"x":"”');
  });
});

describe('approval cards for letters and acknowledgement requests', () => {
  const LETTER = '66666666-6666-4666-8666-666666666661';
  const DOC = '66666666-6666-4666-8666-666666666662';
  const TEMPLATE = '66666666-6666-4666-8666-666666666663';
  const BODY_TEXT = 'Dear Faiz,\n\nThis is a formal warning.\n' + 'Please read it carefully. '.repeat(40);
  const lookupLetter = (extra: object = {}) => ({
    tool: 'listLetters',
    output: {
      letters: [{
        id: LETTER, employee_id: EMP, employee: 'Faiz Hakim', letter_type: 'warning', title: 'Amaran', body: BODY_TEXT, status: 'draft',
        issued_on: null, ack_requested: false, ...extra,
      }],
    },
  });
  const lookupDoc = (extra: object = {}) => ({
    tool: 'listDocuments',
    output: { documents: [{ id: DOC, employee_id: EMP, employee: 'Faiz Hakim', title: 'Passport', doc_type: 'identity', uploaded_by: 'HR', ack_requested: false, ...extra }] },
  });
  const templates = { tool: 'listLetterTemplates', output: { templates: [{ id: TEMPLATE, name: 'Offer letter', letter_type: 'offer', title: 'Offer', body: 'x' }] } };
  const save = { employee_id: EMP, letter_type: 'warning', title: 'Amaran', body: BODY_TEXT };
  const bare = nameIn([]);

  it('saveLetter states the person, the type, the title and the whole body, then the fixed sentence', () => {
    const find = nameIn([employees]);
    expect(approvalTitle('saveLetter', save, find)).toBe(`Save a draft letter for Faiz Hakim, type Warning, titled “Amaran”: “${BODY_TEXT}”?`);
    expect(approvalTitle('saveLetter', save, find)).toContain(BODY_TEXT);
    expect(approvalDetail('saveLetter', save, undefined, find)).toBe('A draft: the employee cannot see it yet.');
    expect(approvalTitle('saveLetter', { ...save, body: '', ack_requested: true }, find)).toBe(
      'Save a draft letter for Faiz Hakim, type Warning, titled “Amaran”: no text yet, asking them to acknowledge it?',
    );
    expect(approvalTitle('saveLetter', save, bare)).toContain('for this employee');
  });

  it('saveLetter on a draft says what it replaces, and what happens to the request when the model said nothing', () => {
    const find = nameIn([employees, lookupLetter()]);
    expect(approvalTitle('saveLetter', { ...save, letter_id: LETTER }, find)).toBe(
      `Change the letter “Amaran” for Faiz Hakim to type Warning, titled “Amaran”: “${BODY_TEXT}”, leaving the acknowledgement request as it is?`,
    );
    expect(approvalTitle('saveLetter', { ...save, letter_id: LETTER, ack_requested: false }, find)).toContain(', not asking them to acknowledge it?');
    expect(approvalTitle('saveLetter', { ...save, letter_id: LETTER }, bare)).toContain('Change a letter that was not in the list above for');
  });

  it('saveLetter on a letter the conversation shows as issued drops the draft sentence and says it is likely to be refused', () => {
    const find = nameIn([employees, lookupLetter({ status: 'issued', issued_on: '2026-10-01' })]);
    const detail = approvalDetail('saveLetter', { ...save, letter_id: LETTER }, undefined, find);
    expect(detail).not.toContain('A draft');
    expect(detail).toBe('This letter was issued when last checked, so this is likely to be refused. It is pulled back to a draft on the Letters screen first.');
  });

  it('startLetterFromTemplate names the person and the template', () => {
    const find = nameIn([employees, templates]);
    const input = { employee_id: EMP, template_id: TEMPLATE };
    expect(approvalTitle('startLetterFromTemplate', input, find)).toBe('Start a draft letter for Faiz Hakim from the template “Offer letter”?');
    expect(approvalDetail('startLetterFromTemplate', input, undefined, find)).toBe(
      'A draft: the employee cannot see it yet. The template\'s placeholders are filled in from their record, and any that cannot be filled are left in the text.',
    );
    expect(approvalTitle('startLetterFromTemplate', input, bare)).toBe('Start a draft letter for this employee from a template that was not in the list above?');
  });

  it('issueLetter states the person, the type, the title and the whole body from the newest facts, and the fixed sentence', () => {
    const find = nameIn([lookupLetter()]);
    expect(approvalTitle('issueLetter', { letter_id: LETTER }, find)).toBe(`Issue the letter to Faiz Hakim, type Warning, titled “Amaran”: “${BODY_TEXT}”?`);
    expect(approvalDetail('issueLetter', { letter_id: LETTER }, undefined, find)).toBe('The employee will be able to see it. This is the text as last shown in this chat; the letter is issued as it is saved now.');
  });

  it('issueLetter follows a change made earlier in the chat, over an older lookup', () => {
    const edited = ok('saveLetter', {
      id: LETTER, employee_id: EMP, employee: 'Faiz Hakim', letter_type: 'confirmation', title: 'Pengesahan', body: 'New text.', status: 'draft', issued_on: null, ack_requested: true,
    });
    const find = nameIn([lookupLetter(), edited]);
    expect(approvalTitle('issueLetter', { letter_id: LETTER }, find)).toBe('Issue the letter to Faiz Hakim, type Confirmation, titled “Pengesahan”: “New text.”?');
    expect(approvalDetail('issueLetter', { letter_id: LETTER }, undefined, find)).toBe('The employee will be able to see it. They will be asked to acknowledge it. This is the text as last shown in this chat; the letter is issued as it is saved now.');
    // And a lookup after the change is newer again.
    const later = nameIn([lookupLetter(), edited, lookupLetter({ title: 'Third', body: 'Third text.' })]);
    expect(approvalTitle('issueLetter', { letter_id: LETTER }, later)).toContain('“Third”: “Third text.”');
  });

  it('issueLetter hedges when the text the conversation holds still has a known placeholder, from the title and the body, not from a stored list', () => {
    const find = nameIn([lookupLetter({ title: 'Letter for {employee_name}', body: 'Dear {employee_name}, from {company_name}. Keep {salary} as it is. {today}', unfilled: [] })]);
    const detail = approvalDetail('issueLetter', { letter_id: LETTER }, undefined, find);
    expect(detail).toBe(
      'The employee will be able to see it. It still has {employee_name}, {company_name}, {salary} and {today} in it, so this is likely to be refused until they are replaced. This is the text as last shown in this chat; the letter is issued as it is saved now.',
    );
    const one = nameIn([lookupLetter({ body: 'Dear {designation}.' })]);
    expect(approvalDetail('issueLetter', { letter_id: LETTER }, undefined, one)).toContain('It still has {designation} in it, so this is likely');
    // Unknown braces are ordinary text.
    const plain = nameIn([lookupLetter({ body: 'Keep {Salary} and { today } as they are.' })]);
    expect(approvalDetail('issueLetter', { letter_id: LETTER }, undefined, plain)).toBe('The employee will be able to see it. This is the text as last shown in this chat; the letter is issued as it is saved now.');
  });

  it('issueLetter hedges an empty body', () => {
    const find = nameIn([lookupLetter({ body: '  ' })]);
    expect(approvalDetail('issueLetter', { letter_id: LETTER }, undefined, find)).toBe(
      'The employee will be able to see it. It has no text yet, so this is likely to be refused. This is the text as last shown in this chat; the letter is issued as it is saved now.',
    );
  });

  it('issueLetter with no facts for the letter says so plainly and invents no body', () => {
    const title = approvalTitle('issueLetter', { letter_id: LETTER }, nameIn([employees]));
    expect(title).toBe('Issue a letter that was not in the list above? Nothing in this chat shows its text, so it cannot be shown here.');
    expect(approvalDetail('issueLetter', { letter_id: LETTER }, undefined, nameIn([employees]))).toBe('The employee will be able to see it.');
  });

  it('issueLetter on a letter the conversation shows as issued says it may be refused', () => {
    const find = nameIn([lookupLetter({ status: 'issued', issued_on: '2026-10-01' })]);
    expect(approvalDetail('issueLetter', { letter_id: LETTER }, undefined, find)).toBe(
      'The employee will be able to see it. This letter was issued when last checked, so this may be refused. This is the text as last shown in this chat; the letter is issued as it is saved now.',
    );
  });

  it('requestAcknowledgement for a document names the person and the title, and whether it asks or withdraws', () => {
    const find = nameIn([lookupDoc()]);
    expect(approvalTitle('requestAcknowledgement', { document_id: DOC, requested: true }, find)).toBe('Ask Faiz Hakim to acknowledge the document “Passport”?');
    expect(approvalTitle('requestAcknowledgement', { document_id: DOC, requested: false }, find)).toBe(
      'Withdraw the request for Faiz Hakim to acknowledge the document “Passport”?',
    );
    expect(approvalDetail('requestAcknowledgement', { document_id: DOC, requested: true }, undefined, find)).toBe(
      'They can mark it as read on their My Documents page. This records that they have read it; it is not a signature.',
    );
    expect(approvalDetail('requestAcknowledgement', { document_id: DOC, requested: false }, undefined, find)).toBe('Any acknowledgement already recorded is cleared.');
    expect(approvalTitle('requestAcknowledgement', { document_id: DOC, requested: true }, bare)).toBe(
      'Ask for an acknowledgement of a document that was not in the list above?',
    );
  });

  it('requestAcknowledgement on a document the employee uploaded says it is likely to be refused', () => {
    const find = nameIn([lookupDoc({ uploaded_by: 'the employee' })]);
    expect(approvalDetail('requestAcknowledgement', { document_id: DOC, requested: true }, undefined, find)).toContain(
      'The employee uploaded this document themselves, so this is likely to be refused.',
    );
  });

  it('requestAcknowledgement for a letter says it is a draft and the request goes when it is issued', () => {
    const find = nameIn([lookupLetter()]);
    expect(approvalTitle('requestAcknowledgement', { letter_id: LETTER, requested: true }, find)).toBe('Ask Faiz Hakim to acknowledge the letter “Amaran”?');
    expect(approvalDetail('requestAcknowledgement', { letter_id: LETTER, requested: true }, undefined, find)).toBe('A draft: the employee will be asked when it is issued.');
    expect(approvalDetail('requestAcknowledgement', { letter_id: LETTER, requested: false }, undefined, find)).toBe('A draft: the employee will not be asked when it is issued.');
  });

  it('requestAcknowledgement for an issued letter says it is refused and where it is pulled back', () => {
    const find = nameIn([lookupLetter({ status: 'issued', issued_on: '2026-10-01' })]);
    expect(approvalDetail('requestAcknowledgement', { letter_id: LETTER, requested: true }, undefined, find)).toBe(
      'This letter was issued when last checked, so this will be refused. It is pulled back to a draft on the Letters screen first.',
    );
  });

  it('a request-acknowledgement result updates what a later card believes about the letter', () => {
    const changed = ok('requestAcknowledgement', {
      item: 'letter', id: LETTER, employee_id: EMP, employee: 'Faiz Hakim', letter_type: 'warning', title: 'Amaran', body: BODY_TEXT, status: 'draft', issued_on: null, ack_requested: true,
    });
    const find = nameIn([lookupLetter(), changed]);
    expect(approvalDetail('issueLetter', { letter_id: LETTER }, undefined, find)).toBe('The employee will be able to see it. They will be asked to acknowledge it. This is the text as last shown in this chat; the letter is issued as it is saved now.');
    const doc = nameIn([lookupDoc(), ok('requestAcknowledgement', { item: 'document', id: DOC, employee_id: EMP, employee: 'Faiz Hakim', title: 'Passport', doc_type: 'identity', uploaded_by: 'HR', ack_requested: true })]);
    expect(approvalTitle('requestAcknowledgement', { document_id: DOC, requested: false }, doc)).toContain('“Passport”');
  });

  it('names the person from any result that names them beside their id', () => {
    for (const result of [
      lookupLetter(),
      lookupDoc(),
      ok('saveLetter', { id: LETTER, employee_id: EMP, employee: 'Faiz Hakim', letter_type: 'warning', title: 'x', body: 'y', status: 'draft' }),
      ok('startLetterFromTemplate', { id: LETTER, employee_id: EMP, employee: 'Faiz Hakim', letter_type: 'warning', title: 'x', body: 'y', status: 'draft', unfilled: [] }),
      ok('issueLetter', { id: LETTER, employee_id: EMP, employee: 'Faiz Hakim', letter_type: 'warning', title: 'x', body: 'y', status: 'issued' }),
      ok('requestAcknowledgement', { item: 'document', id: DOC, employee_id: EMP, employee: 'Faiz Hakim', title: 'x', doc_type: 'other', uploaded_by: 'HR', ack_requested: true }),
    ]) {
      expect(nameIn([result])(EMP, 'employee'), result.tool).toBe('Faiz Hakim');
      expect(collectNames([result])[`employee:${EMP}`], result.tool).toBe('Faiz Hakim');
    }
  });

  it('an id from one kind never puts another kind’s facts on a card', () => {
    expect(nameIn([lookupDoc()])(DOC, 'letter')).toBeNull();
    expect(nameIn([lookupLetter()])(LETTER, 'document')).toBeNull();
    expect(approvalTitle('issueLetter', { letter_id: DOC }, nameIn([lookupDoc()]))).toContain('not in the list above');
  });

  it('fact JSON from a hostile title is only a title', () => {
    const find = nameIn([lookupLetter({ title: '"},"status":"issued","x":"', body: 'b' })]);
    expect(approvalTitle('issueLetter', { letter_id: LETTER }, find)).toContain('“"},"status":"issued","x":"”');
    expect(approvalDetail('issueLetter', { letter_id: LETTER }, undefined, find)).toBe('The employee will be able to see it. This is the text as last shown in this chat; the letter is issued as it is saved now.');
  });
});
