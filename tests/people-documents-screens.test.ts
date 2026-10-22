import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRODUCTS, badgeAriaLabel, getProduct } from '@/config/nav';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { awaitingAcknowledgementCount } from '@/lib/people/awaiting-count';
import { buildMyDocumentsModel } from '@/lib/people/documents';
import {
  ACK_NOTE,
  CHOOSE_FILE,
  LINK_FAILED,
  RELOAD_HINT,
  ackDetail,
  awaitingTotal,
  documentFormDefaults,
  documentTypeOptions,
  downloadSlot,
  downloadStep,
  employeeDocumentRows,
  myDocumentsControls,
  myRowAckDetail,
  myRowStatus,
  planDocumentForm,
  removeForSentence,
  removeMineSentence,
  safeCount,
  saveOutcome,
  shouldReadAwaiting,
  showsEmployeeDocumentsAction,
  showsOwnerDocumentControls,
} from '@/lib/people/documents-screens';
import { createSeedPeopleData } from '@/lib/people/seed';
import { DEMO_EMPLOYEE_ID, type HrDocument, type PeopleViewer } from '@/lib/people/types';
import { TOO_BIG, WRONG_TYPE } from '@/lib/people/document-files';

const viewers: Record<string, PeopleViewer> = {
  owner: { isHr: true, isDemo: false, employeeId: 'e1' },
  admin: { isHr: true, isDemo: false, employeeId: null },
  member: { isHr: false, isDemo: false, employeeId: 'e2' },
  unlinked: { isHr: false, isDemo: false, employeeId: null },
  // A viewer-role user maps to isHr false (can(role, 'approve') is false): the same shape as a member. Kept as its own
  // case so a change to that mapping shows here, but it is not a different viewer.
  viewerRoleSameShapeAsMember: { isHr: false, isDemo: false, employeeId: 'e3' },
  demoVisitor: { isHr: false, isDemo: true, employeeId: 'e4' },
  demoOwner: { isHr: true, isDemo: true, employeeId: 'e5' },
  signedOut: { isHr: false, isDemo: false, employeeId: null },
};

describe('showsOwnerDocumentControls', () => {
  it('is true only for an owner or an admin outside the demo', () => {
    const shown = Object.entries(viewers)
      .filter(([, v]) => showsOwnerDocumentControls(v))
      .map(([k]) => k);
    expect(shown).toEqual(['owner', 'admin']);
  });
  it('is false for a missing or malformed viewer', () => {
    expect(showsOwnerDocumentControls(null)).toBe(false);
    expect(showsOwnerDocumentControls(undefined)).toBe(false);
    expect(showsOwnerDocumentControls({ isHr: 'yes', isDemo: false } as never)).toBe(false);
    expect(showsOwnerDocumentControls({ isHr: true } as never)).toBe(false);
  });
});

describe('showsEmployeeDocumentsAction', () => {
  it('needs owner controls, the documents loaded and a workspace id', () => {
    expect(showsEmployeeDocumentsAction(true, {}, 'org')).toBe(true);
    expect(showsEmployeeDocumentsAction(false, {}, 'org')).toBe(false);
    expect(showsEmployeeDocumentsAction(true, null, 'org')).toBe(false);
    expect(showsEmployeeDocumentsAction(true, {}, null)).toBe(false);
    expect(showsEmployeeDocumentsAction(true, {}, '')).toBe(false);
  });
});

const doc = (over: Partial<HrDocument> = {}): HrDocument => ({
  id: 'd1',
  employee_id: 'e2',
  employee_name: 'Aina',
  title: 'Passport',
  doc_type: 'identity',
  expires_on: null,
  file_name: 'passport.pdf',
  file_size: 2048,
  file_type: 'application/pdf',
  source: 'employee',
  ack_requested: false,
  acknowledged_at: null,
  created_at: '2026-10-01T02:00:00Z',
  has_file: true,
  ...over,
});

