import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The three actions behind the talent pool's controls. The viewer, the database
 * client, the capabilities and the read layer are replaced: nothing here reaches
 * a database.
 */

const ctl = vi.hoisted(() => ({
  viewer: { orgId: 'org1', role: 'member', isDemo: false } as { orgId: string; role: string; isDemo: boolean },
  revalidated: [] as string[],
  calls: [] as { fn: string; ctx: { orgId: string; client: unknown }; input: unknown }[],
  result: null as unknown,
  reads: [] as { client: unknown; orgId: string }[],
  candidates: [] as unknown[],
  readThrows: null as unknown,
  picker: [] as { client: unknown; orgId: string; text: string }[],
  pickerAnswer: { people: [] as unknown[], more: false },
}));

vi.mock('next/cache', () => ({ revalidatePath: (path: string) => { ctl.revalidated.push(path); } }));
vi.mock('@/lib/auth/viewer', () => ({ getViewer: async () => ctl.viewer }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ marker: 'session' }) }));
vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => { throw new Error('the service role is never used for the talent pool'); } }));
vi.mock('@/lib/hire/supabase', () => ({
  createSupabaseHireData: (client: unknown, orgId: string) => {
    ctl.reads.push({ client, orgId });
    return {
      listCandidates: async () => {
        if (ctl.readThrows) throw ctl.readThrows;
        return ctl.candidates;
      },
    };
  },
}));
vi.mock('@/lib/hire/candidate-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hire/candidate-search')>();
  return {
    ...actual,
    readPoolPicker: async (client: unknown, orgId: string, text: string) => {
      ctl.picker.push({ client, orgId, text });
      if (ctl.readThrows) throw ctl.readThrows;
      return ctl.pickerAnswer;
    },
  };
});
vi.mock('@/lib/hire/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hire/capabilities')>();
  const record = (fn: string) => async (ctx: { orgId: string; client: unknown }, input: unknown) => {
    ctl.calls.push({ fn, ctx, input });
    return ctl.result;
  };
  return { ...actual, setPoolStatus: record('setPoolStatus'), moveToPipeline: record('moveToPipeline') };
});

const { searchPoolPickerAction, moveToPipelineAction, setPoolStatusAction } = await import('@/app/(app)/hire/actions');

const ID = '44444444-4444-4444-8444-444444444444';
const JOB = '55555555-5555-4555-8555-555555555555';
const FORBIDDEN = { ok: false, error: 'You do not have permission to make changes here.' };
const EVERY_PATH = [
  '/hire/jobs', '/hire/careers-page', '/hire/assistant', '/hire/dashboard', '/hire/applications', '/hire/candidates',
  '/hire/interviews', '/hire/settings', '/hire/talent-pool',
];
const CHANGED = { ok: true, data: { id: ID, name: 'Aina Rahman', from: 'none', to: 'available', message: 'Added Aina Rahman to the talent pool as Available.' } };

beforeEach(() => {
  ctl.viewer = { orgId: 'org1', role: 'member', isDemo: false };
  ctl.revalidated = [];
  ctl.calls = [];
  ctl.result = CHANGED;
  ctl.reads = [];
  ctl.candidates = [];
  ctl.readThrows = null;
  ctl.picker = [];
  ctl.pickerAnswer = { people: [], more: false };
});

const CHANGES = [
  ['setPoolStatus', setPoolStatusAction, { id: ID, status: 'available', only_if_outside: true }],
  ['moveToPipeline', moveToPipelineAction, { id: ID, job_id: JOB }],
] as const;

describe('who may change the talent pool', () => {
  it.each(CHANGES)('%s: a viewer and the demo workspace are refused before the capability is reached', async (_name, action, input) => {
    for (const viewer of [
      { orgId: 'org1', role: 'viewer', isDemo: false },
      { orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      expect(await action(input)).toEqual(FORBIDDEN);
    }
    expect(ctl.calls).toEqual([]);
    expect(ctl.revalidated).toEqual([]);
  });
  it.each(['owner', 'admin', 'member'])('a %s reaches the capability with the session\'s own workspace', async (role) => {
    ctl.viewer = { orgId: 'org1', role, isDemo: false };
    await setPoolStatusAction({ id: ID, status: 'passive', org_id: 'evil' });
    expect(ctl.calls).toHaveLength(1);
    expect(ctl.calls[0].ctx.orgId).toBe('org1');
    expect(ctl.calls[0].ctx.client).toEqual({ marker: 'session' });
  });
});

describe('the two change actions', () => {
  it.each(CHANGES)('%s: hands the input on, returns the result and revalidates every hiring screen, the Talent Pool among them', async (name, action, input) => {
    expect(await action(input)).toBe(CHANGED);
    expect(ctl.calls.map((c) => c.fn)).toEqual([name]);
    expect(ctl.calls[0].input).toBe(input);
    expect(ctl.revalidated).toEqual(EVERY_PATH);
    expect(ctl.revalidated).toContain('/hire/talent-pool');
  });
  it.each(CHANGES)('%s: a refusal revalidates nothing', async (_name, action, input) => {
    ctl.result = { ok: false, error: 'Aina Rahman is already in the talent pool as Passive. Nothing was changed.' };
    expect(await action(input)).toBe(ctl.result);
    expect(ctl.revalidated).toEqual([]);
  });
});

describe('searchPoolPickerAction', () => {
  it('refuses a viewer and the demo workspace before anything is read', async () => {
    for (const viewer of [
      { orgId: 'org1', role: 'viewer', isDemo: false },
      { orgId: 'org1', role: 'owner', isDemo: true },
    ]) {
      ctl.viewer = viewer;
      expect(await searchPoolPickerAction('aina')).toEqual(FORBIDDEN);
    }
    expect(ctl.picker).toEqual([]);
  });
  it('asks the database with the member\'s own client inside their workspace, and passes on the answer', async () => {
    const people = [{ id: 'c1', name: 'Aina Rahman', headline: 'Driver', location: 'Klang', skills: ['GDL'], source: 'Referral' }];
    ctl.pickerAnswer = { people, more: true };
    expect(await searchPoolPickerAction('  Aina ')).toEqual({ ok: true, data: { people, more: true } });
    expect(ctl.picker).toEqual([{ client: { marker: 'session' }, orgId: 'org1', text: 'Aina' }]);
    expect(ctl.revalidated).toEqual([]);
  });
  it('takes anything that is not text as an empty search, and cuts a long one to 80 characters', async () => {
    for (const odd of [undefined, null, 42, { name: 'x' }, ['x']]) await searchPoolPickerAction(odd);
    expect(ctl.picker.map((p) => p.text)).toEqual(['', '', '', '', '']);
    await searchPoolPickerAction('z'.repeat(200));
    expect(ctl.picker.at(-1)?.text).toHaveLength(80);
  });
  it('answers with the sentence and logs only a code when the read fails', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.readThrows = Object.assign(new Error('Person c1 could not be read'), { code: '57014' });
    expect(await searchPoolPickerAction('Person')).toEqual({ ok: false, error: 'The list could not be loaded. Check your connection and try again.' });
    expect(JSON.stringify(said.mock.calls)).not.toContain('Person c1');
    said.mockRestore();
  });
});
