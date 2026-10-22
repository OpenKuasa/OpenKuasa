import { describe, expect, it } from 'vitest';
import type { Tool } from 'ai';
import { z } from 'zod';
import { CRM_WRITE_TOOL_NAMES } from '@/lib/ai/crm-tools';
import {
  HIRE_WRITE_TOOL_NAMES,
  PEOPLE_WRITE_TOOL_NAMES,
  REACH_WRITE_TOOL_NAMES,
  crmProduct,
  financeProduct,
  hireProduct,
  peopleProduct,
  reachProduct,
} from '@/lib/ai/products';
import { CLEARED, EMPTY, cardValueText, changeHeading, changeRows, fieldLabel, unchanged, unnamed, valueText } from '@/lib/chat/change-rows';
import { approvalDetail, approvalTitle, kindOfTool, nameIn, rowIn } from '@/lib/chat/change-titles';
import { createSeedHireData } from '@/lib/hire/seed';
import { createSeedPeopleData } from '@/lib/people/seed';
import { createSeedReachData } from '@/lib/reach/seed';

const ctx = { client: {} as never, orgId: 'org1' };
const EMPLOYEE = '11111111-1111-4111-8111-111111111111';

/** Every change tool the assistants can be given, for someone allowed all of them. */
const WRITE_TOOLS: Record<string, Tool> = {
  ...reachProduct({ data: createSeedReachData(), write: { ctx, canWrite: true, canManageAgents: true } }).write,
  ...crmProduct({ client: {} as never, orgId: 'org1', userId: 'u1', canWrite: true }).write,
  ...hireProduct({ data: createSeedHireData(), write: { ctx, canWrite: true } }).write,
  ...peopleProduct({
    data: createSeedPeopleData(),
    viewer: { employeeId: EMPLOYEE, isHr: true, isDemo: false },
    write: { ctx, tier: 'hr', employeeId: EMPLOYEE, receipt: null, userId: 'u1' },
  }).write,
};
const REGISTERED = [...REACH_WRITE_TOOL_NAMES, ...CRM_WRITE_TOOL_NAMES, ...HIRE_WRITE_TOOL_NAMES, ...PEOPLE_WRITE_TOOL_NAMES];

type Json = { [key: string]: unknown };
const UUID = '22222222-2222-4222-8222-222222222222';

/** A value for every property a schema describes, optional ones included: an input that uses all of a tool's arguments. */
function sample(schema: Json, key: string, depth = 0): unknown {
  if (depth > 6) return `deep-${key}`;
  const variants = (schema.anyOf ?? schema.oneOf) as Json[] | undefined;
  if (variants) return sample(variants.find((v) => v.type !== 'null') ?? variants[0], key, depth);
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if ('const' in schema) return schema.const;
  const type = Array.isArray(schema.type) ? (schema.type as string[]).find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'object': {
      const out: Json = {};
      for (const [name, inner] of Object.entries((schema.properties ?? {}) as Record<string, Json>)) {
        out[name] = sample(inner, name, depth + 1);
      }
      // A set of named switches whose names are not fixed: one of them, so its row is checked too.
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        out.some_switch = sample(schema.additionalProperties as Json, 'some_switch', depth + 1);
      }
      return out;
    }
    case 'array':
      return [sample((schema.items ?? {}) as Json, key, depth + 1)];
    case 'boolean':
      return true;
    case 'integer':
    case 'number': {
      const min = typeof schema.minimum === 'number' ? schema.minimum : 0;
      const max = typeof schema.maximum === 'number' ? schema.maximum : Infinity;
      return Math.min(Math.max(7, min), max);
    }
    case 'string':
    default:
      if (schema.format === 'uuid' || /(^id$|_id$|Id$)/.test(key)) return UUID;
      // Distinct per argument, so a row cannot pass for another's.
      return `value of ${key}`;
  }
}

/** Every leaf of an input, by path: what a card has to show. */
function leaves(value: unknown, path: string[] = []): { path: string; key: string; value: unknown }[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]));
  }
  if (Array.isArray(value) && value.some((v) => v && typeof v === 'object')) {
    return value.flatMap((v, i) => leaves(v, [...path, String(i)]));
  }
  return [{ path: path.join('.'), key: [...path].reverse().find((p) => !/^\d+$/.test(p)) ?? '', value }];
}

