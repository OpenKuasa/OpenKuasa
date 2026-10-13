import { afterEach, describe, expect, it, vi } from 'vitest';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { DOCUMENT_REFUSALS } from '@/lib/people/documents-refusals';
import {
  acknowledgeDocument,
  addDocument,
  removeDocument,
  replaceDocumentFile,
  requestDocumentAck,
  updateDocument,
} from '@/lib/people/document-writes';
import { fakeSupabase } from './setup/fake-supabase';

const ORG = '11111111-1111-4111-8111-111111111111';
const EMP = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';
const NAME = 'abcdef01-aaaa-4bbb-8ccc-0123456789ab';
const PATH = `${ORG}/${EMP}/${NAME}.pdf`;
const NEW_PATH = `${ORG}/${EMP}/abcdef02-aaaa-4bbb-8ccc-0123456789ab.png`;
const ctxOf = (client: never) => ({ client, orgId: ORG });

const SAVED = {
  id: DOC,
  employee_id: EMP,
  title: 'Passport',
  doc_type: 'identity',
  expires_on: '2030-01-31',
  file_name: 'passport.pdf',
  file_size: 1234,
  file_type: 'application/pdf',
  source: 'employee',
  ack_requested: false,
  acknowledged_at: null,
  created_at: '2026-10-12T03:00:00+00:00',
};
const ADD = {
  employee_id: EMP,
  title: 'Passport',
  doc_type: 'identity',
  expires_on: '2030-01-31',
  file_path: PATH,
  file_name: 'passport.pdf',
  file_size: 1234,
  file_type: 'application/pdf',
};
const FILE = { file_path: NEW_PATH, file_name: 'scan.png', file_size: 99, file_type: 'image/png' };

afterEach(() => vi.restoreAllMocks());

/** Every documents code (the DOC_ ones) as the sentence the person is told. */
const DOC_CODES = Object.keys(DOCUMENT_REFUSALS).filter((code) => code.startsWith('DOC_'));