describe('myDocumentsControls: the Upload control', () => {
  const modelFor = (viewer: PeopleViewer) =>
    buildMyDocumentsModel({ documents: [], letters: [], payslips: [], today: '2026-10-12', viewer });

  it('is drawn only for a linked member outside the demo with a workspace', () => {
    const shown = Object.entries(viewers)
      .filter(([, v]) => myDocumentsControls(v, modelFor(v), 'org').upload)
      .map(([k]) => k);
    expect(shown).toEqual(['owner', 'member', 'viewerRoleSameShapeAsMember']);
  });
  it('is not drawn in the demo, whoever looks', () => {
    for (const key of ['demoVisitor', 'demoOwner']) {
      expect(myDocumentsControls(viewers[key], modelFor(viewers[key]), 'org').upload, key).toBe(false);
    }
  });
  it('is not drawn when nothing loaded, or there is no workspace id', () => {
    expect(myDocumentsControls(viewers.member, null, 'org').upload).toBe(false);
    expect(myDocumentsControls(viewers.member, modelFor(viewers.member), null).upload).toBe(false);
    expect(myDocumentsControls(null, modelFor(viewers.member), 'org').upload).toBe(false);
  });
});

describe('the sample company on My Documents', () => {
  it('has no acknowledge, download or remove on any row of any employee, and says there is no file', async () => {
    const data = createSeedPeopleData();
    const documents = await data.listDocuments();
    const letters = await data.listLetters();
    const rows = [...new Set(documents.map((d) => d.employee_id))].flatMap((employeeId) => {
      const model = buildMyDocumentsModel({
        documents,
        letters,
        payslips: [],
        today: '2026-10-12',
        viewer: { isHr: false, isDemo: true, employeeId },
      });
      return model.linked ? model.rows : [];
    });
    expect(rows.length).toBeGreaterThan(0);
    // The sample set does ask for an acknowledgement (Code of conduct), and still offers no button for it.
    expect(rows.some((r) => r.awaiting_acknowledgement)).toBe(true);
    for (const row of rows) {
      expect(row.can_acknowledge).toBe(false);
      expect(row.can_download).toBe(false);
      expect(row.can_remove).toBe(false);
    }
    const sampleDocuments = rows.filter((r) => r.kind === 'document');
    expect(sampleDocuments.length).toBeGreaterThan(0);
    for (const row of sampleDocuments) expect(downloadSlot(row)).toBe('no-file');
  });
});

describe('downloadSlot', () => {
  it('is the button for a file, the sample sentence for none, and nothing for letters and payslips', () => {
    expect(downloadSlot({ kind: 'document', can_download: true, no_file_label: null })).toBe('download');
    expect(downloadSlot({ kind: 'document', can_download: false, no_file_label: 'Sample document, no file' })).toBe('no-file');
    expect(downloadSlot({ kind: 'document', can_download: false, no_file_label: null })).toBe('none');
    expect(downloadSlot({ kind: 'letter', can_download: false, no_file_label: null })).toBe('none');
    expect(downloadSlot({ kind: 'payslip', can_download: true, no_file_label: 'x' })).toBe('none');
  });
});

describe('ackDetail', () => {
  it('words the three states and nothing else', () => {
    expect(ackDetail('Acknowledged on 12 Oct 2026')).toBe('Acknowledged on 12 Oct 2026');
    expect(ackDetail(null, true)).toBe('Awaiting acknowledgement');
    expect(ackDetail('Waiting for the employee')).toBe('Awaiting acknowledgement');
    expect(ackDetail('Not asked')).toBeNull();
    expect(ackDetail('Read on 12 Oct 2026')).toBe('Read on 12 Oct 2026'); // passed through, never reworded
    expect(ackDetail(null)).toBeNull();
    expect(ackDetail('')).toBeNull();
  });
  it('says awaiting before anything else', () => {
    expect(ackDetail('Acknowledged on 1 Oct 2026', true)).toBe('Awaiting acknowledgement');
  });
});

