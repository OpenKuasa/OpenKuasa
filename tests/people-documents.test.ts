import { describe, expect, it } from 'vitest';
import {
  NO_FILE_LABEL,
  awaitingAcknowledgement,
  buildEmployeeDocumentsModel,
  buildLetterTemplatesModel,
  buildLettersModel,
  buildMyDocumentsModel,
  buildSettingsModel,
  canManageDocuments,
  fileLabel,
  formatFileSize,
  loadRecordsModel,
  loadSettingsModel,
  maskAccount,
  workWeekLabel,
} from '@/lib/people/documents';
import { createSeedPeopleData } from '@/lib/people/seed';
import {
  DEMO_EMPLOYEE_ID,
  type HrDocument,
  type Letter,
  type LetterTemplate,
  type Payslip,
  type PeopleData,
  type PeopleSettings,
  type PeopleViewer,
} from '@/lib/people/types';

const NOW = new Date('2026-10-09T04:00:00Z');
const TODAY = '2026-10-09';
const data = createSeedPeopleData(NOW);

const DEMO: PeopleViewer = { employeeId: DEMO_EMPLOYEE_ID, isHr: false, isDemo: true };
const HR_5: PeopleViewer = { employeeId: 'seed-emp-5', isHr: true, isDemo: false };
const MEMBER: PeopleViewer = { employeeId: 'seed-emp-5', isHr: false, isDemo: false };
const UNLINKED: PeopleViewer = { employeeId: null, isHr: true, isDemo: false };

const doc = (over: Partial<HrDocument>): HrDocument => ({
  id: 'd', employee_id: DEMO_EMPLOYEE_ID, employee_name: 'E', title: 'T', doc_type: 'benefits', expires_on: null,
  file_name: 'f.pdf', file_size: 2048, file_type: 'application/pdf', source: 'hr', ack_requested: false,
  acknowledged_at: null, created_at: '2026-01-01T02:00:00.000Z', has_file: true, ...over,
});
const letter = (over: Partial<Letter>): Letter => ({
  id: 'l', employee_id: DEMO_EMPLOYEE_ID, employee_name: 'E', letter_type: 'offer', title: 'Offer', body: 'Dear E,\n\nWelcome.',
  status: 'issued', issued_on: '2026-02-01', ack_requested: false, acknowledged_at: null, created_at: '2026-02-01T02:00:00.000Z', ...over,
});
const payslip = (over: Partial<Payslip>): Payslip => ({ id: 'p', employee_id: DEMO_EMPLOYEE_ID, period_month: '2026-09-01', status: 'paid', ...over }) as Payslip;
const template = (over: Partial<LetterTemplate>): LetterTemplate => ({ id: 't', name: 'N', letter_type: 'offer', title: 'T', body: 'B', lang: 'en', ...over });

const SETTINGS: PeopleSettings = {
  work_week: ['mon', 'tue', 'wed', 'thu', 'fri'],
  work_start_time: '09:00',
  late_grace_minutes: 15,
  default_annual_leave_days: 14.5,
  default_medical_leave_days: 14,
  default_emergency_leave_days: 3,
  overtime_rates: { weekday: 1.5, rest_day: 2, public_holiday: 3 },
  notifications: {},
};

describe('maskAccount', () => {
  it('keeps the last 4 characters only', () => {
    expect(maskAccount('1234567890')).toBe('••••7890');
  });
  it('hides a short account entirely and returns null for nothing', () => {
    expect(maskAccount('123')).toBe('•••');
    expect(maskAccount('1234')).toBe('••••');
    expect(maskAccount(null)).toBeNull();
    expect(maskAccount('  ')).toBeNull();
  });
});


