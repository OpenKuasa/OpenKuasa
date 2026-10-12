import { afterEach, describe, expect, it, vi } from 'vitest';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { DOCUMENT_REFUSALS } from '@/lib/people/documents-refusals';
import {
  acknowledgeLetter,
  deleteLetter,
  deleteLetterTemplate,
  issueLetter,
  saveLetter,
  saveLetterTemplate,
  startLetterFromTemplate,
  unissueLetter,
} from '@/lib/people/letter-writes';
import { fakeSupabase } from './setup/fake-supabase';

const ORG = '11111111-1111-4111-8111-111111111111';
const EMP = '22222222-2222-4222-8222-222222222222';
const LETTER = '33333333-3333-4333-8333-333333333333';
const TEMPLATE = '44444444-4444-4444-8444-444444444444';
const ctxOf = (client: never) => ({ client, orgId: ORG });

const SAVED = {
  id: LETTER,
  employee_id: EMP,
  letter_type: 'offer',
  title: 'Offer of employment',
  body: 'Dear Farah,\n\nWelcome.',
  status: 'draft',
  issued_on: null,
  ack_requested: false,
  acknowledged_at: null,
};
const TEMPLATE_ROW = { id: TEMPLATE, name: 'Offer', letter_type: 'offer', title: 'Offer', body: 'Dear {employee_name}' };
const SAVE = { employee_id: EMP, letter_type: 'offer', title: 'Offer of employment', body: 'Dear Farah,\n\nWelcome.', ack_requested: false };

afterEach(() => vi.restoreAllMocks());

const LETTER_CODES = Object.keys(DOCUMENT_REFUSALS).filter((code) => code.startsWith('LETTER_'));

