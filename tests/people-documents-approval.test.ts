import { describe, expect, it, vi } from 'vitest';
import type { SavedDocument } from '@/lib/people/document-writes';
import type { SavedLetter } from '@/lib/people/letter-writes';
import type { HrDocument, Letter, LetterTemplate, PeopleData } from '@/lib/people/types';

const executed = vi.hoisted(() => ({
  counts: {} as Record<string, number>,
  last: null as unknown,
  tool: 'saveLetter',
  input: {} as object | string,
  /** What the model was shown after the approval: the tool messages of its last prompt. */
  shown: [] as unknown[],
  /** When set, every write path answers with this refusal sentence. */
  fail: null as string | null,
  /** When set, requestLetterAck answers with this letter instead of the fixed draft. */
  ackData: null as unknown,
}));

const bump = (name: string, input: unknown) => {
  executed.counts[name] = (executed.counts[name] ?? 0) + 1;
  executed.last = input;
};

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const DRAFT = '55555555-5555-4555-8555-555555555551';
const ISSUED = '55555555-5555-4555-8555-555555555552';
const TEMPLATE = '55555555-5555-4555-8555-555555555553';
const DOC_HR = '55555555-5555-4555-8555-555555555554';
const DOC_EMP = '55555555-5555-4555-8555-555555555555';
const USER = '99999999-9999-4999-8999-999999999999';
const GONE = '55555555-5555-4555-8555-5555555555ff';

const savedDraft: SavedLetter = {
  id: DRAFT, employee_id: A, letter_type: 'warning', title: 'Amaran', body: 'Dear {employee_name}, take note of {today}.', status: 'draft',
  issued_on: null, ack_requested: true, acknowledged_at: null,
};
const savedDoc: SavedDocument = {
  id: DOC_HR, employee_id: A, title: 'Passport', doc_type: 'identity', expires_on: null, file_name: 'scan.pdf', file_size: 10, file_type: 'application/pdf',
  source: 'hr', ack_requested: true, acknowledged_at: null, created_at: '2026-09-01T02:00:00.000Z',
};

vi.mock('@/lib/people/letter-writes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/people/letter-writes')>();
  const record = (name: string, data: unknown) => async (_ctx: unknown, input: unknown) => {
    bump(name, input);
    if (executed.fail) return { ok: false as const, error: executed.fail };
    return { ok: true as const, data };
  };
  return {
    ...actual,
    saveLetter: record('saveLetter', savedDraft),
    startLetterFromTemplate: record('startLetterFromTemplate', { letter: savedDraft, unfilled: ['designation'] }),
    requestLetterAck: async (_ctx: unknown, input: unknown) => {
      bump('requestLetterAck', input);
      if (executed.fail) return { ok: false as const, error: executed.fail };
      return { ok: true as const, data: executed.ackData ?? savedDraft };
    },
    issueLetter: record('issueLetter', { ...savedDraft, status: 'issued', issued_on: '2026-10-09' }),
  };
});

vi.mock('@/lib/people/document-writes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/people/document-writes')>();
  return {
    ...actual,
    requestDocumentAck: async (_ctx: unknown, input: unknown) => {
      bump('requestDocumentAck', input);
      if (executed.fail) return { ok: false as const, error: executed.fail };
      return { ok: true as const, data: savedDoc };
    },
  };
});

vi.mock('@/lib/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/provider')>();
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  return {
    ...actual,
    getModel: () =>
      new MockLanguageModelV4({
        doStream: async (options: { prompt: { role: string }[] }) => {
          const resumed = options.prompt.some((m) => m.role === 'tool');
          if (resumed) executed.shown = options.prompt.filter((m) => m.role === 'tool');
          const chunks: Record<string, unknown>[] = resumed
            ? [
                { type: 'text-start', id: 'a' },
                { type: 'text-delta', id: 'a', delta: 'Done.' },
                { type: 'text-end', id: 'a' },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
              ]
            : [
                { type: 'tool-call', toolCallId: 't1', toolName: executed.tool, input: typeof executed.input === 'string' ? executed.input : JSON.stringify(executed.input) },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
              ];
          return { stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }) };
        },
      } as unknown as ConstructorParameters<typeof MockLanguageModelV4>[0]) as never,
  };
});