describe('myRowStatus', () => {
  it('puts the acknowledgement first, then the expiry', () => {
    expect(myRowStatus({ awaiting_acknowledgement: true, can_acknowledge: true, expiry: 'expired' }).label).toBe('Needs your acknowledgement');
    expect(myRowStatus({ awaiting_acknowledgement: false, can_acknowledge: false, expiry: 'expired' })).toEqual({ tone: 'bad', label: 'Expired' });
    expect(myRowStatus({ awaiting_acknowledgement: false, can_acknowledge: false, expiry: 'expiring' }).label).toBe('Expiring soon');
    expect(myRowStatus({ awaiting_acknowledgement: false, can_acknowledge: false, expiry: 'none' }).label).toBe('Available');
  });
  it('states a sample row that asks as a neutral fact, not addressed to the visitor', () => {
    const sample = myRowStatus({ awaiting_acknowledgement: true, can_acknowledge: false, expiry: 'none' });
    expect(sample).toEqual({ tone: 'pending', label: 'Acknowledgement requested' });
  });
  it('shows the "Awaiting acknowledgement" line only where the viewer can act on it', () => {
    expect(myRowAckDetail({ awaiting_acknowledgement: true, can_acknowledge: true, acknowledged_label: null })).toBe('Awaiting acknowledgement');
    expect(myRowAckDetail({ awaiting_acknowledgement: true, can_acknowledge: false, acknowledged_label: null })).toBeNull();
    expect(myRowAckDetail({ awaiting_acknowledgement: false, can_acknowledge: false, acknowledged_label: 'Acknowledged on 1 Oct 2026' })).toBe('Acknowledged on 1 Oct 2026');
  });
  it('reads the demo visitor\'s sample rows neutrally and a linked member\'s rows unchanged', async () => {
    const data = createSeedPeopleData();
    const input = { documents: await data.listDocuments(), letters: await data.listLetters(), payslips: await data.listPayslips(), today: '2026-10-12' };
    const demo = buildMyDocumentsModel({ ...input, viewer: { isHr: false, isDemo: true, employeeId: DEMO_EMPLOYEE_ID } });
    if (!demo.linked) throw new Error('expected linked');
    const asking = demo.rows.filter((r) => r.awaiting_acknowledgement);
    expect(asking.map((r) => r.kind).sort()).toEqual(['document', 'letter']);
    for (const r of asking) {
      expect(myRowStatus(r).label).toBe('Acknowledgement requested');
      expect(myRowAckDetail(r)).toBeNull();
      expect(r.can_acknowledge).toBe(false);
    }
    expect(demo.awaiting_acknowledgement).toBe(0);
  });
});