describe('saveLetter', () => {
  it('adds a draft with exactly these argument names (p_letter null) and returns it', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_letter': { data: SAVED } });
    expect(await saveLetter(ctxOf(client), SAVE)).toEqual({ ok: true, data: SAVED });
    expect(calls[0]).toMatchObject({
      fn: 'hr_save_letter',
      args: {
        p_employee: EMP,
        p_letter: null,
        p_letter_type: 'offer',
        p_title: 'Offer of employment',
        p_body: 'Dear Farah,\n\nWelcome.',
        p_ack_requested: false,
      },
    });
    expect(Object.keys(calls[0].args!).sort()).toEqual(
      ['p_ack_requested', 'p_body', 'p_employee', 'p_letter', 'p_letter_type', 'p_title'],
    );
  });

  it('changes a draft when a letter id is given, and reads an empty id as add', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_letter': { data: SAVED } });
    await saveLetter(ctxOf(client), { ...SAVE, letter_id: LETTER });
    expect(calls[0].args).toMatchObject({ p_letter: LETTER });
    await saveLetter(ctxOf(client), { ...SAVE, letter_id: '' });
    expect(calls[1].args).toMatchObject({ p_letter: null });
    await saveLetter(ctxOf(client), { ...SAVE, letter_id: null });
    expect(calls[2].args).toMatchObject({ p_letter: null });
  });

  it('refuses an id that is not text, never reading it as add', async () => {
    const { client, calls } = fakeSupabase();
    for (const letter_id of [5, {}, ['x'], true, 'nope']) {
      expect((await saveLetter(ctxOf(client), { ...SAVE, letter_id } as never)).ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it('trims the title and keeps the body exactly as typed', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_letter': { data: SAVED } });
    await saveLetter(ctxOf(client), { ...SAVE, title: '  Offer  ', body: '  keep   my\n spaces  ' });
    expect(calls[0].args).toMatchObject({ p_title: 'Offer', p_body: '  keep   my\n spaces  ' });
  });

  it('sends no body as an empty one, and an unset or null request to acknowledge as false', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_letter': { data: SAVED } });
    await saveLetter(ctxOf(client), { employee_id: EMP, letter_type: 'other', title: 'T', body: null, ack_requested: null } as never);
    expect(calls[0].args).toMatchObject({ p_body: '', p_ack_requested: false });
    await saveLetter(ctxOf(client), { employee_id: EMP, letter_type: 'other', title: 'T' } as never);
    expect(calls[1].args).toMatchObject({ p_body: '', p_ack_requested: false });
  });

  it('sends true only for true', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_letter': { data: SAVED } });
    await saveLetter(ctxOf(client), { ...SAVE, ack_requested: true });
    expect(calls[0].args).toMatchObject({ p_ack_requested: true });
    expect((await saveLetter(ctxOf(client), { ...SAVE, ack_requested: 'yes' } as never)).ok).toBe(false);
  });

  it.each([
    ['no employee', { ...SAVE, employee_id: '' }],
    ['a blank title', { ...SAVE, title: ' ' }],
    ['a long title', { ...SAVE, title: 'x'.repeat(201) }],
    ['a long body', { ...SAVE, body: 'x'.repeat(10001) }],
    ['an unknown type', { ...SAVE, letter_type: 'Confirmation' }],
  ])('refuses %s in words, without a database call', async (_label, input) => {
    const { client, calls } = fakeSupabase();
    const result = await saveLetter(ctxOf(client), input as never);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('accepts a body of exactly 10,000 characters', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_save_letter': { data: SAVED } });
    expect((await saveLetter(ctxOf(client), { ...SAVE, body: 'x'.repeat(10000) })).ok).toBe(true);
  });

  it.each(LETTER_CODES)('turns %s into its sentence and logs nothing', async (code) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.hr_save_letter': { error: { code: 'P0001', message: code } } });
    expect(await saveLetter(ctxOf(client), SAVE)).toEqual({ ok: false, error: DOCUMENT_REFUSALS[code] });
    expect(log).not.toHaveBeenCalled();
  });

  it('has the sentences the spec gives', () => {
    expect(DOCUMENT_REFUSALS.LETTER_NOT_DRAFT).toBe('That letter has been issued. Pull it back to draft on the Letters screen to change it.');
    expect(DOCUMENT_REFUSALS.LETTER_NOT_ISSUED).toBe('That letter is still a draft.');
    expect(DOCUMENT_REFUSALS.LETTER_EMPTY).toBe('The letter has no text yet.');
    expect(DOCUMENT_REFUSALS.LETTER_PLACEHOLDER).toBe('The letter still has a placeholder in it. Replace it before issuing.');
    expect(DOCUMENT_REFUSALS.LETTER_TEMPLATE_EXISTS).toBe('There is already a template with that name.');
    expect(DOCUMENT_REFUSALS.LETTER_TOO_MANY_TEMPLATES).toBe('That is 50 templates already. Remove one first.');
    expect(DOCUMENT_REFUSALS.LETTER_NOT_FOUND).toBe('That letter could not be found.');
  });

  it('logs only the code for any other failure, never the title or the body', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({
      'rpc.hr_save_letter': { error: { code: '22P02', message: 'bad "Secret Title" and "Secret Body" LETTER_EMPTY' } },
    });
    expect(await saveLetter(ctxOf(client), { ...SAVE, title: 'Secret Title', body: 'Secret Body' })).toEqual({
      ok: false,
      error: WRITE_FAILED,
    });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('22P02');
    expect(logged).not.toContain('Secret');
  });

  it('treats a reply that is not a letter as a failed save', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const data of [null, [], { ...SAVED, status: 'sent' }, { ...SAVED, letter_type: 'Offer' }, { ...SAVED, body: null }]) {
      const { client } = fakeSupabase({ 'rpc.hr_save_letter': { data } });
      expect(await saveLetter(ctxOf(client), SAVE)).toEqual({ ok: false, error: WRITE_FAILED });
    }
  });
});