describe('addDocument', () => {
  it('calls hr_add_document with exactly these argument names, and returns the document', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_add_document': { data: SAVED } });
    expect(await addDocument(ctxOf(client), ADD)).toEqual({ ok: true, data: SAVED });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      fn: 'hr_add_document',
      args: {
        p_employee: EMP,
        p_title: 'Passport',
        p_doc_type: 'identity',
        p_expires_on: '2030-01-31',
        p_file_path: PATH,
        p_file_name: 'passport.pdf',
        p_file_size: 1234,
        p_file_type: 'application/pdf',
      },
    });
    expect(Object.keys(calls[0].args!).sort()).toEqual(
      ['p_doc_type', 'p_employee', 'p_expires_on', 'p_file_name', 'p_file_path', 'p_file_size', 'p_file_type', 'p_title'],
    );
  });

  it('trims the title and sends no expiry as null', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_add_document': { data: SAVED } });
    await addDocument(ctxOf(client), { ...ADD, title: '  Passport  ', expires_on: undefined });
    expect(calls[0].args).toMatchObject({ p_title: 'Passport', p_expires_on: null });
    await addDocument(ctxOf(client), { ...ADD, expires_on: '' });
    expect(calls[1].args).toMatchObject({ p_expires_on: null });
  });

  it('never takes the workspace from the input', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_add_document': { data: SAVED } });
    await addDocument(ctxOf(client), { ...ADD, org_id: 'other' } as never);
    expect(JSON.stringify(calls[0].args)).not.toContain('other');
    expect(calls[0].args).not.toHaveProperty('p_org');
  });

  it.each([
    ['no employee', { ...ADD, employee_id: '' }],
    ['a blank title', { ...ADD, title: '   ' }],
    ['a long title', { ...ADD, title: 'x'.repeat(201) }],
    ['an unknown type', { ...ADD, doc_type: 'payslip' }],
    ['a bad expiry', { ...ADD, expires_on: '2026-02-30' }],
    ['an expiry before 2000', { ...ADD, expires_on: '1999-12-31' }],
    ['a path outside the shape', { ...ADD, file_path: `${ORG}/${EMP}/../x.pdf` }],
    ['a path in another workspace', { ...ADD, file_path: `99999999-9999-4999-8999-999999999999/${EMP}/${NAME}.pdf` }],
    ['a path in another employee\'s folder', { ...ADD, file_path: `${ORG}/99999999-9999-4999-8999-999999999999/${NAME}.pdf` }],
    ['no file name', { ...ADD, file_name: ' ' }],
    ['a file name with a slash', { ...ADD, file_name: 'a/b.pdf' }],
    ['a file name with a control character', { ...ADD, file_name: 'a\u0000b.pdf' }],
    ['a long file name', { ...ADD, file_name: `${'x'.repeat(201)}.pdf` }],
    ['an empty file', { ...ADD, file_size: 0 }],
    ['a file over 10 MB', { ...ADD, file_size: 10 * 1024 * 1024 + 1 }],
    ['a fractional size', { ...ADD, file_size: 1.5 }],
    ['a type the bucket does not take', { ...ADD, file_type: 'text/plain' }],
    ['image/heif', { ...ADD, file_type: 'image/heif' }],
  ])('refuses %s in words, without a database call', async (_label, input) => {
    const { client, calls } = fakeSupabase();
    const result = await addDocument(ctxOf(client), input as never);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).not.toBe('');
    expect(calls).toHaveLength(0);
  });

  it('answers a bad file with the attach sentence and a bad type with a sentence of its own', async () => {
    const { client } = fakeSupabase();
    expect(await addDocument(ctxOf(client), { ...ADD, file_path: 'x' })).toEqual({ ok: false, error: DOCUMENT_REFUSALS.DOC_BAD_FILE });
    expect(await addDocument(ctxOf(client), { ...ADD, doc_type: 'payslip' })).toEqual({
      ok: false,
      error: 'Choose a type from the list.',
    });
  });

  it.each(DOC_CODES)('turns %s into its sentence and logs nothing', async (code) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.hr_add_document': { error: { code: 'P0001', message: code } } });
    expect(await addDocument(ctxOf(client), ADD)).toEqual({ ok: false, error: DOCUMENT_REFUSALS[code] });
    expect(log).not.toHaveBeenCalled();
  });

  it('has the sentences the spec gives', () => {
    expect(DOCUMENT_REFUSALS.DOC_NOT_ALLOWED).toBe("You can't make that change.");
    expect(DOCUMENT_REFUSALS.DOC_TYPE_NOT_ALLOWED).toBe(
      'You can add identity, medical, certificate or other documents. An owner or admin adds the rest.',
    );
    expect(DOCUMENT_REFUSALS.DOC_TOO_MANY).toBe('That is 200 documents already. Remove one first.');
    expect(DOCUMENT_REFUSALS.DOC_BAD_FILE).toBe('That file could not be attached. Upload it again.');
  });

  it('logs only the code for any other failure, never what was typed', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({
      'rpc.hr_add_document': {
        error: { code: '22P02', message: 'invalid input syntax: "Secret Title passport.pdf DOC_NOT_ALLOWED"' },
      },
    });
    expect(await addDocument(ctxOf(client), { ...ADD, title: 'Secret Title' })).toEqual({ ok: false, error: WRITE_FAILED });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('22P02');
    expect(logged).not.toContain('Secret Title');
    expect(logged).not.toContain('passport.pdf');
    expect(logged).not.toContain(PATH);
  });

  it('does not read a message that merely mentions a code as that code', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.hr_add_document': { error: { message: 'note about DOC_NOT_ALLOWED here' } } });
    expect(await addDocument(ctxOf(client), ADD)).toEqual({ ok: false, error: WRITE_FAILED });
  });

  it('treats a reply that is not a document as a failed save', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const data of [null, [], 'x', { ...SAVED, doc_type: 'payslip' }, { ...SAVED, id: 5 }, { ...SAVED, source: 'x' }]) {
      const { client } = fakeSupabase({ 'rpc.hr_add_document': { data } });
      expect(await addDocument(ctxOf(client), ADD)).toEqual({ ok: false, error: WRITE_FAILED });
    }
  });
});