describe('formatFileSize and fileLabel', () => {
  it('writes sizes for a person', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(1023)).toBe('1023 B');
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(340 * 1024)).toBe('340 KB');
    expect(formatFileSize(1.25 * 1024 * 1024)).toBe('1.3 MB');
    expect(formatFileSize(10 * 1024 * 1024)).toBe('10 MB');
    expect(formatFileSize(null)).toBeNull();
    expect(formatFileSize(-1)).toBeNull();
    expect(formatFileSize(Number.NaN)).toBeNull();
  });
  it('labels a file with what the row records, and nothing without one', () => {
    expect(fileLabel(doc({ file_name: 'passport.pdf', file_size: 340 * 1024, file_type: 'application/pdf' }))).toBe(
      'passport.pdf · 340 KB · PDF',
    );
    expect(fileLabel(doc({ file_name: 'a.heic', file_size: null, file_type: 'image/heic' }))).toBe('a.heic · HEIC');
    expect(fileLabel(doc({ has_file: false, file_name: null, file_size: null, file_type: null }))).toBeNull();
  });
});

describe('canManageDocuments', () => {
  it('is true for an owner or admin outside the sample company, and for no one else', () => {
    expect(canManageDocuments({ isHr: true, isDemo: false })).toBe(true);
    expect(canManageDocuments({ isHr: true, isDemo: true })).toBe(false);
    expect(canManageDocuments({ isHr: false, isDemo: false })).toBe(false);
    expect(canManageDocuments({ isHr: false, isDemo: true })).toBe(false);
    expect(canManageDocuments(UNLINKED)).toBe(true);
    expect(canManageDocuments(MEMBER)).toBe(false);
    expect(canManageDocuments(DEMO)).toBe(false);
  });
});

describe('awaitingAcknowledgement', () => {
  const MINE = 'seed-emp-5';
  const documents = [
    doc({ id: '1', employee_id: MINE, ack_requested: true }),
    doc({ id: '2', employee_id: MINE, ack_requested: true, acknowledged_at: '2026-10-01T00:00:00Z' }),
    doc({ id: '3', employee_id: MINE }),
    doc({ id: '4', employee_id: 'seed-emp-9', ack_requested: true }),
    doc({ id: '5', employee_id: MINE, ack_requested: true, source: 'employee' }),
  ];
  const letters = [
    letter({ id: '1', employee_id: MINE, ack_requested: true }),
    letter({ id: '2', employee_id: MINE, ack_requested: true, acknowledged_at: '2026-10-01T00:00:00Z' }),
    letter({ id: '3', employee_id: MINE, ack_requested: true, status: 'draft', issued_on: null }),
    letter({ id: '4', employee_id: MINE }),
    letter({ id: '5', employee_id: 'seed-emp-9', ack_requested: true }),
  ];

  it('counts a linked member one HR-added document and one issued letter awaiting, theirs only', () => {
    expect(awaitingAcknowledgement(documents, letters, MEMBER)).toBe(2);
    expect(awaitingAcknowledgement([], [], MEMBER)).toBe(0);
  });
  it("counts an owner who is also an employee their own rows, not the team's", () => {
    expect(awaitingAcknowledgement(documents, letters, HR_5)).toBe(2);
    const other: PeopleViewer = { employeeId: 'seed-emp-9', isHr: true, isDemo: false };
    expect(awaitingAcknowledgement(documents, letters, other)).toBe(2); // doc 4 and letter 5, not the five of seed-emp-5
  });
  it('is 0 for a viewer with no employee record', () => {
    expect(awaitingAcknowledgement(documents, letters, UNLINKED)).toBe(0);
  });
  it('is 0 for a demo visitor, whose acknowledgement the database refuses', () => {
    const demoDocs = [doc({ id: 'd', ack_requested: true })];
    const demoLetters = [letter({ id: 'l', ack_requested: true })];
    expect(awaitingAcknowledgement(demoDocs, demoLetters, DEMO)).toBe(0);
  });
});

