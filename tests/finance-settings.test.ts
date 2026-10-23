import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Bendahara's accounting settings, the data side: the two inputs, the reads and writes against a stubbed client,
 * the five refusals (FIN63–FIN67) as `writeFailed` answers them, the two actions and the company TIN.
 */
const ctl = vi.hoisted(() => ({
  viewer: { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: false } as {
    userId: string; orgId: string; role: string; isDemo: boolean;
  },
  revalidated: [] as string[],
  /** The client the server hands the actions. */
  client: undefined as unknown,
}));

vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer, hasSupabaseEnv: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ctl.client }));
vi.mock('@/lib/events', () => ({ recordEvent: async () => undefined }));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    ctl.revalidated.push(path);
  },
}));

const settings = await import('@/lib/finance/settings');
const {
  DEFAULT_FINANCE_SETTINGS,
  SETTINGS_MESSAGES,
  SETTINGS_NEEDS_SIGN_OFF,
  financeSettingsInput,
  financeSettingsOrDefault,
  formatSequence,
  getFinanceSettings,
  listSequences,
  saveFinanceSettings,
  sequenceInput,
  setSequence,
} = settings;
const { NOT_ALLOWED, WRITE_FAILED, settingsRefusal, writeFailed } = await import('@/lib/finance/result');
const { saveFinanceSettingsAction, setSequenceAction } = await import('@/app/(app)/finance/actions');
const { updateCompanyAction } = await import('@/app/account/actions');
const { tinField, TIN_MESSAGE } = await import('@/lib/account/tin');

type PgError = { code: string; message: string; details?: string; hint?: string } | null;

/** A client whose table reads, upserts and RPCs answer what a test says, and that records what it was sent. */
function stubClient(answer: { data?: unknown; error?: PgError } = {}) {
  const calls: { kind: string; args: unknown[] }[] = [];
  const result = { data: answer.data ?? null, error: answer.error ?? null };
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'update']) {
    chain[m] = (...args: unknown[]) => {
      calls.push({ kind: m, args });
      return chain;
    };
  }
  chain.upsert = (...args: unknown[]) => {
    calls.push({ kind: 'upsert', args });
    return chain;
  };
  chain.maybeSingle = async () => result;
  chain.single = async () => result;
  chain.then = (resolve: (v: unknown) => void) => resolve(result);
  const client = {
    from: (table: string) => {
      calls.push({ kind: 'from', args: [table] });
      return chain;
    },
    rpc: async (...args: unknown[]) => {
      calls.push({ kind: 'rpc', args });
      return result;
    },
  };
  return { client, calls };
}

const ctxOf = (client: unknown) => ({ client: client as never, orgId: 'org1' });