const { runLekiu } = await import('@/lib/ai/agents/orchestrator');
// After this file's mocks and the values they use are in place: the helpers load the tools too.
const { withLekiu } = await import('./helpers/approvals');
const { createPeopleTools } = await import('@/lib/ai/people-tools');
const { createSeedPeopleData } = await import('@/lib/people/seed');
const { approvalDetail, approvalTitle, nameIn } = await import('@/lib/chat/change-titles');

const NOW = new Date('2026-10-09T04:00:00Z');
const seed = createSeedPeopleData(NOW);
const [first] = await seed.listEmployees();
const people = [
  { ...first, id: A, name: 'Aisyah Rahim' },
  { ...first, id: B, name: 'Farid Hamzah' },
];
const letterRow = (patch: Partial<Letter>): Letter => ({
  id: DRAFT, employee_id: A, employee_name: 'Aisyah Rahim', letter_type: 'warning', title: 'Amaran', body: 'Dear {employee_name}, take note of {today}.',
  status: 'draft', issued_on: null, ack_requested: true, acknowledged_at: null, created_at: '2026-09-02T02:00:00.000Z', ...patch,
});
const docRow = (patch: Partial<HrDocument>): HrDocument => ({
  id: DOC_HR, employee_id: A, employee_name: 'Aisyah Rahim', title: 'Passport', doc_type: 'identity', expires_on: null, file_name: 'scan.pdf', file_size: 10,
  file_type: 'application/pdf', source: 'hr', ack_requested: false, acknowledged_at: null, created_at: '2026-09-01T02:00:00.000Z', has_file: true, ...patch,
});
const template: LetterTemplate = { id: TEMPLATE, name: 'Offer letter', letter_type: 'offer', title: 'Offer of employment', body: 'Dear {employee_name}', lang: 'en' };
const data: PeopleData = {
  ...seed,
  listEmployees: async () => people,
  listLetters: async () => [
    letterRow({}),
    letterRow({ id: ISSUED, employee_id: B, employee_name: 'Farid Hamzah', title: 'Pengesahan', letter_type: 'confirmation', body: 'Confirmed.', status: 'issued', issued_on: '2026-09-20', ack_requested: false }),
  ],
  listDocuments: async () => [
    docRow({}),
    docRow({ id: DOC_EMP, employee_id: B, employee_name: 'Farid Hamzah', title: 'Medical note', doc_type: 'medical', source: 'employee' }),
  ],
  listLetterTemplates: async () => [template],
};

const ctx = { client: {} as never, orgId: 'org1' };
const asOwner = { data, viewer: { employeeId: null, isHr: true, isDemo: false }, write: { ctx, tier: 'hr' as const, employeeId: null, receipt: null, userId: USER } };
const asMember = { data, viewer: { employeeId: A, isHr: false, isDemo: false }, write: { ctx, tier: 'self' as const, employeeId: A, receipt: null, userId: USER } };
const asUnlinkedMember = { data, viewer: { employeeId: null, isHr: false, isDemo: false }, write: { ctx, tier: 'self' as const, employeeId: null, receipt: null, userId: USER } };
const asViewerRole = { data, viewer: { employeeId: A, isHr: false, isDemo: false }, write: undefined };
const asDemoOwner = { data, viewer: { employeeId: null, isHr: true, isDemo: true }, write: undefined };
const ask = [{ role: 'user' as const, content: 'Please' }];

// The orchestrator logs one line per model call, some after a test has finished; it is not what these tests are about.
vi.spyOn(console, 'log').mockImplementation(() => {});

const reset = (tool: string, input: object | string) => {
  Object.assign(executed, { counts: {}, last: null, shown: [], fail: null, ackData: null, tool, input });
};
const ran = (name: string) => executed.counts[name] ?? 0;
const total = () => Object.values(executed.counts).reduce((sum, n) => sum + n, 0);

type Case = { tool: string; write: string; sent: object | string; saved: unknown; card: string; detail: string | null };

