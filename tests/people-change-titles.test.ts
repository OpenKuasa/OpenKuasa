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
      'Their leave, claims, payslips and every other HR record are deleted too. This cannot be undone.',
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
    expect(approvalTitle('applyLeave', input)).toBe('Apply for annual leave, 20–22 Oct?');
    expect(approvalTitle('applyLeave', { ...input, leave_type: 'medical', end_date: '2026-10-20' })).toBe('Apply for medical leave, 20 Oct?');
    expect(approvalTitle('applyLeave', { ...input, start_date: '2026-10-30', end_date: '2026-11-02' })).toBe(
      'Apply for annual leave, 30 Oct–2 Nov?',
    );
    expect(approvalTitle('applyLeave', { ...input, end_date: '2026-10-20', half_day: true })).toBe(
      'Apply for annual leave, 20 Oct (half day)?',
    );
    expect(approvalTitle('applyTimeOff', { off_date: '2026-10-20', start_time: '14:00', end_time: '16:00' })).toBe(
      'Request time-off, 20 Oct, 14:00–16:00?',
    );
    expect(approvalDetail('applyLeave', input)).toBeNull();
    // What will be saved under the person's name is quoted and labelled.
    expect(approvalDetail('applyLeave', { ...input, reason: ' Family trip ' })).toBe('Reason: “Family trip”');
    expect(approvalDetail('applyTimeOff', { off_date: '2026-10-20', reason: 'Clinic' })).toBe('Reason: “Clinic”');
    expect(approvalDetail('applyTimeOff', { off_date: '2026-10-20' })).toBeNull();
  });

  it('a member’s card, which has no employee, names no one; an owner’s names who it is for', () => {
    const input = { leave_type: 'annual', start_date: '2026-10-20', end_date: '2026-10-22' };
    expect(approvalTitle('applyLeave', input, find)).toBe('Apply for annual leave, 20–22 Oct?');
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
    expect(approvalTitle('applyLeave', { leave_type: 'annual', start_date: 'soon', end_date: '2026-13-40' })).toBe('Apply for annual leave?');
    expect(approvalTitle('applyLeave', {})).toBe('Apply for leave?');
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
    expect(approvalTitle('submitClaim', claim)).toBe('Claim RM 85.00 for travel, 9 Oct?');
    expect(approvalTitle('submitClaim', { ...claim, amount_cents: 112050, category: 'medical' })).toBe('Claim RM 1,120.50 for medical, 9 Oct?');
    expect(approvalTitle('submitClaim', { ...claim, amount_cents: 5, category: 'other' })).toBe('Claim RM 0.05 for other expenses, 9 Oct?');
  });

  it('names the employee only when an owner or admin gave one, and never on a member’s card', () => {
    // A member's input has no employee at all: the card names nobody, whatever the lookups hold.
    expect(approvalTitle('submitClaim', claim, find)).not.toContain('Amirul');
    expect(approvalTitle('submitOvertime', { work_date: '2026-10-10', hours: 3 }, find)).toBe('Claim 3 hours of overtime on 10 Oct?');
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
    expect(approvalTitle('submitOvertime', input)).toBe('Claim 2.5 hours of overtime on 10 Oct?');
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
    expect(approvalTitle('submitClaim', { category: 'travel', amount_cents: 85.5, claim_date: 'soon' })).toBe('Claim for travel?');
    expect(approvalTitle('submitClaim', {})).toBe('Claim?');
    expect(approvalTitle('submitOvertime', { work_date: '2026-13-40', hours: 'lots' })).toBe('Claim overtime?');
  });

  it('remembers a claim and an overtime record by kind for later turns', () => {
    expect(collectNames(lookups)).toMatchObject({
      [`claim:${CLAIM_ID}`]: "Amirul Hakim's RM 85.00 travel claim",
      [`overtime:${OT_ID}`]: "Amirul Hakim's 3 hours of overtime on 10 Oct",
    });
  });
});
