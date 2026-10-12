import { afterEach, describe, expect, it, vi } from 'vitest';
import { PEOPLE_TOOL_NAMES, createPeopleTools } from '@/lib/ai/people-tools';
import { ALL_PEOPLE_TOOL_NAMES, PEOPLE_WRITE_TOOL_NAMES, peopleProduct } from '@/lib/ai/products';
import { toolMeta } from '@/components/chat/tool-parts';
import { createSeedPeopleData } from '@/lib/people/seed';
import type { HrDocument, Letter, LetterTemplate, PeopleData, PeopleViewer } from '@/lib/people/types';

// A Friday in Kuala Lumpur.
const NOW = new Date('2026-10-09T04:00:00Z');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const HR: PeopleViewer = { employeeId: null, isHr: true, isDemo: false };
const MEMBER: PeopleViewer = { employeeId: A, isHr: false, isDemo: false };
const DEMO: PeopleViewer = { employeeId: null, isHr: true, isDemo: true };
const hrWrite = () => ({ ctx: { client: {} as never, orgId: 'org-1' }, tier: 'hr' as const, employeeId: null, receipt: null, userId: 'u1' });
const selfWrite = () => ({ ctx: { client: {} as never, orgId: 'org-1' }, tier: 'self' as const, employeeId: A, receipt: null, userId: 'u1' });

const base = createSeedPeopleData(NOW);
const [first] = await base.listEmployees();
const people = [
  { ...first, id: A, name: 'Aisyah Rahim' },
  { ...first, id: B, name: 'Farid Hamzah' },
];

const doc = (patch: Partial<HrDocument>): HrDocument => ({
  id: '00000000-0000-4000-8000-000000000001', employee_id: A, employee_name: 'Aisyah Rahim', title: 'Employment contract',
  doc_type: 'contract', expires_on: null, file_name: 'secret-scan-name.pdf', file_size: 1234, file_type: 'application/pdf', source: 'hr',
  ack_requested: false, acknowledged_at: null, created_at: '2026-09-01T02:00:00.000Z', has_file: true, ...patch,
});
const letter = (patch: Partial<Letter>): Letter => ({
  id: '00000000-0000-4000-8000-0000000000a1', employee_id: A, employee_name: 'Aisyah Rahim', letter_type: 'warning', title: 'Amaran',
  body: 'Dear {employee_name}, this is the body.', status: 'draft', issued_on: null, ack_requested: false, acknowledged_at: null,
  created_at: '2026-09-02T02:00:00.000Z', ...patch,
});
const template: LetterTemplate = {
  id: '00000000-0000-4000-8000-0000000000b1', name: 'Offer letter', letter_type: 'offer', title: 'Offer of employment', body: 'Dear {employee_name}',
};

const DOCS: HrDocument[] = [
  doc({ id: '00000000-0000-4000-8000-000000000001', title: 'Employment contract' }),
  doc({ id: '00000000-0000-4000-8000-000000000002', title: 'Passport', doc_type: 'identity', expires_on: '2026-10-01', source: 'employee' }),
  doc({ id: '00000000-0000-4000-8000-000000000003', title: 'Work permit', doc_type: 'identity', expires_on: '2026-12-01', ack_requested: true }),
  doc({ id: '00000000-0000-4000-8000-000000000004', title: 'Code of conduct', ack_requested: true, acknowledged_at: '2026-09-10T02:00:00.000Z' }),
  doc({ id: '00000000-0000-4000-8000-000000000005', title: 'Farid tax form', employee_id: B, employee_name: 'Farid Hamzah', doc_type: 'tax', expires_on: '2027-12-01' }),
];
const LONG_BODY = `Dear Aisyah,\n${'x'.repeat(9900)}`;
const LETTERS: Letter[] = [
  letter({ id: '00000000-0000-4000-8000-0000000000a1', title: 'Draft warning', body: 'Draft body with {today} left.' }),
  letter({ id: '00000000-0000-4000-8000-0000000000a2', title: 'Issued confirmation', letter_type: 'confirmation', body: LONG_BODY, status: 'issued', issued_on: '2026-09-20', ack_requested: true }),
  letter({ id: '00000000-0000-4000-8000-0000000000a3', title: 'Farid draft', employee_id: B, employee_name: 'Farid Hamzah', body: 'SECRET DRAFT FOR FARID' }),
  letter({ id: '00000000-0000-4000-8000-0000000000a4', title: 'Farid issued', employee_id: B, employee_name: 'Farid Hamzah', body: 'Farid issued body', status: 'issued', issued_on: '2026-09-21' }),
];