describe('the form', () => {
  const values = { title: 'Passport', doc_type: 'identity', expires_on: '' };
  const pdf = new File([new Uint8Array(10)], 'p.pdf', { type: 'application/pdf' });

  it('offers four types to an employee and seven to an owner', () => {
    expect(documentTypeOptions(false).map((o) => o.value)).toEqual(['identity', 'medical', 'certificate', 'other']);
    expect(documentTypeOptions(true)).toHaveLength(7);
    expect(documentTypeOptions(false)[0].label).toBeTruthy();
  });
  it('opens blank on the first type offered, or on the row being edited', () => {
    expect(documentFormDefaults(null, false)).toEqual({ title: '', doc_type: 'identity', expires_on: '' });
    expect(documentFormDefaults(null, true).doc_type).toBe('contract');
    expect(documentFormDefaults({ title: 'T', doc_type: 'tax', expires_on: '2027-01-01' }, true)).toEqual({
      title: 'T',
      doc_type: 'tax',
      expires_on: '2027-01-01',
    });
  });
  it('add: needs fields, then a file, and checks the file before anything is uploaded', () => {
    const ok = planDocumentForm({ mode: 'add', values, file: pdf, owner: false });
    expect(ok.ok && ok.input.fields).toEqual({ title: 'Passport', doc_type: 'identity', expires_on: null });
    expect(ok.ok && ok.input.file).toBe(pdf);
    expect(planDocumentForm({ mode: 'add', values, file: null, owner: false })).toEqual({ ok: false, error: CHOOSE_FILE });
    expect(planDocumentForm({ mode: 'add', values: { ...values, title: '  ' }, file: pdf, owner: false }).ok).toBe(false);
    const wrong = new File([new Uint8Array(3)], 'x.exe', { type: 'application/x-msdownload' });
    expect(planDocumentForm({ mode: 'add', values, file: wrong, owner: false })).toEqual({ ok: false, error: WRONG_TYPE });
    const big = { name: 'b.pdf', type: 'application/pdf', size: 11 * 1024 * 1024 } as File;
    expect(planDocumentForm({ mode: 'add', values, file: big, owner: false })).toEqual({ ok: false, error: TOO_BIG });
  });
  it('an employee cannot pick an owner-only type; an owner can', () => {
    const contract = { ...values, doc_type: 'contract' };
    expect(planDocumentForm({ mode: 'add', values: contract, file: pdf, owner: false }).ok).toBe(false);
    expect(planDocumentForm({ mode: 'add', values: contract, file: pdf, owner: true }).ok).toBe(true);
  });
  it('edit: fields only, no file asked for or returned', () => {
    const plan = planDocumentForm({ mode: 'edit', values, file: pdf, owner: true });
    expect(plan.ok && plan.input.file).toBeNull();
    expect(plan.ok && plan.input.fields?.title).toBe('Passport');
    expect(planDocumentForm({ mode: 'edit', values: { ...values, title: '' }, file: null, owner: true }).ok).toBe(false);
  });
  it('replace: a file only, the fields ignored', () => {
    const plan = planDocumentForm({ mode: 'replace', values: { title: '', doc_type: 'x', expires_on: 'nope' }, file: pdf, owner: true });
    expect(plan.ok && plan.input.fields).toBeNull();
    expect(plan.ok && plan.input.file).toBe(pdf);
    expect(planDocumentForm({ mode: 'replace', values, file: null, owner: true })).toEqual({ ok: false, error: CHOOSE_FILE });
  });
});

describe('saveOutcome', () => {
  it('done on success', () => {
    expect(saveOutcome({ ok: true, data: 1 })).toEqual({ done: true });
  });
  it('shows a definite refusal as its own sentence and allows a retry', () => {
    expect(saveOutcome({ ok: false, error: 'That file could not be attached. Upload it again.' })).toEqual({
      done: false,
      message: 'That file could not be attached. Upload it again.',
      reload: false,
    });
  });
  it('an unknown outcome asks for a reload, not a retry', () => {
    const out = saveOutcome({ ok: false, error: WRITE_FAILED });
    expect(out).toEqual({ done: false, message: `${WRITE_FAILED} ${RELOAD_HINT}`, reload: true });
  });
});

describe('downloadStep', () => {
  it('opens the link when there is one', () => {
    expect(downloadStep({ ok: true, data: { url: 'https://x.test/a' } })).toEqual({ action: 'open', url: 'https://x.test/a' });
  });
  it('fails with the sentence of the refusal, or ours when there is none', () => {
    expect(downloadStep({ ok: false, error: 'That document could not be found.' })).toEqual({
      action: 'fail',
      message: 'That document could not be found.',
    });
    expect(downloadStep({ ok: false, error: '  ' })).toEqual({ action: 'fail', message: LINK_FAILED });
    expect(downloadStep(null)).toEqual({ action: 'fail', message: LINK_FAILED });
    expect(downloadStep({ ok: true, data: { url: '' } })).toEqual({ action: 'fail', message: LINK_FAILED });
    expect(downloadStep({ ok: true, data: {} as never })).toEqual({ action: 'fail', message: LINK_FAILED });
  });
});

