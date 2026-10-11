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