const BODY = 'Dear Aisyah,\n\nPlease note the matter we discussed.  ';
const SAVE_CARD = `Save a draft letter for this employee, type Warning, titled “Amaran”: “${BODY}”?`;
const UNLISTED_DOC = 'Ask for an acknowledgement of a document that was not in the list above?';

/** What the model sends (extra arguments, empty strings and nulls included), and what must reach the write path. */
const CASES: Case[] = [
  {
    tool: 'saveLetter', write: 'saveLetter',
    sent: { employee_id: A, letter_id: '', letter_type: 'warning', title: ' Amaran ', body: BODY, ack_requested: null, status: 'issued', extra: 1 },
    saved: { employee_id: A, letter_id: null, letter_type: 'warning', title: 'Amaran', body: BODY, ack_requested: false },
    card: SAVE_CARD, detail: 'A draft: the employee cannot see it yet.',
  },
  {
    tool: 'saveLetter', write: 'saveLetter',
    sent: { employee_id: A, letter_type: 'offer', title: 'Offer', body: null, ack_requested: true, letter_id: null },
    saved: { employee_id: A, letter_id: null, letter_type: 'offer', title: 'Offer', body: '', ack_requested: true },
    card: 'Save a draft letter for this employee, type Offer, titled “Offer”: no text yet, asking them to acknowledge it?', detail: 'A draft: the employee cannot see it yet.',
  },
  {
    // The request was on in the database and the model said nothing: it is kept, not switched off.
    tool: 'saveLetter', write: 'saveLetter',
    sent: { employee_id: A, letter_id: DRAFT, letter_type: 'warning', title: 'Amaran', body: 'New text.' },
    saved: { employee_id: A, letter_id: DRAFT, letter_type: 'warning', title: 'Amaran', body: 'New text.', ack_requested: true },
    card: 'Change a letter that was not in the list above for this employee to type Warning, titled “Amaran”: “New text.”, leaving the acknowledgement request as it is?',
    detail: 'A draft: the employee cannot see it yet.',
  },
  {
    tool: 'saveLetter', write: 'saveLetter',
    sent: { employee_id: A, letter_id: DRAFT, letter_type: 'warning', title: 'Amaran', body: 'New text.', ack_requested: false },
    saved: { employee_id: A, letter_id: DRAFT, letter_type: 'warning', title: 'Amaran', body: 'New text.', ack_requested: false },
    card: 'Change a letter that was not in the list above for this employee to type Warning, titled “Amaran”: “New text.”, not asking them to acknowledge it?',
    detail: 'A draft: the employee cannot see it yet.',
  },
  {
    tool: 'startLetterFromTemplate', write: 'startLetterFromTemplate', sent: { employee_id: A, template_id: TEMPLATE, extra: 1, letter_id: DRAFT },
    saved: { employee_id: A, template_id: TEMPLATE },
    card: 'Start a draft letter for this employee from a template that was not in the list above?',
    detail: 'A draft: the employee cannot see it yet. The template\'s placeholders are filled in from their record, and any that cannot be filled are left in the text.',
  },
  {
    tool: 'issueLetter', write: 'issueLetter', sent: { letter_id: DRAFT, force: true, employee_id: B }, saved: { letter_id: DRAFT },
    card: 'Issue a letter that was not in the list above? Nothing in this chat shows its text, so it cannot be shown here.',
    detail: 'The employee will be able to see it.',
  },
  {
    tool: 'requestAcknowledgement', write: 'requestDocumentAck', sent: { document_id: DOC_HR, letter_id: '', requested: true, x: 1 },
    saved: { document_id: DOC_HR, requested: true }, card: UNLISTED_DOC,
    detail: 'They can mark it as read on their My Documents page. This records that they have read it; it is not a signature.',
  },
  {
    tool: 'requestAcknowledgement', write: 'requestDocumentAck', sent: { document_id: DOC_HR, letter_id: null, requested: false },
    saved: { document_id: DOC_HR, requested: false }, card: 'Withdraw the acknowledgement request on a document that was not in the list above?',
    detail: 'Any acknowledgement already recorded is cleared.',
  },
  {
    // A letter: one write that changes the request and nothing else (the database leaves the text alone).
    tool: 'requestAcknowledgement', write: 'requestLetterAck', sent: { letter_id: DRAFT, document_id: '', requested: false, title: 'Injected', body: 'Injected' },
    saved: { letter_id: DRAFT, requested: false },
    card: 'Withdraw the acknowledgement request on a letter that was not in the list above?', detail: 'A draft: the employee will not be asked when it is issued.',
  },
  {
    tool: 'requestAcknowledgement', write: 'requestLetterAck', sent: { letter_id: DRAFT, requested: true },
    saved: { letter_id: DRAFT, requested: true },
    card: 'Ask for an acknowledgement of a letter that was not in the list above?', detail: 'A draft: the employee will be asked when it is issued.',
  },
];