describe('sentences', () => {
  it('keep the exact acknowledgement line and never call it a signature', () => {
    expect(ACK_NOTE).toBe('This records that you have read it. It is not a signature.');
    expect(removeMineSentence('Passport')).toContain('"Passport"');
    expect(removeForSentence('Passport')).toContain('its file');
  });
});

describe('employeeDocumentRows (the Documents action)', () => {
  const docs = [
    doc({ id: 'a', employee_id: 'e2', source: 'hr', title: 'Contract', doc_type: 'contract' }),
    doc({ id: 'b', employee_id: 'e2', source: 'employee', title: 'IC' }),
    doc({ id: 'c', employee_id: 'e9', title: 'Elsewhere' }),
  ];
  const input = (viewer: PeopleViewer) => ({ documents: docs, employeeIds: ['e2', 'e3', 'e9'], today: '2026-10-12', viewer });

  it('gives an owner or admin each employee their own rows, and an empty list when they have none', () => {
    for (const key of ['owner', 'admin']) {
      const rows = employeeDocumentRows(input(viewers[key]))!;
      expect(rows.e2.map((r) => r.id).sort()).toEqual(['a', 'b']);
      expect(rows.e3).toEqual([]);
      expect(rows.e9.map((r) => r.id)).toEqual(['c']);
    }
  });
  it('says who uploaded and the acknowledgement state on each row', () => {
    const rows = employeeDocumentRows(input(viewers.owner))!.e2;
    expect(rows.find((r) => r.id === 'a')?.added_by_label).toBe('Added by HR');
    expect(rows.find((r) => r.id === 'b')?.added_by_label).toBe('Uploaded by the employee');
  });
  it('gives everyone else nothing at all, so nothing is read or drawn', () => {
    for (const key of ['member', 'unlinked', 'viewerRoleSameShapeAsMember', 'demoVisitor', 'demoOwner', 'signedOut']) {
      expect(employeeDocumentRows(input(viewers[key])), key).toBeNull();
    }
  });
});

describe('the navigation badge figure', () => {
  it('reads only for a member of a real workspace', () => {
    expect(shouldReadAwaiting({ isDemo: false, orgId: 'o' })).toBe(true);
    expect(shouldReadAwaiting({ isDemo: true, orgId: 'o' })).toBe(false);
    expect(shouldReadAwaiting({ isDemo: false, orgId: null })).toBe(false);
    expect(shouldReadAwaiting({ isDemo: false, orgId: '' })).toBe(false);
  });
  it('turns anything that is not a count into 0', () => {
    expect(safeCount(3)).toBe(3);
    expect(safeCount(2.9)).toBe(2);
    for (const bad of [null, undefined, NaN, -1, Infinity, '4', {}]) expect(safeCount(bad), String(bad)).toBe(0);
    expect(awaitingTotal(2, 1)).toBe(3);
    expect(awaitingTotal(null, 4)).toBe(4);
    expect(awaitingTotal(undefined, undefined)).toBe(0);
  });
  it('is on My Documents, worded for a screen reader, and on no other item but the two existing', () => {
    const item = getProduct('people')!.sections.flatMap((s) => s.items).find((i) => i.slug === 'my-documents');
    expect(item?.badge).toBe('awaitingAcknowledgement');
    expect(badgeAriaLabel(3, item?.badgeLabel)).toBe('3 awaiting your acknowledgement');
    const announcements = getProduct('people')!.sections.flatMap((s) => s.items).find((i) => i.slug === 'announcements');
    expect(announcements?.badge).toBe('unreadAnnouncements');
    const badged = PRODUCTS.flatMap((p) => p.sections.flatMap((s) => s.items)).filter((i) => i.badge);
    // Exactly these: the agents proposals, the two People ones, the five approval queues' waiting counts and the
    // swaps asking the person to reply (on Shift Calendar).
    expect(badged.map((i) => `${i.slug}:${i.badge}`).sort()).toEqual(
      [
        'agents:pendingCrmProposals',
        'agents:pendingProposals',
        'announcements:unreadAnnouncements',
        'my-documents:awaitingAcknowledgement',
        'approve-leave:waitingLeave',
        'approve-claims:waitingClaims',
        'approve-overtime:waitingOvertime',
        'approve-time-off:waitingTimeOff',
        'approve-shift-swaps:waitingSwaps',
        'shift-calendar:waitingSwapReplies',
      ].sort(),
    );
  });
});

