import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { DOCUMENT_REFUSALS } from '@/lib/people/documents-refusals';

type Reply = { ok: true; data: unknown } | { ok: false; error: string };

const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: '11111111-1111-4111-8111-111111111111', role: 'owner', isDemo: false } as {
    userId: string;
    orgId: string;
    role: string;
    isDemo: boolean;
  },
  people: { employeeId: 'emp-own' as string | null, isHr: true, isDemo: false },
  client: { marker: 'the-signed-in-client' } as unknown,
  reply: null as null | Reply,
  released: true,
  old: '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/abcdef02-aaaa-4bbb-8ccc-0123456789ab.png',
  ran: [] as { fn: string; orgId?: string; client?: unknown; input?: unknown }[],
  order: [] as string[],
  revalidated: [] as string[],
  lookupFails: false,
  lookups: 0,
  clients: 0,
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    ctl.clients += 1;
    return ctl.client;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => ctl.revalidated.push(path) }));
vi.mock('@/lib/people/viewer', () => ({
  getPeopleViewer: async () => {
    ctl.lookups += 1;
    if (ctl.lookupFails) throw new Error('SECRET lookup failure');
    return ctl.people;
  },
}));

const record =
  (fn: string, ok: unknown = { id: 'x' }) =>
  async (ctx: { orgId: string; client: unknown }, input?: unknown): Promise<Reply> => {
    ctl.ran.push({ fn, orgId: ctx.orgId, client: ctx.client, input });
    ctl.order.push(fn);
    return ctl.reply ?? { ok: true, data: ok };
  };
vi.mock('@/lib/people/document-writes', async (orig) => {
  const actual = await orig<typeof import('@/lib/people/document-writes')>();
  return {
    ...actual,
    addDocument: record('addDocument'),
    updateDocument: record('updateDocument'),
    replaceDocumentFile: record('replaceDocumentFile', { document: { id: 'x' }, old_path: ctl.old }),
    removeDocument: record('removeDocument', { id: 'x', employee_id: 'e', path: ctl.old }),
    requestDocumentAck: record('requestDocumentAck'),
    acknowledgeDocument: record('acknowledgeDocument'),
  };
});
vi.mock('@/lib/people/document-files-server', () => ({
  documentLink: async (ctx: { orgId: string; client: unknown }, id: string) => {
    ctl.ran.push({ fn: 'documentLink', orgId: ctx.orgId, client: ctx.client, input: id });
    return ctl.reply ?? { ok: true, data: { url: 'https://example.test/signed?token=t' } };
  },
  releaseDocumentFile: async (ctx: { client: unknown }, path: string) => {
    ctl.ran.push({ fn: 'releaseDocumentFile', client: ctx.client, input: path });
    ctl.order.push('releaseDocumentFile');
    return ctl.released;
  },
  removeDocumentFile: async (path: string) => {
    ctl.ran.push({ fn: 'removeDocumentFile', input: path });
    ctl.order.push('removeDocumentFile');
  },
  removeDocumentFiles: async () => {},
}));

const actions = await import('@/app/(app)/people/document-actions');
const { PEOPLE_PATHS } = await import('@/lib/people/paths');

const ORG = '11111111-1111-4111-8111-111111111111';
const EMP = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';
const NAME = 'abcdef01-aaaa-4bbb-8ccc-0123456789ab';
const PATH = `${ORG}/${EMP}/${NAME}.pdf`;
const OLD = ctl.old;
const ADD = {
  title: 'Passport',
  doc_type: 'identity',
  file_path: PATH,
  file_name: 'p.pdf',
  file_size: 10,
  file_type: 'application/pdf',
};

const DEMO_SENTENCE = 'The sample company is read-only. Sign up to try this with your own team.';
const FORBIDDEN_SENTENCE = 'Only owners and admins can do that.';
const NOT_LINKED_SENTENCE = "Your account isn't linked to an employee record yet.";

const asRole = (role: string) => {
  ctl.viewer = { ...ctl.viewer, role };
  ctl.people = { ...ctl.people, isHr: role === 'owner' || role === 'admin' };
};
const ranFns = () => ctl.ran.map((r) => r.fn);

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: ORG, role: 'owner', isDemo: false };
  ctl.people = { employeeId: 'emp-own', isHr: true, isDemo: false };
  ctl.client = { marker: 'the-signed-in-client' };
  ctl.reply = null;
  ctl.released = true;
  ctl.ran = [];
  ctl.order = [];
  ctl.revalidated = [];
  ctl.lookupFails = false;
  ctl.lookups = 0;
  ctl.clients = 0;
});