type Part = { type: string; toolCallId?: string; toolName?: string; input?: unknown; approvalId?: string };

const history = (call: Part, request: Part, approved: boolean) => [
  ...ask,
  {
    role: 'assistant' as const,
    content: [
      { type: 'tool-call' as const, toolCallId: call.toolCallId!, toolName: call.toolName!, input: call.input },
      { type: 'tool-approval-request' as const, approvalId: request.approvalId!, toolCallId: call.toolCallId! },
    ],
  },
  { role: 'tool' as const, content: [{ type: 'tool-approval-response' as const, approvalId: request.approvalId!, approved }] },
];

type People = typeof asOwner | typeof asMember;
const firstTurn = async (c: Pick<Case, 'tool' | 'sent'>, people: People = asOwner) => {
  reset(c.tool, c.sent);
  const first = runLekiu(...withLekiu(ask, people));
  await first.consumeStream();
  const parts = (await first.content) as Part[];
  return { parts, call: parts.find((p) => p.type === 'tool-call'), request: parts.find((p) => p.type === 'tool-approval-request') };
};

const rows = CASES.map((c) => [c.tool, JSON.stringify(c.sent), c] as const);

describe('Lekiu’s letter and acknowledgement changes require approval', () => {
  it.each(rows)('%s sent as %s: a card appears first and nothing is written until it is approved', async (_tool, _sent, c) => {
    const { call, request } = await firstTurn(c);
    expect(total()).toBe(0);
    expect(call?.toolName).toBe(c.tool);
    expect(request).toBeDefined();
    // The card shows what will be saved, read through the SDK's own input parsing (extra arguments dropped).
    expect(approvalTitle(c.tool, call?.input)).toBe(c.card);
    expect(approvalDetail(c.tool, call?.input)).toBe(c.detail);
    for (const dropped of ['extra', 'x', 'force', 'status', 'employee_id_of_other']) {
      if (!(dropped in (c.sent as object))) continue;
      expect(call?.input, dropped).not.toHaveProperty(dropped);
    }
  });

  it.each(rows)('%s sent as %s: once approved, the write runs exactly once with the normalised values', async (_tool, _sent, c) => {
    const { call, request } = await firstTurn(c);
    expect(call).toBeDefined();
    expect(request).toBeDefined();
    const second = runLekiu(...withLekiu(history(call!, request!, true), asOwner));
    await second.consumeStream();
    expect(ran(c.write)).toBe(1);
    expect(total()).toBe(1);
    expect(executed.last).toEqual(c.saved);
    expect(await second.text).toBe('Done.');
  });

  it.each(rows)('%s sent as %s: rejecting it writes nothing and the turn continues', async (_tool, _sent, c) => {
    const { call, request } = await firstTurn(c);
    const second = runLekiu(...withLekiu(history(call!, request!, false), asOwner));
    await second.consumeStream();
    expect(total()).toBe(0);
    expect(await second.text).toBe('Done.');
  });

  it('every tool has at least one row', () => {
    expect([...new Set(CASES.map((c) => c.tool))].sort()).toEqual(['issueLetter', 'requestAcknowledgement', 'saveLetter', 'startLetterFromTemplate']);
  });

  it.each([
    ['saveLetter', { employee_id: A, letter_type: 'warning', title: '   ', body: 'x' }],
    ['saveLetter', { employee_id: A, letter_type: 'warning', title: '', body: 'x' }],
    ['saveLetter', { employee_id: A, letter_type: 'warning', title: 'x'.repeat(201), body: 'x' }],
    ['saveLetter', { employee_id: A, letter_type: 'memo', title: 'x', body: 'x' }],
    ['saveLetter', { employee_id: A, letter_type: '', title: 'x', body: 'x' }],
    ['saveLetter', { employee_id: A, title: 'x', body: 'x' }],
    ['saveLetter', { employee_id: A, letter_type: 'warning', title: 'x', body: 'x'.repeat(10001) }],
    ['saveLetter', { employee_id: A, letter_type: 'warning', title: 'x', body: 5 }],
    ['saveLetter', { employee_id: A, letter_id: DRAFT, letter_type: 'warning', title: 'x' }],
    ['saveLetter', { employee_id: A, letter_id: DRAFT, letter_type: 'warning', title: 'x', body: null }],
    ['saveLetter', { employee_id: A, letter_type: 'warning', title: 'x', body: 'x', ack_requested: 'yes' }],
    ['saveLetter', { employee_id: A, letter_type: 'warning', title: 'x', body: 'x', letter_id: 'nope' }],
    ['saveLetter', { employee_id: A, letter_type: 'warning', title: 'x', body: 'x', letter_id: 5 }],
    ['saveLetter', { employee_id: '', letter_type: 'warning', title: 'x', body: 'x' }],
    ['saveLetter', { employee_id: 'Aisyah', letter_type: 'warning', title: 'x', body: 'x' }],
    ['saveLetter', { letter_type: 'warning', title: 'x', body: 'x' }],
    ['startLetterFromTemplate', { employee_id: A, template_id: '' }],
    ['startLetterFromTemplate', { employee_id: A, template_id: 'Offer letter' }],
    ['startLetterFromTemplate', { employee_id: '', template_id: TEMPLATE }],
    ['startLetterFromTemplate', { template_id: TEMPLATE }],
    ['issueLetter', { letter_id: '' }],
    ['issueLetter', { letter_id: 5 }],
    ['issueLetter', {}],
    ['issueLetter', ''],
    ['requestAcknowledgement', { document_id: DOC_HR, letter_id: DRAFT, requested: true }],
    ['requestAcknowledgement', { requested: true }],
    ['requestAcknowledgement', { document_id: '', letter_id: '', requested: true }],
    ['requestAcknowledgement', { document_id: null, letter_id: null, requested: true }],
    ['requestAcknowledgement', { document_id: DOC_HR }],
    ['requestAcknowledgement', { document_id: DOC_HR, requested: 'yes' }],
    ['requestAcknowledgement', { document_id: DOC_HR, requested: null }],
    ['requestAcknowledgement', { document_id: 'passport', requested: true }],
    ['requestAcknowledgement', { document_id: 5, requested: true }],
    ['requestAcknowledgement', { letter_id: {}, requested: true }],
  ])('%s with %j is refused by the schema before any card', async (tool, sent) => {
    const { request } = await firstTurn({ tool, sent });
    expect(total()).toBe(0);
    expect(request).toBeUndefined();
  });

  it.each(['saveLetter', 'startLetterFromTemplate', 'issueLetter', 'requestAcknowledgement'].map((tool) => [tool] as const))(
    '%s is not a tool of a member, an unlinked member, a viewer or the demo: no card and no write even if the model asks',
    async (tool) => {
      const sent = CASES.find((c) => c.tool === tool)!.sent;
      for (const who of [asMember, asUnlinkedMember, asViewerRole, asDemoOwner]) {
        const { request } = await firstTurn({ tool, sent }, who as unknown as People);
        expect(total()).toBe(0);
        expect(request).toBeUndefined();
      }
    },
  );

  it('a result carries no path and no link, and a letter result names the person and carries the whole letter', async () => {
    const tools = createPeopleTools(data, asOwner.viewer, NOW, asOwner.write);
    const exec = (name: string, input: object) =>
      (tools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<{ ok: true; data: Record<string, unknown> }> }).execute(input, { toolCallId: 't', messages: [] });
    const ack = await exec('requestAcknowledgement', { document_id: DOC_HR, requested: true });
    expect(JSON.stringify(ack)).not.toMatch(/file_name|file_path|"path"|https?:|scan\.pdf|storage/i);
    expect(ack.data).toMatchObject({ item: 'document', employee: 'Aisyah Rahim', title: 'Passport', acknowledgement: 'awaiting' });
    const saved = await exec('saveLetter', { employee_id: A, letter_type: 'warning', title: 'Amaran', body: 'x' });
    expect(saved.data).toMatchObject({
      id: DRAFT, employee: 'Aisyah Rahim', body: savedDraft.body, status: 'draft', placeholders_left: ['employee_name', 'today'],
    });
    expect(saved.data.message).toContain('{employee_name}, {today}');
    const started = await exec('startLetterFromTemplate', { employee_id: A, template_id: TEMPLATE });
    expect(started.data).toMatchObject({ employee: 'Aisyah Rahim', unfilled: ['designation'] });
  });
});