// ---- The count query ------------------------------------------------------------------

type Call = { table: string; columns: string; filters: [string, string, unknown][]; head: boolean };

/** A client whose queries record what was asked and answer from `answers` by table (letters and documents apart). */
function fakeClient(answers: Record<string, { data?: unknown; count?: number | null; error?: { code: string } | null } | 'throw'>) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, columns: '', filters: [], head: false };
      calls.push(call);
      const chain: Record<string, unknown> = {
        select(cols: string, opts?: { head?: boolean }) {
          call.columns = cols;
          call.head = opts?.head === true;
          return chain;
        },
        eq(col: string, value: unknown) {
          call.filters.push(['eq', col, value]);
          return chain;
        },
        is(col: string, value: unknown) {
          call.filters.push(['is', col, value]);
          return chain;
        },
        maybeSingle() {
          return Promise.resolve(answer());
        },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          return Promise.resolve(answer()).then(resolve, reject);
        },
      };
      const answer = () => {
        const a = answers[table];
        if (a === 'throw') throw new Error('boom');
        return { data: a?.data ?? null, count: a?.count ?? null, error: a?.error ?? null };
      };
      return chain;
    },
  };
  return { client: client as never, calls };
}

describe('awaitingAcknowledgementCount', () => {
  afterEach(() => vi.restoreAllMocks());

  it('counts the viewer’s own HR-added documents and issued letters awaiting acknowledgement, in two head queries', async () => {
    const { client, calls } = fakeClient({ hr_documents: { count: 2 }, hr_letters: { count: 1 } });
    expect(await awaitingAcknowledgementCount({ client, orgId: 'org-1' }, 'user-1')).toBe(3);
    expect(calls.map((c) => c.table).sort()).toEqual(['hr_documents', 'hr_letters']);
    const letters = calls.find((c) => c.table === 'hr_letters')!;
    const documents = calls.find((c) => c.table === 'hr_documents')!;
    expect(letters.head && documents.head).toBe(true);
    // Their own rows only, through an inner embed of their own employee row (named by its foreign key).
    expect(documents.columns).toContain('hr_employees!hr_documents_employee_id_org_id_fkey!inner(user_id)');
    expect(letters.columns).toContain('hr_employees!hr_letters_employee_id_org_id_fkey!inner(user_id)');
    for (const call of [letters, documents]) {
      expect(call.filters).toContainEqual(['eq', 'hr_employees.user_id', 'user-1']);
      expect(call.filters).toContainEqual(['eq', 'org_id', 'org-1']);
      expect(call.filters).toContainEqual(['eq', 'ack_requested', true]);
      expect(call.filters).toContainEqual(['is', 'acknowledged_at', null]);
    }
    expect(letters.filters).toContainEqual(['eq', 'status', 'issued']);
    expect(documents.filters).toContainEqual(['eq', 'source', 'hr']);
    expect(letters.filters.some(([, col]) => col === 'source')).toBe(false);
  });
  it('is 0 when the viewer has no employee row (the inner join matches nothing)', async () => {
    expect(await awaitingAcknowledgementCount({ client: fakeClient({ hr_documents: { count: 0 }, hr_letters: { count: 0 } }).client, orgId: 'o' }, 'u')).toBe(0);
  });
  it('reads a failure as 0, logging the code only', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeClient({
      hr_documents: { count: null, error: { code: '42501' } },
      hr_letters: { count: 4 },
    });
    expect(await awaitingAcknowledgementCount({ client, orgId: 'o' }, 'user-secret')).toBe(4);
    const text = log.mock.calls.flat().join(' ');
    expect(text).toContain('42501');
    expect(text).not.toContain('user-secret');
  });
  it('never throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const partial = fakeClient({ hr_documents: 'throw', hr_letters: { count: 2 } });
    expect(await awaitingAcknowledgementCount({ client: partial.client, orgId: 'o' }, 'u')).toBe(2);
    const both = fakeClient({ hr_documents: 'throw', hr_letters: 'throw' });
    expect(await awaitingAcknowledgementCount({ client: both.client, orgId: 'o' }, 'u')).toBe(0);
  });
});