describe('My Documents model', () => {
  const own = (over: Partial<PeopleViewer> = {}): PeopleViewer => ({ employeeId: 'e1', isHr: false, isDemo: false, ...over });
  const mine = (over: Partial<HrDocument>) => doc({ employee_id: 'e1', ...over });
  const mineLetter = (over: Partial<Letter>) => letter({ employee_id: 'e1', ...over });
  const mineSlip = (over: Partial<Payslip>) => payslip({ employee_id: 'e1', ...over });
  const build = (input: { documents?: HrDocument[]; letters?: Letter[]; payslips?: Payslip[]; viewer?: PeopleViewer }) => {
    const model = buildMyDocumentsModel({ documents: [], letters: [], payslips: [], today: TODAY, viewer: own(), ...input });
    if (!model.linked) throw new Error('expected linked');
    return model;
  };

  it("holds the demo employee's sample documents and letters, nothing downloadable and nothing to acknowledge", async () => {
    const model = build({
      documents: await data.listDocuments(),
      letters: await data.listLetters(),
      payslips: await data.listPayslips(),
      viewer: DEMO,
    });
    expect(model.documents).toBe(5);
    expect(model.letters).toBe(1); // the one issued letter addressed to the sample employee
    expect(model.expiring_soon).toBe(1);
    expect(model.expired).toBe(1);
    expect(model.awaiting_acknowledgement).toBe(0); // two sample items await, but the tile reads 0: nothing can clear them
    expect(model.payslips).toBeGreaterThan(0);
    expect(model.can_upload).toBe(false);
    const docs = model.rows.filter((r) => r.kind === 'document');
    expect(docs).toHaveLength(5);
    expect(docs.every((r) => r.no_file_label === NO_FILE_LABEL && r.file_label === null && !r.can_download && !r.can_remove)).toBe(true);
    // Awaiting, so listed first, but with no button: the database refuses it in the sample company.
    expect(model.rows.slice(0, 2).every((r) => r.awaiting_acknowledgement)).toBe(true);
    expect(model.rows.every((r) => !r.can_acknowledge)).toBe(true);
  });

  it('lists what awaits acknowledgement first, then the rest newest first', () => {
    const model = build({
      documents: [
        mine({ id: 'old', title: 'Old', created_at: '2025-01-01T02:00:00Z' }),
        mine({ id: 'ack', title: 'Ack', created_at: '2024-01-01T02:00:00Z', ack_requested: true }),
        mine({ id: 'new', title: 'New', created_at: '2026-06-01T02:00:00Z' }),
      ],
      letters: [mineLetter({ id: 'lt', issued_on: '2026-03-01', ack_requested: true })],
      payslips: [mineSlip({ id: 'ps', period_month: '2026-09-01' })],
    });
    expect(model.rows.map((r) => r.id)).toEqual(['lt', 'ack', 'ps', 'new', 'old']);
    expect(model.rows[0]).toMatchObject({ kind: 'letter', href: '/people/letters', can_acknowledge: true });
    expect(model.rows.find((r) => r.kind === 'payslip')).toMatchObject({
      title: 'Payslip, September 2026',
      href: '/people/my-payslips',
      can_download: false,
    });
  });

  it('gives the tiles from the rows: documents, awaiting, expiring within 90 days, payslips', () => {
    const model = build({
      documents: [
        mine({ id: '1', expires_on: '2026-10-09' }), // today
        mine({ id: '2', expires_on: '2027-01-07' }), // +90
        mine({ id: '3', expires_on: '2027-01-08' }), // +91
        mine({ id: '4', expires_on: '2026-10-08' }), // yesterday
        mine({ id: '5', ack_requested: true }),
      ],
      payslips: [mineSlip({ id: 'a' }), mineSlip({ id: 'b', period_month: '2026-08-01' })],
    });
    expect(model).toMatchObject({ documents: 5, expiring_soon: 2, expired: 1, awaiting_acknowledgement: 1, payslips: 2, letters: 0 });
    expect(model.rows.find((r) => r.id === '1')).toMatchObject({ expiry: 'expiring', expiry_label: 'Expires 09 Oct 2026' });
    expect(model.rows.find((r) => r.id === '4')).toMatchObject({ expiry: 'expired', expiry_label: 'Expired 08 Oct 2026' });
    expect(model.rows.find((r) => r.id === '3')).toMatchObject({ expiry: 'none', expiry_label: 'Expires 08 Jan 2027' });
  });

  it("never shows another employee's rows, a draft letter or a payslip that is not paid", () => {
    const model = build({
      documents: [mine({ id: 'm' }), doc({ id: 'x', employee_id: 'e2' })],
      letters: [
        mineLetter({ id: 'issued' }),
        mineLetter({ id: 'draft', status: 'draft', issued_on: null, ack_requested: true, title: 'Secret draft' }),
        letter({ id: 'other', employee_id: 'e2' }),
      ],
      payslips: [mineSlip({ id: 'paid' }), mineSlip({ id: 'pending', status: 'pending' }), payslip({ id: 'other', employee_id: 'e2' })],
    });
    expect(model.rows.map((r) => r.id).sort()).toEqual(['issued', 'm', 'paid']);
    expect(model.letters).toBe(1);
    expect(model.payslips).toBe(1);
    expect(model.awaiting_acknowledgement).toBe(0);
    expect(JSON.stringify(model)).not.toContain('Secret draft');
  });

  it('offers the controls the person may use, and only those', () => {
    const model = build({
      documents: [
        mine({ id: 'hr', source: 'hr', ack_requested: true }),
        mine({ id: 'own', source: 'employee' }),
        mine({ id: 'read', source: 'hr', ack_requested: true, acknowledged_at: '2026-10-01T03:00:00Z' }),
        mine({ id: 'nofile', has_file: false, file_name: null, file_size: null, file_type: null }),
      ],
    });
    const row = (id: string) => model.rows.find((r) => r.id === id)!;
    expect(row('hr')).toMatchObject({ can_acknowledge: true, can_remove: false, can_download: true, added_by_label: 'Added by HR' });
    expect(row('own')).toMatchObject({ can_acknowledge: false, can_remove: true, can_download: true, added_by_label: 'Added by you' });
    expect(row('read')).toMatchObject({ awaiting_acknowledgement: false, can_acknowledge: false, acknowledged_label: 'Acknowledged on 01 Oct 2026' });
    expect(row('nofile')).toMatchObject({ can_download: false, file_label: null, no_file_label: NO_FILE_LABEL });
    expect(row('hr').file_label).toBe('f.pdf · 2 KB · PDF');
    expect(model.can_upload).toBe(true);
    expect(model.employee_id).toBe('e1');
  });

  it('shows not linked for an unlinked account, and handles no rows', () => {
    expect(buildMyDocumentsModel({ documents: [doc({})], letters: [], payslips: [], today: TODAY, viewer: UNLINKED })).toEqual({
      linked: false,
    });
    const empty = build({ viewer: DEMO });
    expect(empty).toMatchObject({ documents: 0, letters: 0, payslips: 0, awaiting_acknowledgement: 0, rows: [] });
  });

  it("gives an HR viewer linked to an employee that employee's rows only", async () => {
    const all = await data.listDocuments();
    const model = build({ documents: all, viewer: HR_5 });
    const theirs = all.filter((d) => d.employee_id === 'seed-emp-5');
    expect(model.documents).toBe(theirs.length);
    expect(model.documents).toBeGreaterThan(0);
    expect(model.rows.every((r) => theirs.some((d) => d.id === r.id))).toBe(true);
  });
});

