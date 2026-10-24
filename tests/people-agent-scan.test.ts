import { describe, expect, it } from 'vitest';
import { peopleAgentNoteInput } from '@/lib/people/agent/actions';
import type { PeopleAgentRaw } from '@/lib/people/agent/context';
import { PEOPLE_NOTE_ENTITY_TYPES, scanPeople, type PeopleNoteInput } from '@/lib/people/agent/scan';

// 12:00 on Fri 23 Oct 2026 in Kuala Lumpur.
const NOW = new Date('2026-10-23T04:00:00.000Z');
const AS_OF = ' (as of 23 Oct 2026)';

const E1 = 'e1111111-1111-4111-8111-111111111111';
const E2 = 'e2222222-2222-4222-8222-222222222222'; // inactive
const E3 = 'e3333333-3333-4333-8333-333333333333';
const R1 = 'a1111111-1111-4111-8111-111111111111';
const R2 = 'a2222222-2222-4222-8222-222222222222';
const R3 = 'a3333333-3333-4333-8333-333333333333';
const R4 = 'a4444444-4444-4444-8444-444444444444';
const R5 = 'a5555555-5555-4555-8555-555555555555';

const EMPLOYEES: PeopleAgentRaw['employees'] = [
  { id: E1, name: 'Aisyah Rahman', active: true },
  { id: E2, name: 'Farid Osman', active: false },
  { id: E3, name: 'Mei Ling Tan', active: true },
];

type Check = { key: string; params: Record<string, number> };

function raw(over: Partial<PeopleAgentRaw> & { checks?: Check[] }): PeopleAgentRaw {
  const { checks, ...rest } = over;
  return {
    plan: checks ? { checks } : null,
    employees: EMPLOYEES,
    documents: [],
    goals: [],
    leaves: [],
    claims: [],
    overtime: [],
    letters: [],
    attendance: [],
    payrollRuns: [],
    ...rest,
  };
}

const scan = (r: PeopleAgentRaw, now = NOW) => scanPeople(r, now);
const inputs = (r: PeopleAgentRaw, now = NOW) => scan(r, now).map((c) => c.input as PeopleNoteInput);

const ALL_CHECKS: Check[] = [
  { key: 'document_expiring', params: { days: 30 } },
  { key: 'goal_overdue', params: { days: 0 } },
  { key: 'leave_waiting', params: { days: 3 } },
  { key: 'leave_starts_soon', params: { days: 3 } },
  { key: 'claim_waiting', params: { days: 7 } },
  { key: 'overtime_waiting', params: { days: 7 } },
  { key: 'letter_draft_stale', params: { days: 7 } },
  { key: 'absent_streak', params: { days: 2 } },
  { key: 'payroll_unpaid', params: { day: 20 } },
];