describe('startLetterFromTemplate', () => {
  it('calls hr_start_letter_from_template and returns the draft with the placeholders left unfilled', async () => {
    const { client, calls } = fakeSupabase({
      'rpc.hr_start_letter_from_template': { data: { letter: SAVED, unfilled: ['designation'] } },
    });
    expect(await startLetterFromTemplate(ctxOf(client), { employee_id: EMP, template_id: TEMPLATE })).toEqual({
      ok: true,
      data: { letter: SAVED, unfilled: ['designation'] },
    });
    expect(calls[0]).toMatchObject({ fn: 'hr_start_letter_from_template', args: { p_employee: EMP, p_template: TEMPLATE } });
    expect(Object.keys(calls[0].args!).sort()).toEqual(['p_employee', 'p_template']);
  });
  it('refuses a bad id without a call, and treats a reply without the list as a failed save', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = fakeSupabase();
    expect((await startLetterFromTemplate(ctxOf(bad.client), { employee_id: EMP, template_id: '' })).ok).toBe(false);
    expect(bad.calls).toHaveLength(0);
    const odd = fakeSupabase({ 'rpc.hr_start_letter_from_template': { data: { letter: SAVED } } });
    expect(await startLetterFromTemplate(ctxOf(odd.client), { employee_id: EMP, template_id: TEMPLATE })).toEqual({
      ok: false,
      error: WRITE_FAILED,
    });
  });
  it.each(['LETTER_NOT_ALLOWED', 'LETTER_NOT_FOUND', 'LETTER_BAD_INPUT'])('turns %s into its sentence', async (code) => {
    const { client } = fakeSupabase({ 'rpc.hr_start_letter_from_template': { error: { message: code } } });
    expect(await startLetterFromTemplate(ctxOf(client), { employee_id: EMP, template_id: TEMPLATE })).toEqual({
      ok: false,
      error: DOCUMENT_REFUSALS[code],
    });
  });
});