// ---- Files ----------------------------------------------------------------------------

function reachable(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    seen.set(file, source);
    for (const m of source.matchAll(/(?:import|export)\s[^;]*?from\s+'([^']+)'|import\s+'([^']+)'/g)) {
      const spec = m[1] ?? m[2];
      const base = spec.startsWith('@/') ? join(resolve('src'), spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(file), spec) : null;
      if (!base) continue;
      const found = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((e) => base + e).find((p) => existsSync(p));
      if (found) queue.push(found);
    }
  }
  return seen;
}

const exportedFrom = (file: string) =>
  readFileSync(resolve(file), 'utf8')
    .split('\n')
    .map((line) => /^export async function (\w+)/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));

const DOC_ACTIONS = resolve('src/app/(app)/people/document-actions.ts');
const LETTER_ACTIONS = resolve('src/app/(app)/people/letter-actions.ts');
const OWN_ACTIONS = [
  'addMyDocumentAction',
  'removeMyDocumentAction',
  'acknowledgeDocumentAction',
  'acknowledgeLetterAction',
  'documentLinkAction',
];
const ALL_ACTIONS = [...exportedFrom('src/app/(app)/people/document-actions.ts'), ...exportedFrom('src/app/(app)/people/letter-actions.ts')];
const OWNER_ONLY = ALL_ACTIONS.filter((name) => !OWN_ACTIONS.includes(name));

