import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTeam, readMyTeam } from '@/lib/people/my-team';
import {
  ZERO_WAITING,
  parseWaitingCounts,
  readWaitingCounts,
  readWaitingCountsStrict,
  shouldReadWaiting,
  waitingTotal,
} from '@/lib/people/waiting-counts';

type Reply = { data: unknown; error: { code?: string; message?: string } | null };
const fakeClient = (impl: () => Promise<Reply>) => {
  const rpc = vi.fn(impl);
  return { client: { rpc } as never, rpc };
};

afterEach(() => vi.restoreAllMocks());

describe('parseWaitingCounts', () => {
  it('reads the four figures', () => {
    expect(parseWaitingCounts({ leave: 2, time_off: 0, claims: 1, overtime: 3 })).toEqual({
      leave: 2, time_off: 0, claims: 1, overtime: 3,
    });
  });

  it.each([null, 'x', [], {}, { leave: '2' }])('reads %j as zeros', (value) => {
    expect(parseWaitingCounts(value)).toEqual(ZERO_WAITING);
  });

  it('runs each figure through safeCount', () => {
    expect(parseWaitingCounts({ leave: -1, time_off: 1.9, claims: NaN, overtime: Infinity })).toEqual({
      leave: 0, time_off: 1, claims: 0, overtime: 0,
    });
  });

  it('sums the four', () => {
    expect(waitingTotal({ leave: 1, time_off: 2, claims: 3, overtime: 4 })).toBe(10);
  });
});

describe('shouldReadWaiting', () => {
  it.each([
    [{ isDemo: true, orgId: 'o1' }, false],
    [{ isDemo: false, orgId: null }, false],
    [{ isDemo: false, orgId: '' }, false],
    [{ isDemo: false, orgId: 'o1' }, true],
  ] as const)('%j: %s', (input, expected) => {
    expect(shouldReadWaiting(input)).toBe(expected);
  });
});

describe('readWaitingCounts', () => {
  it('asks the database once and returns the parsed reply', async () => {
    const { client, rpc } = fakeClient(async () => ({
      data: { leave: 2, time_off: 1, claims: 0, overtime: 4 },
      error: null,
    }));
    expect(await readWaitingCounts({ client, orgId: 'o1' })).toEqual({ leave: 2, time_off: 1, claims: 0, overtime: 4 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('hr_waiting_counts', { p_org: 'o1' });
  });

  it('reads an error as zeros and logs the code only', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeClient(async () => ({ data: null, error: { code: '42883', message: 'secret-org-id-123' } }));
    expect(await readWaitingCounts({ client, orgId: 'secret-org-id-123' })).toEqual(ZERO_WAITING);
    expect(spy).toHaveBeenCalledTimes(1);
    const text = spy.mock.calls[0].map(String).join(' ');
    expect(text).toContain('42883');
    expect(text).not.toContain('secret-org-id-123');
  });

  it('never throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeClient(async () => {
      throw new Error('network down');
    });
    expect(await readWaitingCounts({ client, orgId: 'o1' })).toEqual(ZERO_WAITING);
  });
});

describe('readWaitingCountsStrict', () => {
  it('returns the parsed reply', async () => {
    const { client, rpc } = fakeClient(async () => ({ data: { leave: 1, time_off: 0, claims: 0, overtime: 2 }, error: null }));
    expect(await readWaitingCountsStrict({ client, orgId: 'o1' })).toEqual({ leave: 1, time_off: 0, claims: 0, overtime: 2 });
    expect(rpc).toHaveBeenCalledWith('hr_waiting_counts', { p_org: 'o1' });
  });

  it('throws on a database error instead of reading zeros', async () => {
    const { client } = fakeClient(async () => ({ data: null, error: { code: '42883' } }));
    await expect(readWaitingCountsStrict({ client, orgId: 'o1' })).rejects.toThrow('42883');
  });

  it('throws when the call itself fails', async () => {
    const { client } = fakeClient(async () => {
      throw new Error('network down');
    });
    await expect(readWaitingCountsStrict({ client, orgId: 'o1' })).rejects.toThrow('network down');
  });
});

describe('parseTeam', () => {
  it('keeps the ids', () => {
    expect(parseTeam(['a', 'b'])).toEqual(['a', 'b']);
  });
  it.each([[null], ['a']])('reads %j as nobody', (value) => {
    expect(parseTeam(value)).toEqual([]);
  });
  it('drops what is not a string', () => {
    expect(parseTeam([1, null, 'a'])).toEqual(['a']);
  });
});

describe('readMyTeam', () => {
  it('asks the database once', async () => {
    const { client, rpc } = fakeClient(async () => ({ data: ['r1', 'r2'], error: null }));
    expect(await readMyTeam(client, 'o1')).toEqual(['r1', 'r2']);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('hr_my_team', { p_org: 'o1' });
  });

  it('reads an error as nobody and logs the code only', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeClient(async () => ({ data: null, error: { code: '57014', message: 'secret-org-id-123' } }));
    expect(await readMyTeam(client, 'secret-org-id-123')).toEqual([]);
    const text = spy.mock.calls.map((c) => c.map(String).join(' ')).join(' ');
    expect(text).toContain('57014');
    expect(text).not.toContain('secret-org-id-123');
  });

  it('never throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeClient(async () => {
      throw new Error('network down');
    });
    expect(await readMyTeam(client, 'o1')).toEqual([]);
  });
});