describe.each([
  ['issueLetter', issueLetter, 'hr_issue_letter', ['LETTER_NOT_DRAFT', 'LETTER_EMPTY', 'LETTER_PLACEHOLDER', 'LETTER_NOT_FOUND']],
  ['unissueLetter', unissueLetter, 'hr_unissue_letter', ['LETTER_NOT_ISSUED', 'LETTER_NOT_FOUND']],
  [
    'acknowledgeLetter',
    acknowledgeLetter,
    'hr_acknowledge_letter',
    ['LETTER_NOT_ISSUED', 'LETTER_ACK_NOT_REQUESTED', 'LETTER_ALREADY_ACKNOWLEDGED', 'LETTER_NOT_FOUND'],
  ],
] as const)('%s', (_name, fn, rpc, codes) => {
  it(`calls ${rpc} with the letter only and returns it`, async () => {
    const issued = { ...SAVED, status: 'issued', issued_on: '2026-10-12', ack_requested: true, acknowledged_at: '2026-10-12T04:00:00+00:00' };
    const { client, calls } = fakeSupabase({ [`rpc.${rpc}`]: { data: issued } });
    expect(await fn(ctxOf(client), { letter_id: LETTER })).toEqual({ ok: true, data: issued });
    expect(calls[0]).toMatchObject({ fn: rpc, args: { p_letter: LETTER } });
    expect(Object.keys(calls[0].args!)).toEqual(['p_letter']);
  });
  it('refuses a bad id without a call', async () => {
    const { client, calls } = fakeSupabase();
    expect((await fn(ctxOf(client), { letter_id: 'x' })).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it.each(codes)('turns %s into its sentence', async (code) => {
    const { client } = fakeSupabase({ [`rpc.${rpc}`]: { error: { message: code } } });
    expect(await fn(ctxOf(client), { letter_id: LETTER })).toEqual({ ok: false, error: DOCUMENT_REFUSALS[code] });
  });
});

describe('acknowledgeLetter', () => {
  it('takes no employee: a smuggled one never reaches the database', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_acknowledge_letter': { data: SAVED } });
    await acknowledgeLetter(ctxOf(client), { letter_id: LETTER, employee_id: 'evil' } as never);
    expect(JSON.stringify(calls[0].args)).not.toContain('evil');
  });
});

describe('deleteLetter', () => {
  it('calls hr_delete_letter and returns what was deleted', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_delete_letter': { data: { id: LETTER, employee_id: EMP } } });
    expect(await deleteLetter(ctxOf(client), { letter_id: LETTER })).toEqual({ ok: true, data: { id: LETTER, employee_id: EMP } });
    expect(calls[0]).toMatchObject({ fn: 'hr_delete_letter', args: { p_letter: LETTER } });
  });
  it('turns a refusal into its sentence', async () => {
    const { client } = fakeSupabase({ 'rpc.hr_delete_letter': { error: { message: 'LETTER_NOT_DRAFT' } } });
    expect(await deleteLetter(ctxOf(client), { letter_id: LETTER })).toEqual({ ok: false, error: DOCUMENT_REFUSALS.LETTER_NOT_DRAFT });
  });
});

describe('saveLetterTemplate', () => {
  const TEMPLATE_INPUT = { name: ' Offer ', letter_type: 'offer', title: ' Offer ', body: 'Dear {employee_name}' };

  it('adds to the SESSION workspace, never one from the input', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_letter_template': { data: TEMPLATE_ROW } });
    expect(await saveLetterTemplate(ctxOf(client), { ...TEMPLATE_INPUT, org_id: 'other' } as never)).toEqual({
      ok: true,
      data: TEMPLATE_ROW,
    });
    expect(calls[0]).toMatchObject({
      fn: 'hr_save_letter_template',
      args: {
        p_org: ORG,
        p_template: null,
        p_name: 'Offer',
        p_letter_type: 'offer',
        p_title: 'Offer',
        p_body: 'Dear {employee_name}',
      },
    });
    expect(Object.keys(calls[0].args!).sort()).toEqual(['p_body', 'p_letter_type', 'p_name', 'p_org', 'p_template', 'p_title']);
    expect(JSON.stringify(calls[0].args)).not.toContain('other');
  });
  it('changes a template when an id is given', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_save_letter_template': { data: TEMPLATE_ROW } });
    await saveLetterTemplate(ctxOf(client), { ...TEMPLATE_INPUT, template_id: TEMPLATE });
    expect(calls[0].args).toMatchObject({ p_template: TEMPLATE, p_org: ORG });
  });
  it.each([
    ['a blank name', { ...TEMPLATE_INPUT, name: ' ' }],
    ['a long name', { ...TEMPLATE_INPUT, name: 'x'.repeat(121) }],
    ['a blank title', { ...TEMPLATE_INPUT, title: '' }],
    ['a long title', { ...TEMPLATE_INPUT, title: 'x'.repeat(201) }],
    ['a long body', { ...TEMPLATE_INPUT, body: 'x'.repeat(10001) }],
    ['an unknown type', { ...TEMPLATE_INPUT, letter_type: 'memo' }],
    ['an id that is not text', { ...TEMPLATE_INPUT, template_id: 4 }],
  ])('refuses %s without a call', async (_label, input) => {
    const { client, calls } = fakeSupabase();
    expect((await saveLetterTemplate(ctxOf(client), input as never)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it.each(['LETTER_TEMPLATE_EXISTS', 'LETTER_TOO_MANY_TEMPLATES', 'LETTER_BAD_INPUT', 'LETTER_NOT_ALLOWED'])(
    'turns %s into its sentence',
    async (code) => {
      const { client } = fakeSupabase({ 'rpc.hr_save_letter_template': { error: { message: code } } });
      expect(await saveLetterTemplate(ctxOf(client), TEMPLATE_INPUT)).toEqual({ ok: false, error: DOCUMENT_REFUSALS[code] });
    },
  );
  it('does not log the template', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeSupabase({ 'rpc.hr_save_letter_template': { error: { code: 'XX000', message: 'boom Secret Template' } } });
    await saveLetterTemplate(ctxOf(client), { ...TEMPLATE_INPUT, body: 'Secret Template' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('Secret');
  });
});

describe('deleteLetterTemplate', () => {
  it('calls hr_delete_letter_template with the template only', async () => {
    const { client, calls } = fakeSupabase({ 'rpc.hr_delete_letter_template': { data: { id: TEMPLATE } } });
    expect(await deleteLetterTemplate(ctxOf(client), { template_id: TEMPLATE })).toEqual({ ok: true, data: { id: TEMPLATE } });
    expect(calls[0]).toMatchObject({ fn: 'hr_delete_letter_template', args: { p_template: TEMPLATE } });
    expect(Object.keys(calls[0].args!)).toEqual(['p_template']);
  });
  it('refuses a bad id without a call', async () => {
    const { client, calls } = fakeSupabase();
    expect((await deleteLetterTemplate(ctxOf(client), { template_id: '' })).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