// Every action that changes a document, with an input that passes the guards.
const OWNER_ONLY: [string, (input: unknown) => Promise<unknown>, Record<string, unknown>][] = [
  ['addDocumentForAction', actions.addDocumentForAction, { ...ADD, employee_id: EMP }],
  ['updateDocumentAction', actions.updateDocumentAction, { document_id: DOC, title: 'T', doc_type: 'other' }],
  ['replaceDocumentFileAction', actions.replaceDocumentFileAction, { document_id: DOC, file_path: PATH, file_name: 'p.pdf', file_size: 1, file_type: 'application/pdf' }],
  ['removeDocumentAction', actions.removeDocumentAction, { document_id: DOC }],
  ['requestDocumentAckAction', actions.requestDocumentAckAction, { document_id: DOC, requested: true }],
];
const OWN: [string, (input: unknown) => Promise<unknown>, Record<string, unknown>][] = [
  ['addMyDocumentAction', actions.addMyDocumentAction, ADD],
  ['removeMyDocumentAction', actions.removeMyDocumentAction, { document_id: DOC }],
  ['acknowledgeDocumentAction', actions.acknowledgeDocumentAction, { document_id: DOC }],
];

describe('own-record actions', () => {
  it.each(OWN)('%s takes the employee from the viewer, never from the input', async (_name, action, input) => {
    await action({ ...input, employee_id: 'someone-else' });
    const call = ctl.ran.find((r) => !['releaseDocumentFile', 'removeDocumentFile'].includes(r.fn))!;
    const sent = call.input as Record<string, unknown>;
    expect(sent.employee_id === undefined || sent.employee_id === 'emp-own').toBe(true);
    expect(JSON.stringify(call.input)).not.toContain('someone-else');
    expect(call.client).toBe(ctl.client);
    expect(call.orgId).toBe(ORG);
  });

  it('addMyDocumentAction names the viewer\'s own employee, whatever the input says', async () => {
    await actions.addMyDocumentAction({ ...ADD, employee_id: 'someone-else' });
    expect(ctl.ran[0]).toMatchObject({ fn: 'addDocument', input: { employee_id: 'emp-own' } });
  });

  it.each(OWN)('%s refuses an account with no employee record, before any write', async (_name, action, input) => {
    ctl.people = { ...ctl.people, employeeId: null };
    expect(await action(input)).toEqual({ ok: false, error: NOT_LINKED_SENTENCE });
    expect(ctl.ran).toEqual([]);
  });

  it.each(OWN)('%s refuses a demo visitor before any database call', async (_name, action, input) => {
    ctl.viewer = { ...ctl.viewer, isDemo: true };
    expect(await action(input)).toEqual({ ok: false, error: DEMO_SENTENCE });
    expect(ctl.ran).toEqual([]);
    expect(ctl.clients).toBe(0);
  });

  it.each(OWN)('%s refuses a real account whose workspace is the demo', async (_name, action, input) => {
    ctl.people = { ...ctl.people, isDemo: true };
    expect(await action(input)).toEqual({ ok: false, error: DEMO_SENTENCE });
    expect(ctl.ran).toEqual([]);
  });

  it.each(OWN)('%s answers a failed lookup with one sentence that holds no detail', async (_name, action, input) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.lookupFails = true;
    expect(await action(input)).toEqual({ ok: false, error: WRITE_FAILED });
    expect(ctl.ran).toEqual([]);
  });

  it('a member may use them', async () => {
    asRole('member');
    expect((await actions.addMyDocumentAction(ADD) as Reply).ok).toBe(true);
    expect((await actions.acknowledgeDocumentAction({ document_id: DOC }) as Reply).ok).toBe(true);
  });

  it('refreshes the Lekiu pages after a change', async () => {
    await actions.acknowledgeDocumentAction({ document_id: DOC });
    expect(ctl.revalidated).toEqual(PEOPLE_PATHS);
    ctl.revalidated = [];
    ctl.reply = { ok: false, error: 'nope' };
    await actions.acknowledgeDocumentAction({ document_id: DOC });
    expect(ctl.revalidated).toEqual([]);
  });

  it('removing one\'s own upload removes its file after the database, and the reply holds no path', async () => {
    const result = await actions.removeMyDocumentAction({ document_id: DOC });
    expect(ctl.order).toEqual(['removeDocument', 'removeDocumentFile']);
    expect(ctl.ran[1]).toMatchObject({ fn: 'removeDocumentFile', input: OLD });
    expect(result).toEqual({ ok: true, data: { id: 'x', employee_id: 'e' } });
    expect(JSON.stringify(result)).not.toContain(OLD);
  });

  it('a refused remove removes no file', async () => {
    ctl.reply = { ok: false, error: DOCUMENT_REFUSALS.DOC_NOT_FOUND };
    await actions.removeMyDocumentAction({ document_id: DOC });
    expect(ranFns()).toEqual(['removeDocument']);
  });
});