beforeEach(() => {
  ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: false };
  ctl.revalidated = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('financeSettingsInput', () => {
  // 17:00 UTC on 23 Oct is already 24 Oct in Malaysia.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T17:00:00Z'));
  });

  it('takes a year end and a lock date up to today in Malaysia', () => {
    expect(financeSettingsInput.parse({ yearEndMonth: 6, lockDate: '2026-10-24' })).toEqual({ yearEndMonth: 6, lockDate: '2026-10-24' });
    expect(financeSettingsInput.parse({ yearEndMonth: 12, lockDate: '2026-09-30' })).toEqual({ yearEndMonth: 12, lockDate: '2026-09-30' });
  });

  it('refuses a lock date after today in Malaysia', () => {
    const r = financeSettingsInput.safeParse({ yearEndMonth: 12, lockDate: '2026-10-25' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe(SETTINGS_MESSAGES.futureLock);
  });

  it('reads an empty or missing lock date as open books', () => {
    expect(financeSettingsInput.parse({ yearEndMonth: 3, lockDate: '' })).toEqual({ yearEndMonth: 3, lockDate: null });
    expect(financeSettingsInput.parse({ yearEndMonth: 3, lockDate: null })).toEqual({ yearEndMonth: 3, lockDate: null });
    expect(financeSettingsInput.parse({ yearEndMonth: 3 })).toEqual({ yearEndMonth: 3, lockDate: null });
  });

  it.each([0, 13, 6.5, '6', null])('refuses the year end month %s', (yearEndMonth) => {
    const r = financeSettingsInput.safeParse({ yearEndMonth, lockDate: null });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('Choose the month your financial year ends.');
  });

  it.each(['2026-02-30', '30/09/2026', '2026-9-30'])('refuses the lock date %s', (lockDate) => {
    const r = financeSettingsInput.safeParse({ yearEndMonth: 12, lockDate });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('Enter a valid lock date.');
  });
});

describe('sequenceInput', () => {
  it('trims and upper-cases the prefix', () => {
    expect(sequenceInput.parse({ doc: 'invoice', prefix: ' inv/26- ', nextNumber: 43 })).toEqual({ doc: 'invoice', prefix: 'INV/26-', nextNumber: 43 });
  });

  it.each(['', '   ', 'INV_', 'INVOICE-2026', 'INV 1'])('refuses the prefix %j', (prefix) => {
    const r = sequenceInput.safeParse({ doc: 'invoice', prefix, nextNumber: 1 });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe(SETTINGS_MESSAGES.badPrefix);
  });

  it.each([0, -1, 1.5, 1_000_000_000])('refuses the next number %s', (nextNumber) => {
    expect(sequenceInput.safeParse({ doc: 'invoice', prefix: 'INV-', nextNumber }).success).toBe(false);
  });

  it('takes every numbered document and nothing else', () => {
    for (const { doc } of settings.SEQUENCE_DOCS) {
      expect(sequenceInput.safeParse({ doc, prefix: 'X', nextNumber: 1 }).success, doc).toBe(true);
    }
    expect(sequenceInput.safeParse({ doc: 'payslip', prefix: 'X', nextNumber: 1 }).success).toBe(false);
  });
});

describe('getFinanceSettings', () => {
  it('reads the workspace row', async () => {
    const { client, calls } = stubClient({ data: { year_end_month: 6, lock_date: '2026-06-30', updated_at: '2026-10-01T00:00:00Z' } });
    expect(await getFinanceSettings(ctxOf(client))).toEqual({ yearEndMonth: 6, lockDate: '2026-06-30', updatedAt: '2026-10-01T00:00:00Z' });
    expect(calls).toContainEqual({ kind: 'from', args: ['finance_settings'] });
    expect(calls).toContainEqual({ kind: 'eq', args: ['org_id', 'org1'] });
  });

  it('answers the defaults when nothing has been saved', async () => {
    const { client } = stubClient({ data: null });
    expect(await getFinanceSettings(ctxOf(client))).toEqual(DEFAULT_FINANCE_SETTINGS);
  });

  it('throws on a failed read, and the report fallback logs and answers the defaults', async () => {
    const { client } = stubClient({ error: { code: '500', message: 'down' } });
    await expect(getFinanceSettings(ctxOf(client))).rejects.toMatchObject({ message: 'down' });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await financeSettingsOrDefault(ctxOf(client), 'test')).toEqual(DEFAULT_FINANCE_SETTINGS);
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});

describe('saveFinanceSettings', () => {
  it('upserts on the workspace and answers the saved row', async () => {
    const { client, calls } = stubClient({ data: { year_end_month: 6, lock_date: null, updated_at: 't' } });
    expect(await saveFinanceSettings(ctxOf(client), { yearEndMonth: 6, lockDate: null })).toEqual({
      ok: true,
      data: { yearEndMonth: 6, lockDate: null, updatedAt: 't' },
    });
    expect(calls).toContainEqual({ kind: 'upsert', args: [{ org_id: 'org1', year_end_month: 6, lock_date: null }, { onConflict: 'org_id' }] });
  });

  it('tells a member who may, and a future lock why', async () => {
    expect(await saveFinanceSettings(ctxOf(stubClient({ error: { code: '42501', message: 'rls' } }).client), { yearEndMonth: 12, lockDate: null })).toEqual({
      ok: false,
      error: SETTINGS_NEEDS_SIGN_OFF,
    });
    expect(
      await saveFinanceSettings(ctxOf(stubClient({ error: { code: 'FIN64', message: 'future' } }).client), { yearEndMonth: 12, lockDate: '2027-01-01' }),
    ).toEqual({ ok: false, error: SETTINGS_MESSAGES.futureLock });
  });
});

describe('listSequences', () => {
  it('answers every document in order, with the defaults for one the database did not return', async () => {
    const { client, calls } = stubClient({
      data: [
        { doc_type: 'journal', prefix: 'JV-', next_number: 9, pad: 4 },
        { doc_type: 'invoice', prefix: 'INV/26-', next_number: 43, pad: 5 },
        { doc_type: 'something_else', prefix: 'Z', next_number: 1, pad: 4 },
      ],
    });
    const rows = await listSequences(ctxOf(client));
    expect(calls).toContainEqual({ kind: 'rpc', args: ['finance_sequence_list', { target_org: 'org1' }] });
    expect(rows.map((r) => r.doc)).toEqual(settings.SEQUENCE_DOCS.map((d) => d.doc));
    expect(rows[0]).toEqual({ doc: 'invoice', label: 'Invoice', prefix: 'INV/26-', nextNumber: 43, pad: 5 });
    expect(rows.find((r) => r.doc === 'journal')).toMatchObject({ prefix: 'JV-', nextNumber: 9 });
    expect(rows.find((r) => r.doc === 'quotation')).toEqual({ doc: 'quotation', label: 'Quotation', prefix: 'QT-', nextNumber: 1, pad: 4 });
  });

  it('throws on a failed read', async () => {
    await expect(listSequences(ctxOf(stubClient({ error: { code: '500', message: 'down' } }).client))).rejects.toBeTruthy();
  });
});

describe('setSequence', () => {
  const input = { doc: 'invoice' as const, prefix: 'INV-', nextNumber: 43 };

  it('sends the change to finance_set_sequence', async () => {
    const { client, calls } = stubClient();
    expect(await setSequence(ctxOf(client), input)).toEqual({ ok: true, data: null });
    expect(calls).toContainEqual({
      kind: 'rpc',
      args: ['finance_set_sequence', { target_org: 'org1', doc: 'invoice', new_prefix: 'INV-', new_next: 43 }],
    });
  });

  it.each([
    [{ code: 'FIN65', message: "The next number can't go back: it must be 57 or more." }, SETTINGS_MESSAGES.numberBack(57)],
    [{ code: 'FIN66', message: 'bad prefix' }, SETTINGS_MESSAGES.badPrefix],
    [{ code: '42501', message: 'not allowed' }, NOT_ALLOWED],
  ])('maps %o', async (error, message) => {
    expect(await setSequence(ctxOf(stubClient({ error }).client), input)).toEqual({ ok: false, error: message });
  });

  it('answers anything else with the general message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await setSequence(ctxOf(stubClient({ error: { code: '22023', message: 'unknown document type' } }).client), input)).toEqual({
      ok: false,
      error: WRITE_FAILED,
    });
    log.mockRestore();
  });
});