describe('the card, read with a finder built from the REAL lookups and changes, names the person and states the whole letter', () => {
  // The lookup tools are run for real against the fixture, and their output is passed on exactly as the chat does.
  const tools = createPeopleTools(data, asOwner.viewer, NOW, asOwner.write);
  const exec = async (name: string, input: object = {}) =>
    (tools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, { toolCallId: 't', messages: [] });
  const result = async (name: string, input: object = {}) => ({ tool: name, output: await exec(name, input) });

  it('names the person from listDocuments, listLetters and listEmployees alone', async () => {
    expect(nameIn([await result('listDocuments')])(A, 'employee')).toBe('Aisyah Rahim');
    expect(nameIn([await result('listLetters')])(B, 'employee')).toBe('Farid Hamzah');
    expect(nameIn([await result('listEmployees')])(A, 'employee')).toBe('Aisyah Rahim');
  });

  it('names the person from the real result of an earlier change in the same chat', async () => {
    for (const [name, input] of [
      ['saveLetter', { employee_id: A, letter_type: 'warning', title: 'Amaran', body: 'x' }],
      ['startLetterFromTemplate', { employee_id: A, template_id: TEMPLATE }],
      ['issueLetter', { letter_id: DRAFT }],
      ['requestAcknowledgement', { document_id: DOC_HR, requested: true }],
    ] as const) {
      expect(nameIn([await result(name, input)])(A, 'employee'), name).toBe('Aisyah Rahim');
    }
  });

  it('every card names the person, the type, the title and the whole body', async () => {
    const lookups = [await result('listLetters'), await result('listDocuments'), await result('listLetterTemplates')];
    const find = nameIn(lookups);
    expect(approvalTitle('saveLetter', { employee_id: A, letter_type: 'warning', title: 'Amaran', body: BODY }, find)).toBe(
      `Save a draft letter for Aisyah Rahim, type Warning, titled “Amaran”: “${BODY}”?`,
    );
    expect(approvalTitle('startLetterFromTemplate', { employee_id: B, template_id: TEMPLATE }, find)).toBe(
      'Start a draft letter for Farid Hamzah from the template “Offer letter”?',
    );
    expect(approvalTitle('issueLetter', { letter_id: ISSUED }, find)).toBe(
      'Issue the letter to Farid Hamzah, type Confirmation, titled “Pengesahan”: “Confirmed.”?',
    );
    expect(approvalTitle('requestAcknowledgement', { document_id: DOC_HR, requested: true }, find)).toBe('Ask Aisyah Rahim to acknowledge the document “Passport”?');
    expect(approvalTitle('requestAcknowledgement', { letter_id: DRAFT, requested: true }, find)).toBe('Ask Aisyah Rahim to acknowledge the letter “Amaran”?');
    expect(approvalDetail('requestAcknowledgement', { document_id: DOC_EMP, requested: true }, undefined, find)).toContain(
      'The employee uploaded this document themselves, so this is likely to be refused.',
    );
  });

  it('an issue card for a draft the real lookup shows with a placeholder says it will be refused, and which', async () => {
    const find = nameIn([await result('listLetters')]);
    expect(approvalDetail('issueLetter', { letter_id: DRAFT }, undefined, find)).toBe(
      'The employee will be able to see it. They will be asked to acknowledge it. It still has {employee_name} and {today} in it, so this is likely to be refused until they are replaced. This is the text as last shown in this chat; the letter is issued as it is saved now.',
    );
  });

  it('an issue card follows a real change made after the lookup', async () => {
    const real = await result('listLetters');
    // An older lookup that disagrees with what the change then saved: the newest must win, so the two can be told apart.
    const old = {
      tool: 'listLetters',
      output: { letters: (real.output as { letters: Record<string, unknown>[] }).letters.map((l) => (l.id === DRAFT ? { ...l, title: 'Old title', body: 'Old body' } : l)) },
    };
    const change = await result('saveLetter', { employee_id: A, letter_type: 'warning', title: 'Amaran', body: 'x' });
    const find = nameIn([old, change]);
    const card = approvalTitle('issueLetter', { letter_id: DRAFT }, find);
    expect(card).toContain('Issue the letter to Aisyah Rahim');
    expect(card).toContain(`“Amaran”: “${savedDraft.body}”`);
    expect(card).not.toContain('Old');
    // And the other way round: a lookup after the change is newer again.
    expect(approvalTitle('issueLetter', { letter_id: DRAFT }, nameIn([change, old]))).toContain('“Old title”: “Old body”');
  });

  it('a card names the person from the id when the result that holds the letter named nobody', async () => {
    const nameless = { tool: 'saveLetter', output: { ok: true, data: { id: DRAFT, employee_id: A, letter_type: 'warning', title: 'Amaran', body: 'Text.', status: 'draft', ack_requested: false } } };
    const find = nameIn([await result('listEmployees'), nameless]);
    expect(approvalTitle('issueLetter', { letter_id: DRAFT }, find)).toBe('Issue the letter to Aisyah Rahim, type Warning, titled “Amaran”: “Text.”?');
    expect(approvalTitle('requestAcknowledgement', { letter_id: DRAFT, requested: true }, find)).toBe('Ask Aisyah Rahim to acknowledge the letter “Amaran”?');
  });
});