describe('Employee documents model', () => {
  const build = (documents: HrDocument[], viewer: PeopleViewer) =>
    buildEmployeeDocumentsModel({ documents, employeeId: DEMO_EMPLOYEE_ID, today: TODAY, viewer });

  it('is nothing at all for anyone but an owner or admin outside the sample company', () => {
    const docs = [doc({ id: '1' })];
    expect(build(docs, MEMBER)).toEqual({ allowed: false });
    expect(build(docs, DEMO)).toEqual({ allowed: false });
    expect(build(docs, { employeeId: null, isHr: true, isDemo: true })).toEqual({ allowed: false });
    expect(build(docs, HR_5)).toMatchObject({ allowed: true });
    expect(build(docs, UNLINKED)).toMatchObject({ allowed: true });
  });

  it("holds one employee's documents, newest first, with who added each and where acknowledgement stands", () => {
    const model = build(
      [
        doc({ id: 'a', title: 'A', created_at: '2026-01-01T02:00:00Z', ack_requested: true }),
        doc({ id: 'b', title: 'B', created_at: '2026-05-01T02:00:00Z', source: 'employee' }),
        doc({ id: 'c', title: 'C', created_at: '2026-03-01T02:00:00Z', ack_requested: true, acknowledged_at: '2026-04-02T03:00:00Z' }),
        doc({ id: 'x', employee_id: 'someone-else' }),
      ],
      HR_5,
    );
    if (!model.allowed) throw new Error('expected rows');
    expect(model.rows.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(model.total).toBe(3);
    const row = (id: string) => model.rows.find((r) => r.id === id)!;
    expect(row('a')).toMatchObject({ ack_label: 'Waiting for the employee', can_withdraw_ack: true, can_request_ack: false, added_by_label: 'Added by HR' });
    expect(row('b')).toMatchObject({ ack_label: 'Not asked', can_request_ack: false, can_withdraw_ack: false, added_by_label: 'Uploaded by the employee' });
    expect(row('c')).toMatchObject({ ack_label: 'Acknowledged on 02 Apr 2026' });
    expect(row('c').can_request_ack).toBe(false);
  });

  it('offers a request only for a document HR added that does not already ask', () => {
    const model = build([doc({ id: 'a' })], HR_5);
    if (!model.allowed) throw new Error('expected rows');
    expect(model.rows[0]).toMatchObject({ can_request_ack: true, can_withdraw_ack: false, can_download: true });
  });

  it('counts expiring and expired from the date', () => {
    const model = build([doc({ id: '1', expires_on: '2026-10-08' }), doc({ id: '2', expires_on: '2026-12-01' }), doc({ id: '3' })], HR_5);
    if (!model.allowed) throw new Error('expected rows');
    expect(model).toMatchObject({ expired: 1, expiring_soon: 1 });
  });
});

describe('Records', () => {
  it("builds the demo employee's record from their own private row", async () => {
    const model = await loadRecordsModel(data, DEMO, TODAY);
    if (!model.linked) throw new Error('expected linked');
    expect(model.sections.map((s) => s.key)).toEqual(['personal', 'employment', 'statutory', 'emergency', 'bank']);
    expect(model.sections[4].rows[1].value).toMatch(/^••••\d{4}$/);
    expect(model.employment).toBe('Full-time');
  });

  it('reads private details for the viewer only', async () => {
    const asked: string[] = [];
    const spy: PeopleData = {
      ...data,
      getEmployeePrivate: async (id) => {
        asked.push(id);
        return data.getEmployeePrivate(id);
      },
    };
    await loadRecordsModel(spy, DEMO, TODAY);
    expect(asked).toEqual([DEMO_EMPLOYEE_ID]);
    asked.length = 0;
    expect(await loadRecordsModel(spy, UNLINKED, TODAY)).toEqual({ linked: false });
    expect(asked).toEqual([]);
  });

  it('shows "Not recorded" for a viewer with no private row, never undefined or null', async () => {
    const none: PeopleData = { ...data, getEmployeePrivate: async () => null };
    const model = await loadRecordsModel(none, DEMO, TODAY);
    if (!model.linked) throw new Error('expected linked');
    const values = model.sections.flatMap((s) => s.rows.map((r) => r.value));
    expect(values).toContain('Not recorded');
    expect(values.join('|')).not.toMatch(/undefined|null/);
    expect(model.sections[0].rows.find((r) => r.label === 'NRIC')!.value).toBe('Not recorded');
  });

  it('copes with a missing directory row and no balances', async () => {
    const empty: PeopleData = { ...data, listEmployees: async () => [], listLeaveBalances: async () => [] };
    const model = await loadRecordsModel(empty, DEMO, TODAY);
    if (!model.linked) throw new Error('expected linked');
    expect(model.tenure.value).toBe('—');
    expect(model.annual_leave_left).toBe('—');
    const shown = [model.tenure.value, model.annual_leave_left, model.department, model.employment]
      .concat(model.sections.flatMap((s) => s.rows.map((r) => r.value)))
      .join('|');
    expect(shown).not.toMatch(/NaN|undefined|null/);
  });
});

describe('Letters model', () => {
  it('counts the sample letters for the team', async () => {
    const model = buildLettersModel(await data.listLetters(), DEMO, TODAY);
    expect(model.team).toBe(true);
    expect(model.can_manage).toBe(false);
    expect(model.totals).toEqual({ issued_this_year: 2, drafts: 2, issued_this_month: 1 });
    expect(model.by_type!.map((t) => t.key).sort()).toEqual(['confirmation', 'promotion']);
    expect(model.by_type!.map((t) => t.label).sort()).toEqual(['Confirmation', 'Promotion']);
    expect(model.rows).toHaveLength(5);
    expect(model.rows[0].date_label).toMatch(/\d{4}$/);
  });

  it('gives a plain member their own issued letters and no team figures', async () => {
    const priya: PeopleViewer = { employeeId: 'seed-emp-13', isHr: false, isDemo: false };
    const model = buildLettersModel(await data.listLetters(), priya, TODAY);
    expect(model.team).toBe(false);
    expect(model.can_manage).toBe(false);
    expect(model.totals).toBeNull();
    expect(model.by_type).toBeNull();
    expect(model.rows).toHaveLength(1);
    expect(model.rows.every((r) => r.status === 'issued' && r.employee_id === 'seed-emp-13')).toBe(true);
    // No letter of the 4 others (two of them drafts) reaches them even though the provider here returned all 5.
    expect((await data.listLetters()).length).toBe(5);
  });

  it('shows a member a draft addressed to them nowhere: not as a row, not as a count, not in the text', () => {
    const letters = [
      letter({ id: 'issued', employee_id: 'seed-emp-5', title: 'Welcome' }),
      letter({ id: 'draft', employee_id: 'seed-emp-5', title: 'Secret draft', body: 'Secret body', status: 'draft', issued_on: null }),
      letter({ id: 'other', employee_id: 'seed-emp-6', title: 'Someone else' }),
    ];
    const model = buildLettersModel(letters, MEMBER, TODAY);
    expect(model.rows.map((r) => r.id)).toEqual(['issued']);
    expect(model.totals).toBeNull();
    expect(JSON.stringify(model)).not.toMatch(/Secret|Someone else/);
  });

  it('lets only the addressee acknowledge, only an issued letter that asks, and not in the sample company', () => {
    const asking = letter({ id: 'a', employee_id: 'seed-emp-5', ack_requested: true });
    const read = letter({ id: 'r', employee_id: 'seed-emp-5', ack_requested: true, acknowledged_at: '2026-10-01T03:00:00Z' });
    const model = buildLettersModel([asking, read], HR_5, TODAY);
    const row = (id: string) => model.rows.find((r) => r.id === id)!;
    expect(row('a')).toMatchObject({ can_acknowledge: true, awaiting_acknowledgement: true });
    expect(row('r')).toMatchObject({ can_acknowledge: false, awaiting_acknowledgement: false, acknowledged_label: 'Acknowledged on 01 Oct 2026' });
    // An owner viewing a letter addressed to someone else cannot.
    const owner: PeopleViewer = { employeeId: 'seed-emp-9', isHr: true, isDemo: false };
    expect(buildLettersModel([asking], owner, TODAY).rows[0].can_acknowledge).toBe(false);
    // The sample company.
    const demoLetter = letter({ id: 'd', ack_requested: true });
    const demo = buildLettersModel([demoLetter], DEMO, TODAY);
    expect(demo.rows[0]).toMatchObject({ awaiting_acknowledgement: true, can_acknowledge: false });
  });

  it('works out the controls of a draft and of an issued letter for an owner', () => {
    const letters = [
      letter({ id: 'ok', status: 'draft', issued_on: null }),
      letter({ id: 'blank', status: 'draft', issued_on: null, body: ' \n\t ' }),
      letter({ id: 'holes', status: 'draft', issued_on: null, title: 'For {employee_name}', body: 'You are {designation} from {join_date}. {designation} {salary}' }),
      letter({ id: 'issued', status: 'issued' }),
    ];
    const model = buildLettersModel(letters, HR_5, TODAY);
    expect(model.can_manage).toBe(true);
    const row = (id: string) => model.rows.find((r) => r.id === id)!;
    expect(row('ok')).toMatchObject({ unfilled: [], can_edit: true, can_delete: true, can_issue: true, can_unissue: false });
    expect(row('blank')).toMatchObject({ unfilled: [], can_issue: false, can_edit: true });
    expect(row('holes')).toMatchObject({ unfilled: ['employee_name', 'designation', 'join_date', 'salary'], can_issue: false, can_edit: true });
    expect(row('issued')).toMatchObject({ unfilled: [], can_edit: false, can_delete: false, can_issue: false, can_unissue: true });
  });

  it('gives an owner who sits in the sample company no controls', () => {
    const owner: PeopleViewer = { employeeId: DEMO_EMPLOYEE_ID, isHr: true, isDemo: true };
    const model = buildLettersModel([letter({ status: 'draft', issued_on: null })], owner, TODAY);
    expect(model.can_manage).toBe(false);
    expect(model.rows[0]).toMatchObject({ can_edit: false, can_delete: false, can_issue: false, can_unissue: false });
  });

  it('carries the text and the type label of each letter', () => {
    const model = buildLettersModel([letter({ letter_type: 'contract_renewal', body: 'The text.' })], HR_5, TODAY);
    expect(model.rows[0]).toMatchObject({ type_label: 'Contract renewal', letter_type: 'contract_renewal', body: 'The text.' });
  });

  it('builds from no rows', () => {
    const model = buildLettersModel([], HR_5, TODAY);
    expect(model.totals).toEqual({ issued_this_year: 0, drafts: 0, issued_this_month: 0 });
    expect(model.by_type).toEqual([]);
    expect(model.rows).toEqual([]);
  });
});

describe('Letter templates model', () => {
  const templates = [template({ id: 'b', name: 'B', letter_type: 'warning', lang: 'ms' }), template({ id: 'a', name: 'A' })];

  it('lists them by name for an owner or admin', () => {
    const model = buildLetterTemplatesModel(templates, HR_5);
    if (!model.allowed) throw new Error('expected rows');
    expect(model.can_manage).toBe(true);
    expect(model.rows.map((r) => r.name)).toEqual(['A', 'B']);
    expect(model.rows[1].type_label).toBe('Warning');
    // Each row says the language its dates and salary are written in.
    expect(model.rows.map((r) => [r.lang, r.lang_label])).toEqual([['en', 'English'], ['ms', 'Bahasa Malaysia']]);
  });
  it('shows the sample company read-only, and a member nothing', async () => {
    expect(buildLetterTemplatesModel(await data.listLetterTemplates(), DEMO)).toMatchObject({ allowed: true, can_manage: false });
    expect(buildLetterTemplatesModel(templates, MEMBER)).toEqual({ allowed: false });
  });
});

describe('Settings', () => {
  it('shows the stored values read-only', async () => {
    const model = await loadSettingsModel(data, HR_5);
    if (model.hr_only) throw new Error('expected settings');
    expect(model.working_days).toBe('Mon–Fri');
    expect(model.attendance).toEqual({
      work_week: ['mon', 'tue', 'wed', 'thu', 'fri'],
      work_start_time: '09:00',
      late_grace_minutes: 15,
    });
    expect(model.annual_leave_days).toBe('14');
    expect(model.medical_leave_days).toBe('14');
    expect(model.emergency_leave_days).toBe('3');
    expect(model.overtime.map((o) => o.value)).toEqual(['1.5x', '2x', '3x']);
    expect(model.notifications.map((n) => n.on)).toEqual([true, true, true, false]);
  });

  it('reads nothing for a plain member', async () => {
    let reads = 0;
    const spy: PeopleData = {
      ...data,
      getSettings: async () => {
        reads += 1;
        return data.getSettings();
      },
    };
    expect(await loadSettingsModel(spy, MEMBER)).toEqual({ hr_only: true });
    expect(reads).toBe(0);
  });

  it('treats empty notifications as off and labels the working week', () => {
    const model = buildSettingsModel(SETTINGS);
    if (model.hr_only) throw new Error('expected settings');
    expect(model.notifications.every((n) => !n.on)).toBe(true);
    expect(model.annual_leave_days).toBe('14.5');
    expect(model.medical_leave_days).toBe('14');
    expect(model.emergency_leave_days).toBe('3');
    expect(model.attendance.work_week).toEqual(SETTINGS.work_week);
    expect(model.attendance.work_week).not.toBe(SETTINGS.work_week);
    expect(workWeekLabel(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'])).toBe('Mon–Sat');
    expect(workWeekLabel(['mon', 'wed'])).toBe('Mon, Wed');
    expect(workWeekLabel([])).toBe('—');
  });
});