describe('owner and admin actions', () => {
  it.each(OWNER_ONLY)('%s runs for an owner and an admin with the session\'s workspace and client', async (_name, action, input) => {
    for (const role of ['owner', 'admin']) {
      ctl.ran = [];
      asRole(role);
      expect(((await action(input)) as Reply).ok).toBe(true);
      expect(ctl.ran[0]).toMatchObject({ orgId: ORG, client: ctl.client });
    }
  });

  it.each(OWNER_ONLY)('%s refuses a member and a viewer before the client or the viewer is even looked up', async (_name, action, input) => {
    for (const role of ['member', 'viewer']) {
      asRole(role);
      ctl.clients = 0;
      ctl.lookups = 0;
      expect(await action(input)).toEqual({ ok: false, error: FORBIDDEN_SENTENCE });
      expect(ctl.clients).toBe(0);
      expect(ctl.lookups).toBe(0);
      expect(ctl.ran).toEqual([]);
    }
  });

  it.each(OWNER_ONLY)('%s refuses the demo first, even for its admin', async (_name, action, input) => {
    ctl.viewer = { ...ctl.viewer, isDemo: true };
    expect(await action(input)).toEqual({ ok: false, error: DEMO_SENTENCE });
    expect(ctl.ran).toEqual([]);
    expect(ctl.clients).toBe(0);
  });

  it.each(OWNER_ONLY)('%s refuses an account whose workspace turns out to be the demo', async (_name, action, input) => {
    ctl.people = { ...ctl.people, isDemo: true };
    expect(await action(input)).toEqual({ ok: false, error: DEMO_SENTENCE });
    expect(ctl.ran).toEqual([]);
  });

  it('adds for the employee the owner names', async () => {
    await actions.addDocumentForAction({ ...ADD, employee_id: EMP });
    expect(ctl.ran[0]).toMatchObject({ fn: 'addDocument', input: { employee_id: EMP } });
  });

  it('replacing removes the old file only after the database has swapped, and the reply holds no path', async () => {
    const result = await actions.replaceDocumentFileAction({
      document_id: DOC,
      file_path: PATH,
      file_name: 'p.pdf',
      file_size: 1,
      file_type: 'application/pdf',
    });
    expect(ctl.order).toEqual(['replaceDocumentFile', 'removeDocumentFile']);
    expect(ctl.ran[1]).toMatchObject({ input: OLD });
    expect(result).toEqual({ ok: true, data: { id: 'x' } });
    expect(JSON.stringify(result)).not.toContain(OLD);
  });

  it('replacing a document that had no file removes nothing', async () => {
    ctl.reply = { ok: true, data: { document: { id: 'x' }, old_path: null } };
    await actions.replaceDocumentFileAction({ document_id: DOC, file_path: PATH, file_name: 'p.pdf', file_size: 1, file_type: 'application/pdf' });
    expect(ranFns()).toEqual(['replaceDocumentFile']);
  });

  it('removing a document removes its file after the database, and the reply holds no path', async () => {
    const result = await actions.removeDocumentAction({ document_id: DOC });
    expect(ctl.order).toEqual(['removeDocument', 'removeDocumentFile']);
    expect(ctl.ran[1]).toMatchObject({ input: OLD });
    expect(JSON.stringify(result)).not.toContain(OLD);
  });

  it('a refused replace or remove removes no file', async () => {
    ctl.reply = { ok: false, error: DOCUMENT_REFUSALS.DOC_BAD_FILE };
    await actions.removeDocumentAction({ document_id: DOC });
    expect(ranFns()).toEqual(['removeDocument']);
  });
});