describe('what the model is told when the write path refuses', () => {
  const refuse = async (c: Pick<Case, 'tool' | 'sent'>, sentence: string, people: People = asOwner) => {
    const { call, request } = await firstTurn(c, people);
    executed.fail = sentence;
    const second = runLekiu(...withLekiu(history(call!, request!, true), people));
    await second.consumeStream();
    return JSON.stringify(executed.shown);
  };

  it.each([
    ['saveLetter', CASES[0].sent, 'That letter has been issued. Pull it back to draft on the Letters screen to change it.', 'saveLetter'],
    ['startLetterFromTemplate', CASES[4].sent, 'That letter could not be found.', 'startLetterFromTemplate'],
    ['issueLetter', CASES[5].sent, 'The letter still has a placeholder in it. Replace it before issuing.', 'issueLetter'],
    ['issueLetter', CASES[5].sent, 'The letter has no text yet.', 'issueLetter'],
    ['requestAcknowledgement', CASES[6].sent, 'That document could not be found.', 'requestDocumentAck'],
    ['requestAcknowledgement', CASES[9].sent, 'That letter has been issued. Pull it back to draft on the Letters screen to change it.', 'requestLetterAck'],
    ['requestAcknowledgement', CASES[9].sent, 'That letter could not be found.', 'requestLetterAck'],
  ])('%s: a refusal reaches the model as its sentence', async (tool, sent, sentence, write) => {
    const shown = await refuse({ tool, sent }, sentence);
    expect(shown).toContain(sentence);
    expect(ran(write)).toBe(1);
  });

  it('applies the server-recorded letter id and flag in one write; an approval carrying a flipped flag writes nothing', async () => {
    const { proposedBefore } = await import('./helpers/approvals');
    const c = { tool: 'requestAcknowledgement', sent: { letter_id: DRAFT, requested: false } };
    const { call, request } = await firstTurn(c);
    const proposed = history(call!, request!, true);
    const binding = proposedBefore(proposed);
    // The approval comes back with the flag flipped: refused, nothing written.
    const tampered = history({ ...call!, input: { letter_id: DRAFT, requested: true } }, request!, true);
    const refused = runLekiu(tampered, asOwner, undefined, undefined, binding);
    await refused.consumeStream();
    expect(total()).toBe(0);
    // The approval as proposed is applied once, with the recorded id and flag, and no letter is read or saved.
    const applied = runLekiu(history(call!, request!, true), asOwner, undefined, undefined, proposedBefore(proposed));
    await applied.consumeStream();
    expect(ran('requestLetterAck')).toBe(1);
    expect(total()).toBe(1);
    expect(executed.last).toEqual({ letter_id: DRAFT, requested: false });
  });

  it('does not read the letters to ask for an acknowledgement', async () => {
    const listLetters = vi.fn(async () => { throw new TypeError('SECRET BODY'); });
    const unreadable = { ...asOwner, data: { ...data, listLetters } };
    const { call, request } = await firstTurn({ tool: 'requestAcknowledgement', sent: { letter_id: DRAFT, requested: true } }, unreadable);
    const second = runLekiu(...withLekiu(history(call!, request!, true), unreadable));
    await second.consumeStream();
    expect(ran('requestLetterAck')).toBe(1);
    expect(listLetters).not.toHaveBeenCalled();
  });

  it('a requestAcknowledgement result for a letter carries the whole letter, so a later issue card states the whole body and the newest request', async () => {
    const tools = createPeopleTools(data, asOwner.viewer, NOW, asOwner.write);
    const exec = async (name: string, input: object) =>
      (tools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, { toolCallId: 't', messages: [] });
    const saved = { tool: 'saveLetter', output: await exec('saveLetter', { employee_id: A, letter_type: 'warning', title: 'Amaran', body: savedDraft.body }) };
    const bigBody = `Opening words.\n${'x'.repeat(9000)} Closing words`;
    const issueDetail = (results: { tool: string; output: unknown }[]) => approvalDetail('issueLetter', { letter_id: DRAFT }, undefined, nameIn(results)) ?? '';

    // Asked: the newest fact holds the long body and the request.
    executed.ackData = { ...savedDraft, body: bigBody, ack_requested: true };
    const asked = { tool: 'requestAcknowledgement', output: await exec('requestAcknowledgement', { letter_id: DRAFT, requested: true }) };
    expect(approvalTitle('issueLetter', { letter_id: DRAFT }, nameIn([saved, asked]))).toBe(
      `Issue the letter to Aisyah Rahim, type Warning, titled “Amaran”: “${bigBody}”?`,
    );
    expect(approvalTitle('issueLetter', { letter_id: DRAFT }, nameIn([asked]))).toContain('Closing words”');
    expect(issueDetail([saved, asked])).toContain('They will be asked to acknowledge it.');

    // Withdrawn: the newest fact says no request is made, whatever the earlier one said.
    executed.ackData = { ...savedDraft, body: bigBody, ack_requested: false };
    const withdrawn = { tool: 'requestAcknowledgement', output: await exec('requestAcknowledgement', { letter_id: DRAFT, requested: false }) };
    expect((withdrawn.output as { data: { ack_requested: boolean } }).data.ack_requested).toBe(false);
    expect(issueDetail([saved, asked, withdrawn])).not.toContain('asked to acknowledge');
    expect(approvalTitle('issueLetter', { letter_id: DRAFT }, nameIn([saved, asked, withdrawn]))).toContain('Closing words”');

    // The card before approval is built from the earlier facts alone.
    expect(approvalDetail('requestAcknowledgement', { letter_id: DRAFT, requested: true }, undefined, nameIn([saved]))).toBe(
      'A draft: the employee will be asked when it is issued.',
    );
  });

  it('saveLetter on a draft id the read does not return keeps no request: it saves with ack_requested false', async () => {
    const c = { tool: 'saveLetter', sent: { employee_id: A, letter_id: GONE, letter_type: 'warning', title: 'T', body: 'B' } };
    const { call, request } = await firstTurn(c);
    const second = runLekiu(...withLekiu(history(call!, request!, true), asOwner));
    await second.consumeStream();
    expect(executed.last).toEqual({ employee_id: A, letter_id: GONE, letter_type: 'warning', title: 'T', body: 'B', ack_requested: false });
  });
});