describe('updateDocument', () => {
  it('calls hr_update_document with its three fields and returns the document', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_update_document': { data: SAVED } });
    const result = await updateDocument(ctxOf(client), { document_id: DOC, title: ' Passport ', doc_type: 'identity', expires_on: null });
    expect(result).toEqual({ ok: true, data: SAVED });
    expect(calls[0]).toMatchObject({
      fn: 'hr_update_document',
      args: { p_document: DOC, p_title: 'Passport', p_doc_type: 'identity', p_expires_on: null },
    });
    expect(Object.keys(calls[0].args!).sort()).toEqual(['p_doc_type', 'p_document', 'p_expires_on', 'p_title']);
  });
  it('refuses bad input without a call', async () => {
    const { client, calls } = fakeSupabase();
    expect((await updateDocument(ctxOf(client), { document_id: 'nope', title: 'T', doc_type: 'other' } as never)).ok).toBe(false);
    expect((await updateDocument(ctxOf(client), { document_id: DOC, title: '', doc_type: 'other' } as never)).ok).toBe(false);
    expect((await updateDocument(ctxOf(client), { document_id: DOC, title: 'T', doc_type: 'letter' } as never)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('turns a refusal into its sentence', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_update_document': { error: { message: 'DOC_NOT_FOUND' } } });
    expect(await updateDocument(ctxOf(client), { document_id: DOC, title: 'T', doc_type: 'other' })).toEqual({
      ok: false,
      error: DOCUMENT_REFUSALS.DOC_NOT_FOUND,
    });
  });
});

describe('replaceDocumentFile', () => {
  it('calls hr_replace_document_file and returns the document with the old path for removal', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_replace_document_file': { data: { document: SAVED, old_path: PATH } } });
    expect(await replaceDocumentFile(ctxOf(client), { document_id: DOC, ...FILE })).toEqual({
      ok: true,
      data: { document: SAVED, old_path: PATH },
    });
    expect(calls[0]).toMatchObject({
      fn: 'hr_replace_document_file',
      args: { p_document: DOC, p_file_path: NEW_PATH, p_file_name: 'scan.png', p_file_size: 99, p_file_type: 'image/png' },
    });
    expect(Object.keys(calls[0].args!).sort()).toEqual(['p_document', 'p_file_name', 'p_file_path', 'p_file_size', 'p_file_type']);
  });
  it('accepts a null old path (the row had no file)', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_replace_document_file': { data: { document: SAVED, old_path: null } } });
    expect(await replaceDocumentFile(ctxOf(client), { document_id: DOC, ...FILE })).toMatchObject({ ok: true, data: { old_path: null } });
  });
  it('refuses a path outside this workspace without a call', async () => {
    const { client, calls } = fakeSupabase();
    const other = `99999999-9999-4999-8999-999999999999/${EMP}/${NAME}.pdf`;
    expect(await replaceDocumentFile(ctxOf(client), { document_id: DOC, ...FILE, file_path: other })).toEqual({
      ok: false,
      error: DOCUMENT_REFUSALS.DOC_BAD_FILE,
    });
    expect(calls).toHaveLength(0);
  });
  it('turns a refusal into its sentence', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_replace_document_file': { error: { message: 'DOC_BAD_FILE' } } });
    expect(await replaceDocumentFile(ctxOf(client), { document_id: DOC, ...FILE })).toEqual({
      ok: false,
      error: DOCUMENT_REFUSALS.DOC_BAD_FILE,
    });
  });
  it('treats an unexpected reply as a failed save', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const data of [{ document: SAVED }, { document: SAVED, old_path: 5 }, { old_path: null }]) {
      const { client } = fakeSupabase({ 'rpc.hr_replace_document_file': { data } });
      expect(await replaceDocumentFile(ctxOf(client), { document_id: DOC, ...FILE })).toEqual({ ok: false, error: WRITE_FAILED });
    }
  });
});