describe('a file that was uploaded and not attached', () => {
  it.each([
    ['addMyDocumentAction', actions.addMyDocumentAction, ADD],
    ['addDocumentForAction', actions.addDocumentForAction, { ...ADD, employee_id: EMP }],
    ['replaceDocumentFileAction', actions.replaceDocumentFileAction, { document_id: DOC, file_path: PATH, file_name: 'p.pdf', file_size: 1, file_type: 'application/pdf' }],
  ] as const)('is released and then removed when %s is refused', async (_name, action, input) => {
    ctl.reply = { ok: false, error: DOCUMENT_REFUSALS.DOC_BAD_FILE };
    expect(await action(input)).toEqual({ ok: false, error: DOCUMENT_REFUSALS.DOC_BAD_FILE });
    expect(ctl.order.slice(-2)).toEqual(['releaseDocumentFile', 'removeDocumentFile']);
    expect(ctl.ran.find((r) => r.fn === 'releaseDocumentFile')).toMatchObject({ client: ctl.client, input: PATH });
    expect(ctl.ran.find((r) => r.fn === 'removeDocumentFile')).toMatchObject({ input: PATH });
  });

  it('is removed only when the database said it could go', async () => {
    ctl.reply = { ok: false, error: DOCUMENT_REFUSALS.DOC_TOO_MANY };
    ctl.released = false;
    await actions.addMyDocumentAction(ADD);
    expect(ranFns()).toEqual(['addDocument', 'releaseDocumentFile']);
  });

  it('is kept when the outcome is unknown, because it may have been attached', async () => {
    ctl.reply = { ok: false, error: WRITE_FAILED };
    await actions.addMyDocumentAction(ADD);
    expect(ranFns()).toEqual(['addDocument']);
  });

  it('is kept when the add worked', async () => {
    await actions.addMyDocumentAction(ADD);
    expect(ranFns()).toEqual(['addDocument']);
  });

  it('is released for an input the write path refused, but never for a path of a wrong shape', async () => {
    ctl.reply = { ok: false, error: 'Give the document a title.' };
    await actions.addMyDocumentAction({ ...ADD, file_path: '../../etc/passwd' });
    expect(ranFns()).toEqual(['addDocument']);
  });

  it('is released and removed when the write path refuses the input itself (a blank title), the path being well formed', async () => {
    ctl.reply = { ok: false, error: 'Give the document a title.' };
    expect(await actions.addMyDocumentAction({ ...ADD, title: ' ' })).toEqual(ctl.reply);
    expect(ctl.order.slice(-2)).toEqual(['releaseDocumentFile', 'removeDocumentFile']);
    expect(ctl.ran.find((r) => r.fn === 'removeDocumentFile')).toMatchObject({ input: PATH });
    ctl.ran = [];
    ctl.order = [];
    await actions.addDocumentForAction({ ...ADD, employee_id: EMP, title: '' });
    expect(ctl.order.slice(-2)).toEqual(['releaseDocumentFile', 'removeDocumentFile']);
  });

  it('is never released from another workspace\'s folder', async () => {
    ctl.reply = { ok: false, error: DOCUMENT_REFUSALS.DOC_BAD_FILE };
    await actions.addMyDocumentAction({ ...ADD, file_path: `99999999-9999-4999-8999-999999999999/${EMP}/${NAME}.pdf` });
    expect(ranFns()).toEqual(['addDocument']);
  });
});

describe('documentLinkAction', () => {
  it('asks for the link with the caller\'s own session and returns the link only', async () => {
    asRole('member');
    const result = await actions.documentLinkAction({ document_id: DOC });
    expect(result).toEqual({ ok: true, data: { url: 'https://example.test/signed?token=t' } });
    expect(ctl.ran).toEqual([{ fn: 'documentLink', orgId: ORG, client: ctl.client, input: DOC }]);
  });
  it('checks nothing else itself: no write, no employee lookup of its own', async () => {
    await actions.documentLinkAction({ document_id: DOC });
    expect(ranFns()).toEqual(['documentLink']);
  });
  it('passes on a refusal as it came', async () => {
    ctl.reply = { ok: false, error: DOCUMENT_REFUSALS.DOC_NOT_FOUND };
    expect(await actions.documentLinkAction({ document_id: DOC })).toEqual({ ok: false, error: DOCUMENT_REFUSALS.DOC_NOT_FOUND });
  });
  it('refuses a bad or missing id without a call', async () => {
    for (const input of [{ document_id: 'x' }, {}, undefined, { document_id: 5 }]) {
      expect(await actions.documentLinkAction(input)).toEqual({ ok: false, error: DOCUMENT_REFUSALS.DOC_NOT_FOUND });
    }
    expect(ctl.ran).toEqual([]);
  });
  it('refuses a demo visitor', async () => {
    ctl.viewer = { ...ctl.viewer, isDemo: true };
    expect(await actions.documentLinkAction({ document_id: DOC })).toEqual({ ok: false, error: DEMO_SENTENCE });
    expect(ctl.ran).toEqual([]);
  });
  it('is the only link action and revalidates nothing', async () => {
    await actions.documentLinkAction({ document_id: DOC });
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('the module', () => {
  it('exports exactly the actions the screens and the brief name', () => {
    expect(Object.keys(actions).sort()).toEqual(
      [
        'acknowledgeDocumentAction',
        'addDocumentForAction',
        'addMyDocumentAction',
        'documentLinkAction',
        'removeDocumentAction',
        'removeMyDocumentAction',
        'replaceDocumentFileAction',
        'requestDocumentAckAction',
        'updateDocumentAction',
      ].sort(),
    );
  });
});