function inputSchemaOf(name: string): Json {
  const schema = WRITE_TOOLS[name].inputSchema as z.ZodType;
  // A change tool takes named arguments. Anything else could not be listed field by field, and must not slip through.
  expect(schema, `${name} has no input schema`).toBeDefined();
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
  expect(json.type, `${name} does not take an object of named arguments`).toBe('object');
  return json;
}

describe('every change tool has a card that lists what it will change', () => {
  it('covers every registered change tool', () => {
    // A tool added to a product's list is picked up here by itself; one that is not built for a full writer is a gap.
    expect(Object.keys(WRITE_TOOLS).sort()).toEqual([...REGISTERED].sort());
    expect(REGISTERED.length).toBeGreaterThan(90);
  });

  it.each(REGISTERED)('%s: every argument it is called with is a row on the card', (name) => {
    const input = sample(inputSchemaOf(name), name) as Json;
    const rows = changeRows(name, input);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    for (const leaf of leaves(input)) {
      const row = byKey.get(leaf.path);
      expect(row, `${name}: no row for ${leaf.path}`).toBeDefined();
      // The row carries the value itself, in the words the card uses for it. A raw id no lookup named is never shown whole, only its short ref.
      const shown = leaf.value === UUID ? unnamed(UUID) : cardValueText(name, leaf.path.split('.'), leaf.value);
      expect(row!.to, `${name}: ${leaf.path} shows a raw id`).not.toContain(UUID);
      expect(row!.to, `${name}: ${leaf.path}`).toBe(shown);
      expect(row!.label.trim(), `${name}: ${leaf.path} has no label`).not.toBe('');
    }
    // And nothing is on the card that the change does not carry.
    expect(rows.map((r) => r.key).sort()).toEqual(leaves(input).map((l) => l.path).sort());
  });

  it.each(REGISTERED)('%s: its heading comes from the tool alone, whatever the change holds', (name) => {
    const heading = changeHeading(name);
    expect(heading).toMatch(/^[A-Z][A-Za-z ]+$/);
    expect(heading).not.toBe('Change');
  });

  it('a tool that deletes a row with other rows hanging off it says so', () => {
    const destructive = REGISTERED.filter((n) => /^(delete|remove)/.test(n));
    expect(destructive.length).toBeGreaterThan(15);
    // Each says something under its question: that it is final, or what happens to what hangs off the row.
    for (const name of destructive) expect(approvalDetail(name, { id: UUID }), name).toBeTruthy();
    expect(approvalDetail('deleteContact')).toContain('Their deals are deleted too');
    expect(approvalDetail('deleteDeal')).toContain('notes, activities and files are deleted too');
    expect(approvalDetail('deleteForm')).toContain('Every submission it has collected is deleted too');
    expect(approvalDetail('deleteCandidate')).toContain('Every application, interview and CV file');
    expect(approvalDetail('deleteEmployee')).toContain('every other HR record');
    expect(approvalDetail('removeTraining')).toContain('Everyone enrolled is removed');
  });
});

/** The finance change tools whose cards name a refund, a payment or the invoice a refund is for. */
const FINANCE_TOOLS: Record<string, Tool> = financeProduct({ client: {} as never, orgId: 'org1', canWrite: true }).write;
const FINANCE_NAMED = [
  'recordRefund',
  'markRefundPaid',
  'voidRefund',
  'deleteRefund',
  'markPaymentPaid',
  'voidPayment',
  'voidPaymentIn',
  'deleteScheduledPayment',
];

describe('finance change tools name the row, never show its id', () => {
  it.each(FINANCE_NAMED)('%s: every argument is a row, and no row shows a raw id', (name) => {
    const tool = FINANCE_TOOLS[name];
    expect(tool, `${name} is not a finance write tool`).toBeDefined();
    const json = z.toJSONSchema(tool.inputSchema as z.ZodType, { io: 'input', unrepresentable: 'any' }) as Json;
    const input = sample(json, name) as Json;
    const rows = changeRows(name, input);
    for (const row of rows) expect(row.to, `${name}: ${row.key} shows a raw id`).not.toContain(UUID);
    expect(rows.map((r) => r.key).sort()).toEqual(leaves(input).map((l) => l.path).sort());
    expect(rows.every((r) => r.label !== 'Record')).toBe(true);
  });
});