describe('scanPeople', () => {
  it('suggests nothing without a confirmed plan', () => {
    expect(scan(raw({ letters: [{ id: R1, employeeId: E1, createdAt: '2026-01-01T00:00:00Z' }] }))).toEqual([]);
  });

  it('empty sources: every check on an empty workspace proposes nothing and does not throw', () => {
    expect(scan(raw({ checks: ALL_CHECKS, employees: [] }))).toEqual([]);
  });

  it('exports the note entity types the database accepts', () => {
    expect([...PEOPLE_NOTE_ENTITY_TYPES]).toEqual([
      'hr_employee',
      'hr_document',
      'hr_goal',
      'hr_leave_request',
      'hr_claim',
      'hr_overtime_record',
      'hr_letter',
      'hr_payroll_month',
    ]);
  });

  describe('document_expiring', () => {
    const r = raw({
      checks: [{ key: 'document_expiring', params: { days: 30 } }],
      documents: [
        { id: R1, employeeId: E1, docType: 'contract', expiresOn: '2026-11-04' }, // in 12 days
        { id: R2, employeeId: E3, docType: 'medical', expiresOn: '2026-10-20' }, // expired 3 days ago
        { id: R3, employeeId: E1, docType: 'other', expiresOn: '2026-12-30' }, // out of range
        { id: R4, employeeId: E2, docType: 'contract', expiresOn: '2026-10-25' }, // inactive
        { id: R5, employeeId: E1, docType: 'identity', expiresOn: null },
      ],
    });

    it('notes soon and expired documents, oldest expiry first, by type label only', () => {
      const out = scan(r);
      expect(out.map((c) => c.title)).toEqual(['Document expired · 3 days ago', 'Document expiring · in 12 days']);
      expect(out.every((c) => c.checkKey === 'document_expiring' && c.action === 'createAgentNote')).toBe(true);
      expect(out[1].input).toEqual({
        entityType: 'hr_document',
        entityId: R1,
        employeeId: E1,
        entityLabel: 'Aisyah Rahman',
        body: `Aisyah Rahman's contract expires 04 Nov 2026.${AS_OF}`,
        target: R1,
        stage: 'soon',
        days: 30,
      });
      expect((out[0].input as PeopleNoteInput).body).toBe(`A confidential document for Mei Ling Tan expired 20 Oct 2026.${AS_OF}`);
      expect((out[0].input as PeopleNoteInput).stage).toBe('expired');
    });

    it('names each type: identity stays, other and unknown are "a document", expiring today is "today"', () => {
      const docs = (docType: string) =>
        inputs(
          raw({
            checks: [{ key: 'document_expiring', params: { days: 30 } }],
            documents: [{ id: R1, employeeId: E1, docType, expiresOn: '2026-10-23' }],
          }),
        )[0].body;
      expect(docs('identity')).toBe(`Aisyah Rahman's identity document expires 23 Oct 2026.${AS_OF}`);
      expect(docs('tax')).toBe(`Aisyah Rahman's tax document expires 23 Oct 2026.${AS_OF}`);
      expect(docs('benefits')).toBe(`Aisyah Rahman's benefits document expires 23 Oct 2026.${AS_OF}`);
      expect(docs('certificate')).toBe(`Aisyah Rahman's certificate expires 23 Oct 2026.${AS_OF}`);
      expect(docs('other')).toBe(`A document for Aisyah Rahman expires 23 Oct 2026.${AS_OF}`);
      expect(docs('payslip')).toBe(`A document for Aisyah Rahman expires 23 Oct 2026.${AS_OF}`);
      expect(
        scan(
          raw({
            checks: [{ key: 'document_expiring', params: { days: 30 } }],
            documents: [{ id: R1, employeeId: E1, docType: 'contract', expiresOn: '2026-10-23' }],
          }),
        )[0].title,
      ).toBe('Document expiring · today');
    });
  });

  describe('goal_overdue', () => {
    const goals: PeopleAgentRaw['goals'] = [
      { id: R1, employeeId: E1, title: 'Launch the Penang branch', progress: 40, dueDate: '2026-10-14' }, // 9 late
      { id: R2, employeeId: E3, title: 'Due today', progress: 10, dueDate: '2026-10-23' },
      { id: R3, employeeId: E3, title: 'No date', progress: 10, dueDate: null },
      { id: R4, employeeId: E2, title: 'Inactive', progress: 0, dueDate: '2026-01-01' },
      { id: R5, employeeId: E3, title: 'Yesterday', progress: 90, dueDate: '2026-10-22' }, // 1 late
    ];

    it('with N = 0 flags goals a day or more late, in buckets of 1, 2, 4, 8 days', () => {
      const out = scan(raw({ checks: [{ key: 'goal_overdue', params: { days: 0 } }], goals }));
      expect(out.map((c) => [c.title, (c.input as PeopleNoteInput).stage])).toEqual([
        ['Goal overdue · 40% done · 9 days late', '8'],
        ['Goal overdue · 90% done · 1 day late', '1'],
      ]);
      expect(out[0].input).toMatchObject({
        entityType: 'hr_goal',
        entityId: R1,
        employeeId: E1,
        target: R1,
        body: `Aisyah Rahman's goal "Launch the Penang branch" was due 14 Oct 2026 and is 40% done.${AS_OF}`,
      });
    });

    it('with N = 7 buckets at 7, 14, 28', () => {
      const out = inputs(raw({ checks: [{ key: 'goal_overdue', params: { days: 7 } }], goals }));
      expect(out.map((i) => [i.target, i.stage])).toEqual([[R1, '7']]);
    });
  });

  describe('waiting requests', () => {
    it('leave_waiting counts Malaysian days since it was asked, with doubling stages', () => {
      const out = scan(
        raw({
          checks: [{ key: 'leave_waiting', params: { days: 3 } }],
          leaves: [
            { id: R1, employeeId: E1, createdAt: '2026-10-17T02:00:00Z', startDate: '2026-11-02', endDate: '2026-11-04' }, // 6
            { id: R2, employeeId: E3, createdAt: '2026-10-20T17:00:00Z', startDate: '2026-11-09', endDate: '2026-11-09' }, // 21 Oct KL: 2
            { id: R3, employeeId: E3, createdAt: '2026-10-20T15:00:00Z', startDate: '2026-12-31', endDate: '2027-01-02' }, // 20 Oct KL: 3
            { id: R4, employeeId: E2, createdAt: '2026-09-01T00:00:00Z', startDate: '2026-11-02', endDate: '2026-11-02' }, // inactive
          ],
        }),
      );
      expect(out.map((c) => [c.title, (c.input as PeopleNoteInput).stage])).toEqual([
        ['Leave waiting · 6 days', '6'],
        ['Leave waiting · 3 days', '3'],
      ]);
      expect((out[0].input as PeopleNoteInput).body).toBe(
        `Aisyah Rahman's leave request for 02 Nov–04 Nov 2026 has waited 6 days for a decision.${AS_OF}`,
      );
      expect((out[1].input as PeopleNoteInput).body).toBe(
        `Mei Ling Tan's leave request for 31 Dec 2026–02 Jan 2027 has waited 3 days for a decision.${AS_OF}`,
      );
      expect(out[0].input).toMatchObject({ entityType: 'hr_leave_request', entityId: R1, employeeId: E1, target: R1 });
    });

    it('a one-day leave names one date', () => {
      const out = inputs(
        raw({
          checks: [{ key: 'leave_waiting', params: { days: 1 } }],
          leaves: [{ id: R1, employeeId: E1, createdAt: '2026-10-21T02:00:00Z', startDate: '2026-11-02', endDate: '2026-11-02' }],
        }),
      );
      expect(out[0].body).toBe(`Aisyah Rahman's leave request for 02 Nov 2026 has waited 2 days for a decision.${AS_OF}`);
    });

    it('leave_starts_soon: within N days or already started, staged by the start date', () => {
      const out = scan(
        raw({
          checks: [{ key: 'leave_starts_soon', params: { days: 3 } }],
          leaves: [
            { id: R1, employeeId: E3, createdAt: '2026-10-22T00:00:00Z', startDate: '2026-10-25', endDate: '2026-10-26' },
            { id: R2, employeeId: E1, createdAt: '2026-10-01T00:00:00Z', startDate: '2026-10-21', endDate: '2026-10-28' },
            { id: R3, employeeId: E1, createdAt: '2026-10-01T00:00:00Z', startDate: '2026-10-23', endDate: '2026-10-23' },
            { id: R4, employeeId: E1, createdAt: '2026-10-01T00:00:00Z', startDate: '2026-10-30', endDate: '2026-10-30' },
            { id: R5, employeeId: E2, createdAt: '2026-10-01T00:00:00Z', startDate: '2026-10-24', endDate: '2026-10-24' },
          ],
        }),
      );
      expect(out.map((c) => [c.title, (c.input as PeopleNoteInput).stage])).toEqual([
        ['Leave started · 2 days ago · still waiting', '2026-10-21'],
        ['Leave starts today · still waiting', '2026-10-23'],
        ['Leave starts soon · in 2 days', '2026-10-25'],
      ]);
      expect((out[2].input as PeopleNoteInput).body).toBe(
        `Mei Ling Tan's leave from 25 Oct 2026 is still waiting for a decision.${AS_OF}`,
      );
    });

    it('claim_waiting and overtime_waiting name only the date, never a category, amount or hours', () => {
      const out = scan(
        raw({
          checks: [
            { key: 'claim_waiting', params: { days: 7 } },
            { key: 'overtime_waiting', params: { days: 7 } },
          ],
          claims: [
            { id: R1, employeeId: E1, createdAt: '2026-10-15T01:00:00Z', claimDate: '2026-10-01' }, // 8
            { id: R2, employeeId: E1, createdAt: '2026-10-20T01:00:00Z', claimDate: '2026-10-19' }, // 3
          ],
          overtime: [{ id: R3, employeeId: E3, createdAt: '2026-10-09T01:00:00Z', workDate: '2026-10-08' }], // 14
        }),
      );
      expect(out.map((c) => [c.checkKey, c.title, (c.input as PeopleNoteInput).stage])).toEqual([
        ['claim_waiting', 'Claim waiting · 8 days', '7'],
        ['overtime_waiting', 'Overtime waiting · 14 days', '14'],
      ]);
      expect(out[0].input).toMatchObject({
        entityType: 'hr_claim',
        employeeId: E1,
        body: `Aisyah Rahman's claim dated 01 Oct 2026 has waited 8 days for a decision.${AS_OF}`,
      });
      expect(out[1].input).toMatchObject({
        entityType: 'hr_overtime_record',
        employeeId: E3,
        body: `Mei Ling Tan's overtime on 08 Oct 2026 has waited 14 days for a decision.${AS_OF}`,
      });
    });

    it('letter_draft_stale names no title or body', () => {
      const out = scan(
        raw({
          checks: [{ key: 'letter_draft_stale', params: { days: 7 } }],
          letters: [
            { id: R1, employeeId: E1, createdAt: '2026-10-14T01:00:00Z' }, // 9
            { id: R2, employeeId: E2, createdAt: '2026-09-01T01:00:00Z' }, // inactive
          ],
        }),
      );
      expect(out.map((c) => c.title)).toEqual(['Draft letter waiting · 9 days']);
      expect(out[0].input).toMatchObject({
        entityType: 'hr_letter',
        entityId: R1,
        employeeId: E1,
        stage: '7',
        body: `A draft letter for Aisyah Rahman has waited 9 days to be issued.${AS_OF}`,
      });
    });
  });

  describe('absent_streak', () => {
    const check = (days: number) => [{ key: 'absent_streak', params: { days } }];

    it('absent streak counts rows: Friday then Monday is 2 in a row, on_leave breaks it', () => {
      const out = scan(
        raw({
          checks: check(2),
          attendance: [
            { employeeId: E1, workDate: '2026-10-15', status: 'present' },
            { employeeId: E1, workDate: '2026-10-19', status: 'absent' }, // Mon (out of order on purpose)
            { employeeId: E1, workDate: '2026-10-16', status: 'absent' }, // Fri
            { employeeId: E3, workDate: '2026-10-20', status: 'absent' },
            { employeeId: E3, workDate: '2026-10-21', status: 'on_leave' },
            { employeeId: E3, workDate: '2026-10-22', status: 'absent' },
            { employeeId: E2, workDate: '2026-10-21', status: 'absent' }, // inactive
            { employeeId: E2, workDate: '2026-10-22', status: 'absent' },
          ],
        }),
      );
      expect(out).toHaveLength(1);
      expect(out[0].title).toBe('Absent 2 working days in a row');
      expect(out[0].input).toEqual({
        entityType: 'hr_employee',
        entityId: E1,
        employeeId: E1,
        entityLabel: 'Aisyah Rahman',
        body: `Aisyah Rahman has been marked absent 2 working days in a row (since 16 Oct 2026).${AS_OF}`,
        target: E1,
        stage: '2026-10-16',
      });
    });

    it('ends on the latest row: back at work means no streak; late breaks it too', () => {
      const out = scan(
        raw({
          checks: check(1),
          attendance: [
            { employeeId: E1, workDate: '2026-10-21', status: 'absent' },
            { employeeId: E1, workDate: '2026-10-22', status: 'present' },
            { employeeId: E3, workDate: '2026-10-20', status: 'absent' },
            { employeeId: E3, workDate: '2026-10-21', status: 'late' },
            { employeeId: E3, workDate: '2026-10-22', status: 'absent' },
          ],
        }),
      );
      expect(out.map((c) => [c.title, (c.input as PeopleNoteInput).stage])).toEqual([
        ['Absent 1 working day in a row', '2026-10-22'],
      ]);
    });

    it('only counts rows from the last 14 days', () => {
      const attendance: PeopleAgentRaw['attendance'] = [
        { employeeId: E1, workDate: '2026-10-09', status: 'absent' },
        { employeeId: E1, workDate: '2026-10-12', status: 'absent' },
        { employeeId: E1, workDate: '2026-10-13', status: 'absent' },
      ];
      expect(scan(raw({ checks: check(3), attendance }))).toEqual([]);
      expect(inputs(raw({ checks: check(2), attendance })).map((i) => i.stage)).toEqual(['2026-10-12']);
    });
  });

  describe('payroll_unpaid', () => {
    const check = (day: number) => [{ key: 'payroll_unpaid', params: { day } }];

    it('waits for day N of the month, then notes a missing or unpaid run', () => {
      expect(scan(raw({ checks: check(25) }))).toEqual([]);
      const out = scan(raw({ checks: check(20) }));
      expect(out.map((c) => c.title)).toEqual(['Payroll Oct 2026 not marked paid']);
      expect(out[0].input).toEqual({
        entityType: 'hr_payroll_month',
        entityId: null,
        employeeId: null,
        entityLabel: 'Payroll Oct 2026',
        body: `Payroll for October 2026 isn't marked paid yet.${AS_OF}`,
        target: 'payroll:2026-10',
        stage: '2026-10',
      });
      expect(scan(raw({ checks: check(20), payrollRuns: [{ periodMonth: '2026-10-01', status: 'draft' }] }))).toHaveLength(1);
      expect(scan(raw({ checks: check(20), payrollRuns: [{ periodMonth: '2026-10-01', status: 'paid' }] }))).toEqual([]);
      // Last month's run does not count for this month.
      expect(scan(raw({ checks: check(20), payrollRuns: [{ periodMonth: '2026-09-01', status: 'paid' }] }))).toHaveLength(1);
    });

    it('day 31 counts as the last day of a shorter month', () => {
      const nov30 = new Date('2026-11-30T04:00:00.000Z');
      expect(scan(raw({ checks: check(31) }), nov30).map((c) => c.title)).toEqual(['Payroll Nov 2026 not marked paid']);
      expect(scan(raw({ checks: check(31) }), new Date('2026-11-29T04:00:00.000Z'))).toEqual([]);
    });

    it('a workspace with no active employees has no payroll to chase', () => {
      expect(scan(raw({ checks: check(20), employees: [EMPLOYEES[1]] }))).toEqual([]);
    });
  });

  describe('privacy', () => {
    // Fields the scan must never carry into a note, given to it on purpose.
    const leaky = raw({
      checks: ALL_CHECKS,
      documents: [
        { id: R1, employeeId: E1, docType: 'medical', expiresOn: '2026-11-01', title: 'Hospital report: diabetes' } as never,
      ],
      goals: [{ id: R2, employeeId: E1, title: 'Hit RM 50k sales', progress: 20, dueDate: '2026-10-01' }],
      leaves: [
        {
          id: R3,
          employeeId: E3,
          createdAt: '2026-10-01T00:00:00Z',
          startDate: '2026-10-24',
          endDate: '2026-10-25',
          leaveType: 'medical',
          reason: 'Surgery at Gleneagles',
        } as never,
      ],
      claims: [
        { id: R4, employeeId: E1, createdAt: '2026-10-01T00:00:00Z', claimDate: '2026-09-30', category: 'Medical', amountCents: 45000, description: 'Clinic' } as never,
      ],
      overtime: [
        { id: R5, employeeId: E3, createdAt: '2026-10-01T00:00:00Z', workDate: '2026-09-30', hours: 6, amountCents: 9000 } as never,
      ],
      letters: [{ id: R1, employeeId: E3, createdAt: '2026-10-01T00:00:00Z', title: 'Warning letter', body: 'Final warning' } as never],
      attendance: [
        { employeeId: E1, workDate: '2026-10-21', status: 'absent' },
        { employeeId: E1, workDate: '2026-10-22', status: 'absent' },
      ],
    });

    it('templates never name sensitive fields', () => {
      const out = scan(leaky);
      expect(new Set(out.map((c) => c.checkKey))).toEqual(new Set(ALL_CHECKS.map((c) => c.key)));
      const notes = out.map((c) => (c.input as PeopleNoteInput).body).join('\n');
      for (const banned of [
        /medical/i,
        /diabetes|hospital/i,
        /surgery|gleneagles/i,
        /clinic/i,
        /\bRM\s?\d/,
        /450|90\.00|9000|45000/,
        /\bhours?\b/i,
        /warning/i,
        /salary|nric|bank/i,
      ]) {
        // The goal title is allowed in its note (spec §4.1); everything else is not.
        expect(notes.replace('"Hit RM 50k sales"', '"…"')).not.toMatch(banned);
      }
      expect(notes).toContain('A confidential document for Aisyah Rahman');
    });

    it('titles carry no name, title, person-tied date or id', () => {
      const out = scan(leaky);
      const titles = out.map((c) => c.title).join('\n');
      for (const name of ['Aisyah', 'Rahman', 'Mei Ling', 'Tan', 'Hit RM', 'sales']) expect(titles).not.toContain(name);
      expect(titles).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
      expect(titles).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(titles).not.toMatch(/\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/);
    });

    it('every candidate passes the action schema and carries its employee (payroll carries none)', () => {
      const out = scan(leaky);
      for (const c of out) {
        const input = c.input as PeopleNoteInput;
        expect(peopleAgentNoteInput.safeParse(input).success, c.title).toBe(true);
        expect(input.body.endsWith(AS_OF)).toBe(true);
        if (input.entityType === 'hr_payroll_month') expect(input.employeeId).toBeNull();
        else expect(input.employeeId).toMatch(/^e/);
      }
    });

    it('an inactive employee never appears, in any check', () => {
      const r = raw({
        checks: ALL_CHECKS.filter((c) => c.key !== 'payroll_unpaid'),
        documents: [{ id: R1, employeeId: E2, docType: 'contract', expiresOn: '2026-10-24' }],
        goals: [{ id: R2, employeeId: E2, title: 'x', progress: 0, dueDate: '2026-01-01' }],
        leaves: [{ id: R3, employeeId: E2, createdAt: '2026-01-01T00:00:00Z', startDate: '2026-10-24', endDate: '2026-10-24' }],
        claims: [{ id: R4, employeeId: E2, createdAt: '2026-01-01T00:00:00Z', claimDate: '2026-01-01' }],
        overtime: [{ id: R5, employeeId: E2, createdAt: '2026-01-01T00:00:00Z', workDate: '2026-01-01' }],
        letters: [{ id: R1, employeeId: E2, createdAt: '2026-01-01T00:00:00Z' }],
        attendance: [
          { employeeId: E2, workDate: '2026-10-21', status: 'absent' },
          { employeeId: E2, workDate: '2026-10-22', status: 'absent' },
        ],
      });
      expect(scan(r)).toEqual([]);
      // An employee missing from the list (deleted, or another workspace's) is skipped too.
      expect(scan({ ...r, employees: [] })).toEqual([]);
    });
  });
});