const dataWith = (patch: Partial<PeopleData> = {}): PeopleData => ({
  ...base,
  listEmployees: async () => people,
  listDocuments: async () => DOCS,
  listLetters: async () => LETTERS,
  listLetterTemplates: async () => [template],
  ...patch,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
const run = (name: string, input: Record<string, unknown>, viewer: PeopleViewer, source = dataWith(), write?: ReturnType<typeof hrWrite>): Promise<Loose> =>
  (createPeopleTools(source, viewer, NOW, write)[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, {
    toolCallId: 't', messages: [],
  });
const describeOf = (name: string, viewer: PeopleViewer, write?: ReturnType<typeof hrWrite>) =>
  (createPeopleTools(dataWith(), viewer, NOW, write)[name] as unknown as { description: string }).description;

afterEach(() => vi.restoreAllMocks());

describe('the document and letter lookups are named, carded and counted', () => {
  it('are in the list of lookups, have a card of their own, and are outside the write list', () => {
    for (const name of ['listDocuments', 'listLetters']) {
      expect(PEOPLE_TOOL_NAMES as readonly string[], name).toContain(name);
      expect(PEOPLE_WRITE_TOOL_NAMES as readonly string[], name).not.toContain(name);
      expect(toolMeta(name).isFallback, name).toBe(false);
    }
    expect(toolMeta('listLetterTemplates').isFallback).toBe(false);
    expect(ALL_PEOPLE_TOOL_NAMES.has('listLetterTemplates')).toBe(true);
  });
  it('lists the four change tools in the write list, once each', () => {
    for (const name of ['saveLetter', 'startLetterFromTemplate', 'issueLetter', 'requestAcknowledgement']) {
      expect(PEOPLE_WRITE_TOOL_NAMES.filter((n) => n === name), name).toHaveLength(1);
      expect(ALL_PEOPLE_TOOL_NAMES.has(name), name).toBe(true);
    }
  });
});

describe('listDocuments', () => {
  it('gives an owner every document with its id, state and who added it, and never a path, a link or a file name', async () => {
    const result = await run('listDocuments', {}, HR, dataWith(), hrWrite());
    expect(result.total).toBe(5);
    expect(result.scope).toBe('everyone in the workspace');
    const passport = result.documents.find((d: Loose) => d.title === 'Passport');
    expect(passport).toMatchObject({
      id: '00000000-0000-4000-8000-000000000002', employee_id: A, employee: 'Aisyah Rahim', doc_type: 'identity', added_on: '2026-09-01',
      expires_on: '2026-10-01', expiry: 'expired', uploaded_by: 'the employee', acknowledgement: 'not_requested',
    });
    expect(result.documents.find((d: Loose) => d.title === 'Work permit')).toMatchObject({ expiry: 'expiring', uploaded_by: 'HR', acknowledgement: 'awaiting' });
    expect(result.documents.find((d: Loose) => d.title === 'Code of conduct')).toMatchObject({ acknowledgement: 'acknowledged', acknowledged_on: '2026-09-10' });
    expect(result.documents.find((d: Loose) => d.title === 'Farid tax form')).toMatchObject({ expiry: 'none' });
    const text = JSON.stringify(result);
    expect(text).not.toContain('secret-scan-name');
    expect(text).not.toMatch(/file_name|file_path|"path"|https?:|signed|storage|has_file/i);
    expect(Object.keys(passport).sort()).toEqual(
      ['acknowledgement', 'added_on', 'doc_type', 'employee', 'employee_id', 'expires_on', 'expiry', 'id', 'title', 'uploaded_by'],
    );
  });

  it('gives totals over the whole set, not over the rows shown', async () => {
    const many = Array.from({ length: 60 }, (_, n) =>
      doc({
        id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`, title: `Doc ${n}`, ack_requested: n % 2 === 0,
        expires_on: n % 3 === 0 ? '2026-10-20' : n % 3 === 1 ? '2026-09-01' : null,
      }),
    );
    const result = await run('listDocuments', { limit: 5 }, HR, dataWith({ listDocuments: async () => many }), hrWrite());
    expect(result.documents).toHaveLength(5);
    expect(result.total).toBe(60);
    expect(result.awaiting_acknowledgement_total).toBe(30);
    expect(result.expiring_total).toBe(20);
    expect(result.expired_total).toBe(20);
  });

  it('narrows by employee and by state, and the totals stay those of the employee', async () => {
    const result = await run('listDocuments', { employee: 'aisyah', filter: 'expired' }, HR, dataWith(), hrWrite());
    expect(result.documents.map((d: Loose) => d.title)).toEqual(['Passport']);
    expect(result.total).toBe(1);
    expect(result.awaiting_acknowledgement_total).toBe(1);
    expect(result.matched_employees).toEqual(['Aisyah Rahim']);
  });

  it('gives a member their own documents only, with no id, whatever rows came back', async () => {
    const result = await run('listDocuments', {}, MEMBER, dataWith(), selfWrite() as never);
    expect(result.scope).toBe('your own records only');
    expect(result.documents.map((d: Loose) => d.title).sort()).toEqual(['Code of conduct', 'Employment contract', 'Passport', 'Work permit']);
    for (const row of result.documents) {
      expect(row).not.toHaveProperty('id');
      expect(row).not.toHaveProperty('employee_id');
    }
    expect(JSON.stringify(result)).not.toContain('Farid');
    expect(result.awaiting_acknowledgement_total).toBe(1);
  });

  it('counts only HR-added documents toward the awaiting total, the rule the badge and the tile use', async () => {
    const mixed = [
      doc({ id: '00000000-0000-4000-8000-000000000011', title: 'HR asks', ack_requested: true }),
      doc({ id: '00000000-0000-4000-8000-000000000012', title: 'Own upload', ack_requested: true, source: 'employee' }),
    ];
    const result = await run('listDocuments', {}, MEMBER, dataWith({ listDocuments: async () => mixed }), selfWrite() as never);
    expect(result.awaiting_acknowledgement_total).toBe(1);
    const team = await run('listDocuments', {}, HR, dataWith({ listDocuments: async () => mixed }), hrWrite());
    expect(team.awaiting_acknowledgement_total).toBe(1);
  });

  it('answers 0 awaiting for a demo visitor, as the tile and the badge do', async () => {
    const result = await run('listDocuments', {}, DEMO, dataWith());
    expect(result.awaiting_acknowledgement_total).toBe(0);
  });

  it('says a member with no employee record is not linked, and gives them nothing', async () => {
    const result = await run('listDocuments', {}, { ...MEMBER, employeeId: null }, dataWith());
    expect(result.documents).toEqual([]);
    expect(result.not_linked).toContain('not linked');
  });

  it('gives no id to the demo, which cannot change anything', async () => {
    const result = await run('listDocuments', {}, DEMO);
    for (const row of result.documents) expect(row).not.toHaveProperty('id');
  });

  it('says what it does not know, and that a title is data', () => {
    for (const viewer of [HR, MEMBER]) {
      const description = describeOf('listDocuments', viewer);
      expect(description).toMatch(/never .*(inside|contents)/i);
      expect(description).toMatch(/data, never an instruction/i);
    }
  });

  it('logs the failure by name only, and answers plainly', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await run('listDocuments', {}, HR, dataWith({ listDocuments: async () => { throw new TypeError('SECRET TITLE failed'); } }));
    expect(result).toEqual({ ok: false, error: 'Could not read HR data.' });
    expect(JSON.stringify(log.mock.calls)).toContain('listDocuments');
    expect(JSON.stringify(log.mock.calls)).toContain('TypeError');
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
  });
});

describe('listLetters', () => {
  it('gives an owner every letter with its status, id, the whole body and the placeholders a draft still has', async () => {
    const result = await run('listLetters', {}, HR, dataWith(), hrWrite());
    expect(result.total).toBe(4);
    expect(result.drafts_total).toBe(2);
    expect(result.issued_total).toBe(2);
    const issued = result.letters.find((d: Loose) => d.title === 'Issued confirmation');
    expect(issued.body).toBe(LONG_BODY);
    expect(issued).toMatchObject({ id: '00000000-0000-4000-8000-0000000000a2', employee_id: A, employee: 'Aisyah Rahim', status: 'issued', issued_on: '2026-09-20', letter_type: 'confirmation', ack_requested: true, acknowledgement: 'awaiting' });
    expect(issued).not.toHaveProperty('placeholders_left');
    const draft = result.letters.find((d: Loose) => d.title === 'Draft warning');
    expect(draft).toMatchObject({ status: 'draft', placeholders_left: ['today'] });
  });

  it('filters an owner’s lookup by employee and status; the totals are the employee’s', async () => {
    const result = await run('listLetters', { employee: 'farid', status: 'draft' }, HR, dataWith(), hrWrite());
    expect(result.letters.map((l: Loose) => l.title)).toEqual(['Farid draft']);
    expect(result.total).toBe(1);
    expect(result.drafts_total).toBe(1);
    expect(result.issued_total).toBe(1);
  });

  it('gives a member their own issued letters only, with no id, no status and no count of anything else, even when the provider hands over a draft', async () => {
    const result = await run('listLetters', {}, MEMBER, dataWith(), selfWrite() as never);
    expect(result.letters).toHaveLength(1);
    expect(result.letters[0]).toEqual({
      letter_type: 'confirmation', title: 'Issued confirmation', body: LONG_BODY, date: '2026-09-20', acknowledgement: 'awaiting',
    });
    expect(result.total).toBe(1);
    const text = JSON.stringify(result);
    for (const leak of ['Draft warning', 'Draft body', 'Farid', 'SECRET DRAFT', 'drafts_total', 'issued_total', 'status', '"id"', 'employee_id']) {
      expect(text, leak).not.toContain(leak);
    }
  });

  it('gives a member the total of their own issued letters awaiting acknowledgement, never counting a draft', async () => {
    const asked = [
      LETTERS[1],
      letter({ id: '00000000-0000-4000-8000-0000000000a5', title: 'Draft that asks', ack_requested: true }),
      letter({ id: '00000000-0000-4000-8000-0000000000a6', title: 'Already read', status: 'issued', issued_on: '2026-09-22', ack_requested: true, acknowledged_at: '2026-09-23T02:00:00.000Z' }),
      LETTERS[3],
    ];
    const result = await run('listLetters', {}, MEMBER, dataWith({ listLetters: async () => asked }), selfWrite() as never);
    expect(result.awaiting_acknowledgement_total).toBe(1);
  });

  it('answers 0 awaiting letters for a demo visitor, as the tile and the badge do', async () => {
    const result = await run('listLetters', {}, DEMO, dataWith({ listLetters: async () => [LETTERS[1]] }));
    expect(result.awaiting_acknowledgement_total).toBe(0);
  });

  it('answers a member with nothing on record by an empty result, not by a hint of why', async () => {
    const onlyDraft = dataWith({ listLetters: async () => [LETTERS[0]] });
    const result = await run('listLetters', {}, MEMBER, onlyDraft);
    expect(result.letters).toEqual([]);
    expect(result.total).toBe(0);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/draft|pending|not ready|unissued|issued only/i);
  });

  it('never describes drafts to a member, in either lookup', () => {
    for (const name of ['listLetters', 'listDocuments']) {
      expect(describeOf(name, MEMBER), name).not.toMatch(/draft|issued only|unissued/i);
      expect(describeOf(name, { ...MEMBER, employeeId: null }), name).not.toMatch(/draft|issued only|unissued/i);
    }
    expect(describeOf('listLetters', HR, hrWrite())).toMatch(/draft/i);
  });

  it('shows the demo its drafts, as the screen does, without ids', async () => {
    const result = await run('listLetters', {}, DEMO);
    expect(result.letters.some((l: Loose) => l.status === 'draft')).toBe(true);
    for (const row of result.letters) expect(row).not.toHaveProperty('id');
  });

  it('logs the failure by name only', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await run('listLetters', {}, HR, dataWith({ listLetters: async () => { throw new RangeError('SECRET BODY'); } }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(log.mock.calls)).toContain('RangeError');
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
  });
});

describe('listLetters is capped, with whole bodies', () => {
  const many = Array.from({ length: 30 }, (_, n) =>
    letter({ id: `00000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`, title: `Letter ${n}`, body: `Body ${n} ${'y'.repeat(500)}`, status: 'issued', issued_on: '2026-09-20' }),
  );
  it('returns at most 10 rows to an owner however many are asked for, each with its whole body; the totals count them all', async () => {
    const result = await run('listLetters', { limit: 50 }, HR, dataWith({ listLetters: async () => many }), hrWrite());
    expect(result.letters).toHaveLength(10);
    expect(result.total).toBe(30);
    expect(result.letters[0].body).toBe(many[0].body);
    expect(result.letters[9].body).toBe(many[9].body);
  });
  it('returns at most 10 rows to a member', async () => {
    const result = await run('listLetters', { limit: 50 }, MEMBER, dataWith({ listLetters: async () => many }));
    expect(result.letters).toHaveLength(10);
    expect(result.total).toBe(30);
  });
  it('says a member’s own upload is theirs', async () => {
    const result = await run('listDocuments', {}, MEMBER);
    expect(result.documents.find((d: Loose) => d.title === 'Passport').uploaded_by).toBe('you');
    expect(result.documents.find((d: Loose) => d.title === 'Employment contract').uploaded_by).toBe('HR');
  });
});

describe('deleteEmployee', () => {
  it('says the employee\'s documents, their files and their letters are deleted too', () => {
    expect(describeOf('deleteEmployee', HR, hrWrite())).toContain('their documents, the files attached to them and their letters');
  });
});

describe('listLetterTemplates', () => {
  it('gives the first 300 characters of a body and its length, not the whole text, and says where the full text is seen', async () => {
    const long = { ...template, body: `Start ${'z'.repeat(1000)}` };
    const result = await run('listLetterTemplates', {}, HR, dataWith({ listLetterTemplates: async () => [long] }), hrWrite());
    expect(result.templates[0].body_chars).toBe(long.body.length);
    expect(result.templates[0].body).toBe(long.body.slice(0, 300));
    expect(describeOf('listLetterTemplates', HR, hrWrite())).toMatch(/full text is seen when a letter is started from the template/i);
  });
  it('is held by an owner or admin with change access, and by nobody else', () => {
    expect(Object.keys(createPeopleTools(dataWith(), HR, NOW, hrWrite()))).toContain('listLetterTemplates');
    expect(Object.keys(createPeopleTools(dataWith(), HR, NOW))).not.toContain('listLetterTemplates');
    expect(Object.keys(createPeopleTools(dataWith(), MEMBER, NOW))).not.toContain('listLetterTemplates');
    expect(Object.keys(createPeopleTools(dataWith(), MEMBER, NOW, selfWrite()))).not.toContain('listLetterTemplates');
    expect(Object.keys(createPeopleTools(dataWith(), DEMO, NOW, hrWrite()))).not.toContain('listLetterTemplates');
  });
  it('gives the name, type, title, the start of the text and the id the draft tool takes', async () => {
    const result = await run('listLetterTemplates', {}, HR, dataWith(), hrWrite());
    expect(result.total).toBe(1);
    expect(result.templates[0]).toEqual({ id: template.id, name: 'Offer letter', letter_type: 'offer', title: 'Offer of employment', body: 'Dear {employee_name}', body_chars: 20 });
  });
});

describe('who holds the four change tools', () => {
  const FOUR = ['saveLetter', 'startLetterFromTemplate', 'issueLetter', 'requestAcknowledgement'];
  it('an owner or admin holds all four, as change tools that wait for approval', () => {
    const kit = peopleProduct({ data: dataWith(), viewer: HR, write: hrWrite() });
    for (const name of FOUR) {
      expect(kit.write, name).toHaveProperty(name);
      expect(kit.read, name).not.toHaveProperty(name);
    }
  });
  it('is absent, not merely refused, for a linked member, an unlinked member, a viewer and the demo', () => {
    const cases: [PeopleViewer, ReturnType<typeof hrWrite> | undefined][] = [
      [MEMBER, selfWrite() as never],
      [{ ...MEMBER, employeeId: null }, { ...selfWrite(), employeeId: null } as never],
      [MEMBER, undefined],
      [DEMO, hrWrite()],
      [DEMO, undefined],
    ];
    for (const [viewer, write] of cases) {
      const names = Object.keys(createPeopleTools(dataWith(), viewer, NOW, write));
      for (const name of FOUR) expect(names, `${name} for ${JSON.stringify(viewer)}`).not.toContain(name);
    }
  });
});