describe('formatSequence', () => {
  it('pads the number to the width, and never cuts a longer one', () => {
    expect(formatSequence({ prefix: 'INV-', nextNumber: 43, pad: 4 })).toBe('INV-0043');
    expect(formatSequence({ prefix: 'PO/', nextNumber: 1, pad: 6 })).toBe('PO/000001');
    expect(formatSequence({ prefix: 'JV-', nextNumber: 123456, pad: 4 })).toBe('JV-123456');
  });
});

describe('writeFailed and the settings refusals', () => {
  it('answers FIN63 with the lock date the database names', () => {
    const message = 'This date is in a closed period: the books are locked to 30 Sep 2026.';
    expect(writeFailed('postInvoice', { code: 'FIN63', message })).toEqual({ ok: false, error: SETTINGS_MESSAGES.locked('30 Sep 2026') });
    expect(writeFailed('postInvoice', { code: 'FIN63', message: 'locked', details: 'Books locked to 1 Jan 2026' })).toEqual({
      ok: false,
      error: SETTINGS_MESSAGES.locked('1 Jan 2026'),
    });
  });

  it('answers FIN63 without a date in general words', () => {
    expect(writeFailed('postInvoice', { code: 'FIN63', message: 'locked' })).toEqual({
      ok: false,
      error: 'This date is in a closed period: the books are locked.',
    });
  });

  it('answers FIN64–FIN67 in their own words, without logging', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(writeFailed('x', { code: 'FIN64', message: '' }).error).toBe(SETTINGS_MESSAGES.futureLock);
    expect(writeFailed('x', { code: 'FIN65', message: 'it must be 12 or more' }).error).toBe(SETTINGS_MESSAGES.numberBack(12));
    expect(writeFailed('x', { code: 'FIN65', message: 'no number' }).error).toBe("The next number can't go back.");
    expect(writeFailed('x', { code: 'FIN66', message: '' }).error).toBe(SETTINGS_MESSAGES.badPrefix);
    expect(writeFailed('x', { code: 'FIN67', message: '' }).error).toBe(SETTINGS_MESSAGES.prefixTaken);
    expect(SETTINGS_MESSAGES.prefixTaken).toBe('Another document already uses this prefix.');
    expect(settingsRefusal({ code: 'FIN67', message: 'Another document already uses this prefix.' })).toBe(
      'Another document already uses this prefix.',
    );
    // The lock date as the database now writes it (no leading zero), and as it wrote it before.
    expect(settingsRefusal({ code: 'FIN63', message: 'This date is in a closed period: the books are locked to 5 Dec 1999.' })).toBe(
      SETTINGS_MESSAGES.locked('5 Dec 1999'),
    );
    expect(settingsRefusal({ code: 'FIN63', message: 'This date is in a closed period: the books are locked to 05 Dec 1999.' })).toBe(
      SETTINGS_MESSAGES.locked('05 Dec 1999'),
    );
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('leaves every other code as it was', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(writeFailed('x', { code: 'FIN62', message: 'discount' })).toEqual({ ok: false, error: WRITE_FAILED });
    expect(writeFailed('x', new Error('boom'))).toEqual({ ok: false, error: WRITE_FAILED });
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});

describe('the settings actions', () => {
  const PATHS = ['/finance/settings', '/finance/reports', '/finance/dashboard', '/finance/assistant'];

  it.each(['owner', 'admin'])('save the year end and lock for an %s and refresh the screens that use them', async (role) => {
    ctl.viewer.role = role;
    const { client, calls } = stubClient({ data: { year_end_month: 6, lock_date: null, updated_at: 't' } });
    ctl.client = client;
    expect(await saveFinanceSettingsAction({ yearEndMonth: 6, lockDate: '' })).toEqual({
      ok: true,
      data: { yearEndMonth: 6, lockDate: null, updatedAt: 't' },
    });
    expect(calls).toContainEqual({ kind: 'upsert', args: [{ org_id: 'org1', year_end_month: 6, lock_date: null }, { onConflict: 'org_id' }] });
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('set a sequence with the prefix normalised', async () => {
    const { client, calls } = stubClient();
    ctl.client = client;
    expect(await setSequenceAction({ doc: 'bill', prefix: ' bill/ ', nextNumber: 7 })).toEqual({ ok: true, data: null });
    expect(calls).toContainEqual({
      kind: 'rpc',
      args: ['finance_set_sequence', { target_org: 'org1', doc: 'bill', new_prefix: 'BILL/', new_next: 7 }],
    });
    expect(ctl.revalidated).toEqual(PATHS);
  });

  it('tell a member who may, before anything is sent', async () => {
    ctl.viewer.role = 'member';
    const { client, calls } = stubClient();
    ctl.client = client;
    expect(await saveFinanceSettingsAction({ yearEndMonth: 6, lockDate: null })).toEqual({ ok: false, error: SETTINGS_NEEDS_SIGN_OFF });
    expect(await setSequenceAction({ doc: 'bill', prefix: 'B-', nextNumber: 7 })).toEqual({ ok: false, error: SETTINGS_NEEDS_SIGN_OFF });
    expect(calls).toEqual([]);
  });

  it('refuse a viewer and the demo', async () => {
    const { client, calls } = stubClient();
    ctl.client = client;
    ctl.viewer.role = 'viewer';
    expect(await saveFinanceSettingsAction({ yearEndMonth: 6, lockDate: null })).toEqual({ ok: false, error: NOT_ALLOWED });
    ctl.viewer = { userId: 'u1', orgId: 'org1', role: 'owner', isDemo: true };
    expect(await setSequenceAction({ doc: 'bill', prefix: 'B-', nextNumber: 7 })).toEqual({ ok: false, error: NOT_ALLOWED });
    expect(calls).toEqual([]);
  });

  it('refuse a bad input before anything is sent', async () => {
    const { client, calls } = stubClient();
    ctl.client = client;
    expect(await setSequenceAction({ doc: 'bill', prefix: 'BAD PREFIX', nextNumber: 7 })).toEqual({ ok: false, error: SETTINGS_MESSAGES.badPrefix });
    expect(calls).toEqual([]);
  });
});

describe('the company TIN', () => {
  it('is trimmed and upper-cased, up to 20 letters and numbers, or empty', () => {
    expect(tinField.parse(' c2584563200 ')).toBe('C2584563200');
    expect(tinField.parse('')).toBe('');
    expect(tinField.parse('A'.repeat(20))).toBe('A'.repeat(20));
    for (const bad of ['A'.repeat(21), 'C 258', 'C-258', 'IG/1']) {
      const r = tinField.safeParse(bad);
      expect(r.success, bad).toBe(false);
      expect(r.error?.issues[0]?.message).toBe(TIN_MESSAGE);
    }
  });

  function companyForm(tin: string) {
    const data = new FormData();
    data.set('name', 'Rimba Ventures Sdn Bhd');
    data.set('tin', tin);
    return data;
  }

  it('is saved on the company, upper-cased, and an empty box clears it', async () => {
    const { client, calls } = stubClient({ data: [{ id: 'org1' }] });
    ctl.client = client;
    expect(await updateCompanyAction(undefined, companyForm(' c2584563200 '))).toMatchObject({ notice: expect.any(String) });
    expect(calls.find((c) => c.kind === 'update')?.args[0]).toMatchObject({ tin: 'C2584563200' });

    const second = stubClient({ data: [{ id: 'org1' }] });
    ctl.client = second.client;
    await updateCompanyAction(undefined, companyForm(''));
    expect(second.calls.find((c) => c.kind === 'update')?.args[0]).toMatchObject({ tin: null });
  });

  it('refuses a bad TIN before anything is written', async () => {
    const { client, calls } = stubClient({ data: [{ id: 'org1' }] });
    ctl.client = client;
    expect(await updateCompanyAction(undefined, companyForm('C-2584'))).toEqual({ error: TIN_MESSAGE });
    expect(calls).toEqual([]);
  });
});