describe('removeDocument', () => {
  it('calls hr_remove_document and returns what to clean up', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_remove_document': { data: { id: DOC, employee_id: EMP, path: PATH } } });
    expect(await removeDocument(ctxOf(client), { document_id: DOC })).toEqual({
      ok: true,
      data: { id: DOC, employee_id: EMP, path: PATH },
    });
    expect(calls[0]).toMatchObject({ fn: 'hr_remove_document', args: { p_document: DOC } });
    expect(Object.keys(calls[0].args!)).toEqual(['p_document']);
  });
  it('accepts a null path', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_remove_document': { data: { id: DOC, employee_id: EMP, path: null } } });
    expect(await removeDocument(ctxOf(client), { document_id: DOC })).toMatchObject({ ok: true, data: { path: null } });
  });
  it('refuses a bad id without a call', async () => {
    const { client, calls } = fakeSupabase();
    expect((await removeDocument(ctxOf(client), { document_id: '1' })).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('turns a refusal into its sentence', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_remove_document': { error: { message: 'DOC_NOT_FOUND' } } });
    expect(await removeDocument(ctxOf(client), { document_id: DOC })).toEqual({ ok: false, error: DOCUMENT_REFUSALS.DOC_NOT_FOUND });
  });
});

describe('requestDocumentAck', () => {
  it('asks and withdraws with a required true or false', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_request_document_ack': { data: { ...SAVED, source: 'hr', ack_requested: true } } });
    expect((await requestDocumentAck(ctxOf(client), { document_id: DOC, requested: true })).ok).toBe(true);
    expect(calls[0]).toMatchObject({ fn: 'hr_request_document_ack', args: { p_document: DOC, p_requested: true } });
    await requestDocumentAck(ctxOf(client), { document_id: DOC, requested: false });
    expect(calls[1].args).toEqual({ p_document: DOC, p_requested: false });
  });
  it('never reads a missing flag as true or false', async () => {
    const { client, calls } = fakeSupabase();
    for (const requested of [undefined, null, 'true', 1]) {
      expect((await requestDocumentAck(ctxOf(client), { document_id: DOC, requested } as never)).ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });
  it('turns a refusal into its sentence', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_request_document_ack': { error: { message: 'DOC_NOT_ALLOWED' } } });
    expect(await requestDocumentAck(ctxOf(client), { document_id: DOC, requested: true })).toEqual({
      ok: false,
      error: DOCUMENT_REFUSALS.DOC_NOT_ALLOWED,
    });
  });
});

describe('acknowledgeDocument', () => {
  it('calls hr_acknowledge_document with the document only', async () => {
    const acked = { ...SAVED, source: 'hr', ack_requested: true, acknowledged_at: '2026-10-12T04:00:00+00:00' };
    const { client, calls } = fakeSupabase({ 'rpc.hr_acknowledge_document': { data: acked } });
    expect(await acknowledgeDocument(ctxOf(client), { document_id: DOC })).toEqual({ ok: true, data: acked });
    expect(calls[0]).toMatchObject({ fn: 'hr_acknowledge_document', args: { p_document: DOC } });
    expect(Object.keys(calls[0].args!)).toEqual(['p_document']);
  });
  it.each(['DOC_ACK_NOT_REQUESTED', 'DOC_ALREADY_ACKNOWLEDGED', 'DOC_NOT_FOUND'])('turns %s into its sentence', async (code) => {
    const { client } = fakeSupabase({ 'rpc.hr_acknowledge_document': { error: { message: code } } });
    expect(await acknowledgeDocument(ctxOf(client), { document_id: DOC })).toEqual({ ok: false, error: DOCUMENT_REFUSALS[code] });
  });
  it('takes no employee: a smuggled one never reaches the database', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_acknowledge_document': { data: SAVED } });
    await acknowledgeDocument(ctxOf(client), { document_id: DOC, employee_id: 'evil' } as never);
    expect(JSON.stringify(calls[0].args)).not.toContain('evil');
  });
});