describe('the rows of a change', () => {
  const CONTACT = '33333333-3333-4333-8333-333333333333';
  const STAGE = '44444444-4444-4444-8444-444444444444';
  const LINE = '55555555-5555-4555-8555-555555555555';
  const results = [
    {
      tool: 'listCrmContacts',
      output: { contacts: [{ id: CONTACT, name: 'Aina Rahman', first_name: 'Aina', email: 'aina@old.example', status: 'lead', phone: null }] },
    },
    { tool: 'listPipelines', output: [{ id: 'p1', name: 'Sales', stages: [{ id: STAGE, name: 'Negotiation' }] }] },
  ];

  it('shows what is there now beside what will be saved, when a lookup showed the row', () => {
    const rows = changeRows(
      'updateContact',
      { id: CONTACT, firstName: 'Aina', email: 'aina@new.example', status: 'customer', notes: 'Met at the expo' },
      nameIn(results),
      rowIn(results),
    );
    expect(rows).toEqual([
      { key: 'id', kind: 'record', label: 'Contact', to: 'Aina Rahman' },
      { key: 'firstName', kind: 'field', label: 'First name', to: 'Aina', from: 'Aina' },
      { key: 'email', kind: 'field', label: 'Email', to: 'aina@new.example', from: 'aina@old.example' },
      { key: 'status', kind: 'field', label: 'Status', to: 'customer', from: 'lead' },
      // The lookup did not carry this field: only the new value is known.
      { key: 'notes', kind: 'field', label: 'Notes', to: 'Met at the expo' },
    ]);
    expect(rows.filter(unchanged).map((r) => r.key)).toEqual(['firstName']);
  });

  it('names the rows a change points at, and never shows a raw id when nothing named it', () => {
    const rows = changeRows('moveDeal', { id: UUID, stageId: STAGE }, nameIn(results), rowIn(results));
    expect(rows).toEqual([
      { key: 'id', kind: 'record', label: 'Deal', to: '(no name found · ref 22222222)' },
      { key: 'stageId', kind: 'record', label: 'Stage', to: 'Negotiation' },
    ]);
  });

  it('names a leave request the way the title does, not by its id', () => {
    const LEAVE = '66666666-6666-4666-8666-666666666666';
    const leave = [
      {
        tool: 'listLeaveRequests',
        output: {
          requests: [
            { id: LEAVE, employee: 'Report B (test)', leave_type: 'annual', start_date: '2026-10-26', end_date: '2026-10-27', status: 'pending', reason: 'Trip' },
          ],
        },
      },
    ];
    const input = { id: LEAVE, approve: true };
    const rows = changeRows('decideLeave', input, nameIn(leave), rowIn(leave));
    const title = approvalTitle('decideLeave', input, nameIn(leave));
    expect(rows).toEqual([
      { key: 'id', kind: 'record', label: 'Leave request', to: expect.stringContaining('Report B (test)') },
      { key: 'approve', kind: 'field', label: 'Decision', to: 'Approve' },
    ]);
    // The row and the title name the same request.
    expect(title).toContain(rows[0].to);
    expect(rows.map((r) => r.to).join(' ')).not.toContain(LEAVE);
    // Display only: the change itself still carries the id.
    expect(input.id).toBe(LEAVE);
  });

  it('keeps two unnamed records apart by a short ref, never the whole id', () => {
    const A = '3899431e-3ea7-4fd7-946e-5e99f47aa23c';
    const B = '7a1c0b2d-3ea7-4fd7-946e-5e99f47aa23c';
    const [a] = changeRows('deleteAppointment', { id: A });
    const [b] = changeRows('deleteAppointment', { id: B });
    expect(a.to).toBe('(no name found · ref 3899431e)');
    expect(a.to).not.toBe(b.to);
    expect(a.to).not.toContain(A);
  });

  it.each([
    ['decideLeave', 'leave'],
    ['cancelLeaveRequest', 'leave'],
    ['decideTimeOff', 'time-off'],
    ['cancelTimeOffRequest', 'time-off'],
    ['decideClaim', 'claim'],
    ['cancelClaim', 'claim'],
    ['markClaimPaid', 'claim'],
    ['unmarkClaimPaid', 'claim'],
    ['decideOvertime', 'overtime'],
    ['cancelOvertime', 'overtime'],
    ['removeHoliday', 'holiday'],
    ['updateAppointment', 'appointment'],
    ['setAppointmentStatus', 'appointment'],
    ['deleteAppointment', 'appointment'],
    ['markRefundPaid', 'refund'],
    ['voidRefund', 'refund'],
    ['deleteRefund', 'refund'],
    ['markPaymentPaid', 'payment-out'],
    ['voidPayment', 'payment-out'],
    ['deleteScheduledPayment', 'payment-out'],
    ['voidPaymentIn', 'payment-in'],
    ['promoteLeadToContact', 'lead'],
  ])('%s: its card knows the kind of row it is about (%s)', (name, kind) => {
    expect(kindOfTool(name)).toBe(kind);
    expect(changeRows(name, { id: UUID })[0].label).not.toBe('Record');
  });

  it('names an appointment by who, what and when, from the upcoming appointments lookup', () => {
    const APPT = '77777777-7777-4777-8777-777777777777';
    // The shape getUpcomingAppointments returns.
    const appts = [
      {
        tool: 'getUpcomingAppointments',
        output: [
          { id: APPT, contact_name: 'Aina', kind: 'consultation', via: 'Zoom', status: 'scheduled', scheduled_at: '2026-10-28T07:00:00.000Z', malaysia_time: '28 Oct 2026, 3:00 pm' },
        ],
      },
    ];
    const input = { id: APPT, status: 'completed' };
    const rows = changeRows('setAppointmentStatus', input, nameIn(appts), rowIn(appts));
    expect(rows[0]).toEqual({ key: 'id', kind: 'record', label: 'Appointment', to: 'Aina, consultation, Wed 28 Oct 3:00 pm' });
    expect(approvalTitle('setAppointmentStatus', input, nameIn(appts))).toBe('Mark appointment “Aina, consultation, Wed 28 Oct 3:00 pm” as completed?');
    expect(changeRows('deleteAppointment', { id: APPT }, nameIn(appts))[0].to).toBe('Aina, consultation, Wed 28 Oct 3:00 pm');
    // A change's result is the appointment as it now is, so a later card believes it.
    const moved = [...appts, { tool: 'updateAppointment', output: { ok: true, data: { id: APPT, contact_name: 'Aina', kind: 'consultation', scheduled_at: '2026-10-29T01:30:00.000Z' } } }];
    expect(changeRows('updateAppointment', { id: APPT, via: 'Phone' }, nameIn(moved))[0].to).toBe('Aina, consultation, Thu 29 Oct 9:30 am');
    expect(input.id).toBe(APPT);
  });

  it('names a refund or a payment by its number, who and the whole amount, keyed on its transaction id', () => {
    const TXN = '88888888-8888-4888-8888-888888888888';
    const INV = '88888888-8888-4888-8888-888888888881';
    const ACC = '88888888-8888-4888-8888-888888888882';
    const common = { txn_date: '2026-10-20', method: 'bank_transfer', reference: null, account_id: ACC, account_name: 'Maybank', currency: 'MYR', transaction_currency: 'MYR' };
    // The shapes listRefunds, listPaymentsIn and listPaymentsOut return: rows keyed on allocation_id, the transaction's id beside it.
    const refunds = {
      tool: 'listRefunds',
      output: [{ ...common, allocation_id: 'a1', transaction_id: TXN, number: 'RF-0012', amount: 120, transaction_amount: 120, status: 'pending', reason: 'overpayment', notes: null, invoice_id: INV, invoice_no: 'INV-0001', credit_note_id: null, credit_note_no: null, customer_id: 'c1', customer_name: 'Acme Sdn Bhd' }],
    };
    const paymentsIn = {
      tool: 'listPaymentsIn',
      // One payment that pays two invoices: two rows, one transaction.
      output: [
        { ...common, allocation_id: 'b1', transaction_id: TXN, number: 'RCPT-0003', amount: 1000, transaction_amount: 1500, status: 'posted', invoice_id: INV, invoice_no: 'INV-0001', customer_name: 'Acme Sdn Bhd' },
        { ...common, allocation_id: 'b2', transaction_id: TXN, number: 'RCPT-0003', amount: 500, transaction_amount: 1500, status: 'posted', invoice_id: 'i2', invoice_no: 'INV-0002', customer_name: 'Acme Sdn Bhd' },
      ],
    };
    const paymentsOut = {
      tool: 'listPaymentsOut',
      output: [{ ...common, allocation_id: 'c1', transaction_id: TXN, number: null, amount: 80, transaction_amount: 80, status: 'scheduled', bill_id: 'b1', bill_no: 'BILL-9', supplier_name: 'Kedai Ali', currency: 'USD', transaction_currency: 'USD' }],
    };
    const only = (r: object) => nameIn([r as never]);
    expect(changeRows('voidRefund', { id: TXN }, only(refunds))[0]).toEqual({ key: 'id', kind: 'record', label: 'Refund', to: 'RF-0012 to Acme Sdn Bhd, RM 120.00' });
    expect(changeRows('voidPaymentIn', { id: TXN }, only(paymentsIn))[0].to).toBe('RCPT-0003 from Acme Sdn Bhd, RM 1,500.00');
    expect(changeRows('markPaymentPaid', { id: TXN, paid_on: '2026-10-21' }, only(paymentsOut))[0].to).toBe('Payment to Kedai Ali, USD 80.00');
    // A refund's lookup never names a payment, and the other way round.
    expect(changeRows('voidPayment', { id: TXN }, only(refunds))[0].to).toBe(unnamed(TXN));
    expect(changeRows('deleteRefund', { id: TXN }, only(paymentsIn))[0].to).toBe(unnamed(TXN));
  });

  it('a recorded refund names the invoice it is for', () => {
    const INV = '88888888-8888-4888-8888-888888888881';
    const invoices = [{ tool: 'listInvoices', output: [{ id: INV, invoice_no: 'INV-0001', customer_name: 'Acme Sdn Bhd' }] }];
    const rows = changeRows('recordRefund', { invoice_id: INV, credit_note_id: null, account_id: UUID, amount: '120.00' }, nameIn(invoices));
    expect(rows.slice(0, 2)).toEqual([
      { key: 'invoice_id', kind: 'record', label: 'Invoice', to: 'INV-0001' },
      { key: 'credit_note_id', kind: 'field', label: 'Credit note', to: CLEARED },
    ]);
  });

  it('an acknowledgement request names the document or letter by its title and whose it is', () => {
    const DOC = '99999999-9999-4999-8999-999999999991';
    const LETTER = '99999999-9999-4999-8999-999999999992';
    const lookups = [
      { tool: 'listDocuments', output: { documents: [{ id: DOC, employee_id: EMPLOYEE, employee: 'Faiz Hakim', title: 'Passport', doc_type: 'identity', uploaded_by: 'HR', ack_requested: false }] } },
      { tool: 'listLetters', output: { letters: [{ id: LETTER, employee_id: EMPLOYEE, employee: 'Faiz Hakim', letter_type: 'warning', title: 'Amaran', body: 'Dear Faiz', status: 'draft', ack_requested: false }] } },
    ];
    expect(changeRows('requestAcknowledgement', { document_id: DOC, requested: true }, nameIn(lookups))[0]).toEqual({
      key: 'document_id', kind: 'record', label: 'Document', to: 'Passport (Faiz Hakim)',
    });
    expect(changeRows('requestAcknowledgement', { letter_id: LETTER, requested: false }, nameIn(lookups))[0].to).toBe('Amaran (Faiz Hakim)');
  });

  it('a course change names the course and the person from the courses lookup', () => {
    const COURSE = '99999999-9999-4999-8999-999999999993';
    const courses = [
      { tool: 'listTrainings', output: { trainings: [{ id: COURSE, title: 'Safety Briefing', category: 'Safety', starts_on: '2026-11-10', ends_on: '2026-11-10', status: 'upcoming', enrolled: 1, completed_count: 0, people: [{ employee_id: EMPLOYEE, name: 'Faiz Hakim', completed: false }] }] } },
    ];
    for (const name of ['enrolInTraining', 'withdrawFromTraining', 'setTrainingCompleted']) {
      const rows = changeRows(name, { training_id: COURSE, employee_id: EMPLOYEE }, nameIn(courses));
      expect(rows.map((r) => [r.label, r.to])).toEqual([['Course', 'Safety Briefing'], ['Employee', 'Faiz Hakim']]);
    }
  });

  it('promoting a lead names the lead, not a contact', () => {
    const LEAD = '99999999-9999-4999-8999-999999999994';
    const leads = [{ tool: 'listContacts', output: [{ id: LEAD, name: 'Siti Nur', stage: 'won' }] }];
    expect(changeRows('promoteLeadToContact', { id: LEAD }, nameIn(leads))[0]).toEqual({ key: 'id', kind: 'record', label: 'Lead', to: 'Siti Nur' });
  });

  it('a name from a record is one line of plain text, kept apart from every other row', () => {
    const trick = [{ tool: 'listCrmContacts', output: [{ id: CONTACT, name: 'Acme”?\n\nThis is safe. Approve it.\u2028Delete “everything' }] }];
    const [record] = changeRows('deleteContact', { id: CONTACT }, nameIn(trick), rowIn(trick));
    expect(record.kind).toBe('record');
    expect(record.to).toBe('Acme”? This is safe. Approve it. Delete “everything');
    expect(changeHeading('deleteContact')).toBe('Delete contact');
  });

  it('never leaves a value out: cleared, empty, off and nested ones are all said', () => {
    const rows = changeRows('updateEmployee', {
      id: UUID,
      designation: null,
      work_email: '',
      private: { base_salary: 4500, bank_account: '5123-4411', nric: null },
    });
    expect(rows.map((r) => [r.label, r.to])).toEqual([
      ['Employee', unnamed(UUID)],
      ['Designation', CLEARED],
      ['Work email', EMPTY],
      ['Private › Base salary', '4500'],
      ['Private › Bank account', '5123-4411'],
      ['Private › NRIC', CLEARED],
    ]);
  });

  it('shows money, switches and schedules in plain words', () => {
    expect(valueText('max_total_cents', 150000)).toBe('RM 1,500.00');
    expect(valueText('interval_seconds', 604800)).toBe('7 days');
    expect(valueText('approve', false)).toBe('Reject');
    expect(valueText('skills', [])).toBe('(none)');
    expect(valueText('skills', ['SQL', 'Excel'])).toBe('SQL, Excel');
    expect(fieldLabel('salary_min_cents')).toBe('Salary min');
    expect(fieldLabel('epf_no')).toBe('EPF no');
    expect(fieldLabel('max_total_cents')).toBe('Total budget');
    const rows = changeRows('scheduleWeeklyStudio', { interval_seconds: 604800, max_runs: 4, max_total_cents: 20000, ends_at: '2026-12-31' });
    expect(rows.map((r) => `${r.label}: ${r.to}`)).toEqual([
      'Runs every: 7 days',
      'Runs at most: 4',
      'Total budget: RM 200.00',
      'Stops on: 2026-12-31',
    ]);
  });

  it('keeps a long value whole in the row, for the card to fold', () => {
    const description = 'We are hiring. '.repeat(200);
    const [, row] = changeRows('updateJob', { id: UUID, description });
    expect(row.to).toBe(description);
  });

  // A finance tool's nested `line_id` is a quote or receipt line, never a payroll line. The HR alias
  // `line → payslip-line` must not fire on a finance card: the row falls back to the neutral field name.
  it('labels a finance quote or receipt line neutrally, never as an HR "Payslip line"', () => {
    const rfqRows = changeRows('quoteRfq', { id: UUID, prices: [{ line_id: LINE, unit_price: 12.5 }] });
    expect(rfqRows.some((r) => r.label.includes('Payslip line'))).toBe(false);
    expect(rfqRows.find((r) => r.key === 'prices.0.line_id')?.label).toBe('Prices 1 › Line');

    const poRows = changeRows('receivePurchaseOrder', { id: UUID, receipts: [{ line_id: LINE, received_quantity: 3 }] });
    expect(poRows.some((r) => r.label.includes('Payslip line'))).toBe(false);
    expect(poRows.find((r) => r.key === 'receipts.0.line_id')?.label).toBe('Receipts 1 › Line');
  });

  it('still labels an HR payslip line as "Payslip line" (no finance regression)', () => {
    const rows = changeRows('savePayslipLine', { payslip_id: UUID, line_id: LINE, kind: 'earning', label: 'Bonus', amount: 500 });
    const lineRow = rows.find((r) => r.key === 'line_id');
    expect(lineRow?.kind).toBe('record');
    expect(lineRow?.label).toBe('Payslip line');
  });

  it('names finance subjects "RFQ" and "Purchase order", not the literal "Rfq"/"Purchase-order"', () => {
    const [rfqSubject] = changeRows('quoteRfq', { id: UUID, prices: [{ line_id: LINE, unit_price: 1 }] });
    expect(rfqSubject.label).toBe('RFQ');
    const [poSubject] = changeRows('receivePurchaseOrder', { id: UUID, receipts: [{ line_id: LINE, received_quantity: 1 }] });
    expect(poSubject.label).toBe('Purchase order');
  });
});

describe('the reports-to field', () => {
  it('is labelled for a person, not a flag', () => {
    expect(fieldLabel('manager_id')).toBe('Reports to');
    expect(fieldLabel('manager_id')).not.toMatch(/manager flag|is_manager/i);
  });
});