describe('the member components name no owner-only action', () => {
  it('reads a real list of actions from the modules', () => {
    for (const name of OWN_ACTIONS) expect(ALL_ACTIONS).toContain(name);
    expect(OWNER_ONLY.length).toBeGreaterThanOrEqual(10);
    expect(OWNER_ONLY).toContain('addDocumentForAction');
    expect(OWNER_ONLY).toContain('requestDocumentAckAction');
  });
  // document-form.tsx is shared with the owner list; it takes the owner's actions as props and imports none of them.
  for (const entry of [
    'src/screens/people/my-documents.tsx',
    'src/components/people/document-row.tsx',
    'src/components/people/document-download.tsx',
    'src/components/people/acknowledge-button.tsx',
    'src/components/people/document-form.tsx',
  ]) {
    it(`${entry} and what it imports name no owner-only action`, () => {
      const graph = reachable(resolve(entry));
      expect(graph.size).toBeGreaterThan(2);
      for (const [file, source] of graph) {
        if (file === DOC_ACTIONS || file === LETTER_ACTIONS) continue;
        for (const name of OWNER_ONLY) expect(source, `${file} names ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
      }
    });
  }
  it('the components that import an action take only the own ones', () => {
    for (const entry of [
      'src/components/people/document-row.tsx',
      'src/components/people/document-download.tsx',
      'src/components/people/acknowledge-button.tsx',
      'src/components/people/document-form.tsx',
    ]) {
      const source = readFileSync(resolve(entry), 'utf8');
      const imported = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*(?:document|letter)-actions'/g)].flatMap((m) =>
        m[1].split(',').map((x) => x.trim()).filter(Boolean),
      );
      for (const name of imported) expect(OWN_ACTIONS, `${entry} imports ${name}`).toContain(name);
    }
  });
});

describe('the screens use these decisions, with static imports only', () => {
  const read = (file: string) => readFileSync(resolve(file), 'utf8');
  it('My Documents decides the Upload control with myDocumentsControls and draws no disabled sample', () => {
    const screen = read('src/screens/people/my-documents.tsx');
    expect(screen).toContain('myDocumentsControls(');
    expect(screen).not.toContain('LaterButton');
    expect(screen).not.toMatch(/import\('/);
  });
  it('Employees decides the Documents action with showsEmployeeDocumentsAction and employeeDocumentRows', () => {
    expect(read('src/components/people/employees-table.tsx')).toContain('showsEmployeeDocumentsAction(');
    const screen = read('src/screens/people/employees.tsx');
    expect(screen).toContain('employeeDocumentRows(');
    expect(screen).not.toMatch(/import\('/);
  });
  it('Employees asks showsOwnerDocumentControls at every site instead of repeating the rule', () => {
    const screen = read('src/screens/people/employees.tsx');
    expect(screen).toContain('showsOwnerDocumentControls(');
    expect(screen).not.toMatch(/isHr\s*&&\s*!\S*isDemo/);
    // The third site (canEdit for the table and departments) now goes through employeesControls, which asks
    // showsOwnerDocumentControls once for the whole screen, so the rule is still decided in one place.
    expect(screen.match(/showsOwnerDocumentControls\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(screen).toContain('employeesControls(viewer)');
    expect(read('src/lib/people/employees.ts')).toMatch(/const canEdit = showsOwnerDocumentControls\(viewer\);/);
  });
  it('the Request / Withdraw explanation is text tied to the button, not only a title attribute', () => {
    const owner = read('src/components/people/employee-documents.tsx');
    expect(owner).not.toMatch(/title=\{(requestAckSentence|withdrawAckSentence)/);
    expect(owner).toMatch(/aria-describedby=/);
    expect(owner).toMatch(/requestAckSentence\(name\)/);
    expect(owner).toMatch(/withdrawAckSentence\(\)/);
  });
  it('a Remove confirmation moves focus to Keep, and dismissing it returns focus to Remove', () => {
    for (const file of ['document-row.tsx', 'employee-documents.tsx']) {
      const source = read(`src/components/people/${file}`);
      expect(source, file).toMatch(/keepRef/);
      expect(source, file).toMatch(/removeRefs?\b/);
      expect(source, file).toMatch(/keepRef\.current\??\.focus\(\)/);
      expect(source, file).toMatch(/removeRefs?\.current(\[id\])?\??\.focus\(\)/);
    }
  });
  it('the owner list is the only place the owner document actions are named', () => {
    const owner = read('src/components/people/employee-documents.tsx');
    for (const name of ['addDocumentForAction', 'updateDocumentAction', 'replaceDocumentFileAction', 'removeDocumentAction', 'requestDocumentAckAction']) {
      expect(owner, name).toContain(name);
    }
    expect(owner).not.toMatch(/import\('/);
  });
  it('the layout reads the count only through shouldReadAwaiting and sets the badge by name', () => {
    const layout = read('src/app/(app)/people/layout.tsx');
    expect(layout).toContain('shouldReadAwaiting(');
    expect(layout).toContain('name="awaitingAcknowledgement"');
    expect(layout).toContain('name="unreadAnnouncements"');
  });
  it('no component draws a link or a path', () => {
    for (const file of ['document-download.tsx', 'document-row.tsx', 'employee-documents.tsx', 'document-form.tsx']) {
      const source = read(`src/components/people/${file}`);
      expect(source, file).not.toMatch(/console\./);
      expect(source, file).not.toMatch(/href=\{[^}]*url/i);
    }
  });
});
