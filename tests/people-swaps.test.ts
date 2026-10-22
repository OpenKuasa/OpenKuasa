import { describe, expect, it, vi } from 'vitest';
import {
  RECENT_SWAPS,
  type ShiftSwap,
  type SwapOption,
  buildMySwaps,
  buildSwapApprovals,
  listSwapOptions,
  listSwaps,
  swapAllowed,
  swapChoices,
  swapRow,
} from '@/lib/people/swaps';
import type { Employee, PeopleViewer, ShiftType } from '@/lib/people/types';

const TODAY = '2026-10-22';
const type = (id: string, name: string, is_off = false, start: string | null = null, end: string | null = null): ShiftType => ({
  id, name, start_time: start, end_time: end, is_off, color: 'sky', archived: false,
});
const TYPES: Record<string, ShiftType> = {
  m: type('m', 'Morning', false, '09:00', '18:00'),
  n: type('n', 'Night', false, '21:00', '06:00'),
  o: type('o', 'Off', true),
};
const opt = (shift_id: string, employee_id: string, work_date: string, shift_type_id: string, mine = false): SwapOption => ({
  shift_id, employee_id, employee_name: employee_id.toUpperCase(), work_date, shift_type_id, mine,
});
const employees = (['me', 'b', 'c', 'boss'] as const).map((id) => ({ id, name: `Person ${id}` }) as unknown as Employee);
const swap = (over: Partial<ShiftSwap> = {}): ShiftSwap => ({
  id: 's1',
  requester_employee_id: 'me',
  colleague_employee_id: 'b',
  requester_date: '2026-10-26',
  requester_type_id: 'm',
  colleague_date: '2026-10-26',
  colleague_type_id: 'n',
  note: null,
  status: 'requested',
  decision_note: null,
  created_at: '2026-10-22T01:00:00Z',
  ...over,
});
const member: PeopleViewer = { employeeId: 'me', isHr: false, isDemo: false };

describe('swapAllowed', () => {
  const mine = opt('a', 'me', '2026-10-26', 'm', true);

  it('takes the same day with another type, and refuses the same type', () => {
    expect(swapAllowed(mine, opt('x', 'b', '2026-10-26', 'n'), [], TYPES)).toBe(true);
    expect(swapAllowed(mine, opt('x', 'b', '2026-10-26', 'm'), [], TYPES)).toBe(false);
  });

  it('takes another day when neither works the other\'s day (an off day there is fine)', () => {
    const theirs = opt('x', 'b', '2026-10-27', 'n');
    expect(swapAllowed(mine, theirs, [mine, theirs], TYPES)).toBe(true);
    expect(swapAllowed(mine, theirs, [mine, theirs, opt('y', 'me', '2026-10-27', 'o', true)], TYPES)).toBe(true);
  });

  it('refuses another day when either already works the other\'s day', () => {
    const theirs = opt('x', 'b', '2026-10-27', 'n');
    expect(swapAllowed(mine, theirs, [mine, theirs, opt('y', 'me', '2026-10-27', 'm', true)], TYPES)).toBe(false);
    expect(swapAllowed(mine, theirs, [mine, theirs, opt('z', 'b', '2026-10-26', 'n')], TYPES)).toBe(false);
  });

  it('refuses a swap that would change nothing', () => {
    const offMine = opt('a', 'me', '2026-10-26', 'o', true);
    const offTheirs = opt('x', 'b', '2026-10-27', 'o');
    const all = [offMine, offTheirs, opt('y', 'me', '2026-10-27', 'o', true), opt('z', 'b', '2026-10-26', 'o')];
    expect(swapAllowed(offMine, offTheirs, all, TYPES)).toBe(false);
  });

  it('refuses your own shift on the other side, and a colleague\'s on yours', () => {
    expect(swapAllowed(mine, opt('y', 'me', '2026-10-27', 'n', true), [], TYPES)).toBe(false);
    expect(swapAllowed(opt('x', 'b', '2026-10-26', 'n'), mine, [], TYPES)).toBe(false);
  });
});

describe('swapChoices', () => {
  it('lists my shifts that have a partner, each with the colleagues\' shifts it may go for', () => {
    const options = [
      opt('a', 'me', '2026-10-26', 'm', true),
      opt('a2', 'me', '2026-10-28', 'm', true),
      opt('x', 'b', '2026-10-26', 'n'),
      opt('y', 'c', '2026-10-28', 'm'),
    ];
    const choices = swapChoices({ options, types: TYPES, swaps: [] });
    expect(choices.mine).toEqual([{ shift_id: 'a', label: '26 Oct · Morning · 09:00–18:00' }]);
    expect(choices.theirs.a).toEqual([{ shift_id: 'x', label: 'B · 26 Oct · Night · 21:00–06:00 (overnight)' }]);
    expect(choices.theirs.a2).toEqual([]);
  });

  it('leaves out a cell already in an open swap, on either side', () => {
    const options = [opt('a', 'me', '2026-10-26', 'm', true), opt('x', 'b', '2026-10-26', 'n'), opt('y', 'c', '2026-10-26', 'o')];
    const open = swap({ requester_employee_id: 'c', colleague_employee_id: 'b', requester_date: '2026-10-26', colleague_date: '2026-10-26', status: 'accepted' });
    expect(swapChoices({ options, types: TYPES, swaps: [open] }).theirs.a).toEqual([]);
    const closed = { ...open, status: 'declined' as const };
    expect(swapChoices({ options, types: TYPES, swaps: [closed] }).theirs.a.map((c) => c.shift_id)).toEqual(['x', 'y']);
    const mineOpen = swap({ status: 'requested' });
    expect(swapChoices({ options, types: TYPES, swaps: [mineOpen] }).mine).toEqual([]);
  });
});

describe('swapRow', () => {
  const names = new Map([['me', 'Aisyah'], ['b', 'Bala']]);

  it('names both people and both shifts', () => {
    expect(swapRow(swap({ note: 'Dentist' }), names, TYPES, TODAY)).toEqual({
      id: 's1', requester: 'Aisyah', colleague: 'Bala',
      gives: '26 Oct · Morning · 09:00–18:00', takes: '26 Oct · Night · 21:00–06:00 (overnight)',
      note: 'Dentist', decision_note: null, status: 'requested', expired: false,
      status_label: 'Waiting for the colleague', tone: 'pending',
    });
  });

  it('marks an open swap whose day has come as expired, and a closed one never', () => {
    expect(swapRow(swap({ requester_date: TODAY }), names, TYPES, TODAY)).toMatchObject({ expired: true, status_label: 'Expired', tone: 'neutral' });
    expect(swapRow(swap({ colleague_date: '2026-10-01', status: 'accepted' }), names, TYPES, TODAY)).toMatchObject({ expired: true });
    expect(swapRow(swap({ requester_date: TODAY, status: 'approved' }), names, TYPES, TODAY)).toMatchObject({ expired: false, tone: 'good', status_label: 'Approved' });
  });

  it('copes with a person or type no longer listed', () => {
    expect(swapRow(swap({ colleague_employee_id: 'gone', colleague_type_id: 'zz' }), names, TYPES, TODAY)).toMatchObject({
      colleague: 'A former employee', takes: '26 Oct · Shift',
    });
  });
});

describe('buildMySwaps', () => {
  it('shows only my swaps: those asking me to reply first, with the right controls', () => {
    const swaps = [
      swap({ id: 'asked', status: 'requested' }),
      swap({ id: 'incoming', requester_employee_id: 'b', colleague_employee_id: 'me' }),
      swap({ id: 'agreed', requester_employee_id: 'c', colleague_employee_id: 'me', status: 'accepted' }),
      swap({ id: 'others', requester_employee_id: 'b', colleague_employee_id: 'c' }),
      swap({ id: 'done', status: 'approved' }),
      swap({ id: 'stale', requester_employee_id: 'b', colleague_employee_id: 'me', requester_date: TODAY }),
    ];
    const model = buildMySwaps({ swaps, viewer: member, employees, types: TYPES, today: TODAY });
    expect(model.open.map((r) => [r.id, r.can_reply, r.can_cancel, r.asked])).toEqual([
      ['incoming', true, false, false],
      ['asked', false, true, true],
      ['agreed', false, true, false],
      ['stale', false, true, false],
    ]);
    expect(model.recent.map((r) => r.id)).toEqual(['done']);
    expect(model.waiting_for_you).toBe(1);
  });

  it('is empty for an account with no linked record', () => {
    expect(buildMySwaps({ swaps: [swap()], viewer: { ...member, employeeId: null }, employees, types: TYPES, today: TODAY })).toEqual({
      open: [], recent: [], waiting_for_you: 0,
    });
  });

  it('keeps the recent list short', () => {
    const swaps = Array.from({ length: RECENT_SWAPS + 3 }, (_, i) => swap({ id: `d${i}`, status: 'cancelled' }));
    expect(buildMySwaps({ swaps, viewer: member, employees, types: TYPES, today: TODAY }).recent).toHaveLength(RECENT_SWAPS);
  });
});

describe('buildSwapApprovals', () => {
  const swaps = [
    swap({ id: 'ready', requester_employee_id: 'b', colleague_employee_id: 'c', status: 'accepted' }),
    swap({ id: 'asking', requester_employee_id: 'b', colleague_employee_id: 'c', status: 'requested' }),
    swap({ id: 'own', requester_employee_id: 'me', colleague_employee_id: 'b', status: 'accepted' }),
    swap({ id: 'late', requester_employee_id: 'b', colleague_employee_id: 'c', status: 'accepted', requester_date: TODAY }),
    swap({ id: 'old', requester_employee_id: 'b', colleague_employee_id: 'c', status: 'rejected' }),
  ];

  it('gives an admin every swap, their own not decidable', () => {
    const admin: PeopleViewer = { employeeId: 'me', isHr: true, isDemo: false };
    const model = buildSwapApprovals({ swaps, viewer: admin, employees, types: TYPES, today: TODAY });
    expect(model.waiting.map((r) => [r.id, r.decidable])).toEqual([['ready', true], ['own', false]]);
    expect(model.with_colleague.map((r) => r.id)).toEqual(['asking']);
    expect(model.recent.map((r) => r.id)).toEqual(['late', 'old']);
  });

  it('lets the owner decide their own', () => {
    const ownerViewer: PeopleViewer = { employeeId: 'me', isHr: true, isOwner: true, isDemo: false };
    const model = buildSwapApprovals({ swaps, viewer: ownerViewer, employees, types: TYPES, today: TODAY });
    expect(model.waiting.find((r) => r.id === 'own')?.decidable).toBe(true);
  });

  it('leaves a manager\'s own swaps out of their queue', () => {
    const manager: PeopleViewer = { employeeId: 'me', isHr: false, isDemo: false, managesTeam: true };
    const model = buildSwapApprovals({ swaps, viewer: manager, employees, types: TYPES, today: TODAY });
    expect(model.waiting.map((r) => r.id)).toEqual(['ready']);
    expect(model.waiting.every((r) => r.decidable)).toBe(true);
  });
});

describe('reading swaps', () => {
  it('reads the workspace\'s swaps newest first, with a limit', async () => {
    const calls: unknown[][] = [];
    const chain = {
      select: (...a: unknown[]) => (calls.push(['select', ...a]), chain),
      eq: (...a: unknown[]) => (calls.push(['eq', ...a]), chain),
      order: (...a: unknown[]) => (calls.push(['order', ...a]), chain),
      limit: async (n: number) => (calls.push(['limit', n]), { data: [swap()], error: null }),
    };
    const client = { from: vi.fn(() => chain) };
    expect(await listSwaps({ client: client as never, orgId: 'o1' })).toEqual([swap()]);
    expect(client.from).toHaveBeenCalledWith('hr_shift_swaps');
    expect(calls).toContainEqual(['eq', 'org_id', 'o1']);
    expect(calls).toContainEqual(['order', 'created_at', { ascending: false }]);
    expect(calls).toContainEqual(['limit', 200]);
  });

  it('throws on a failed read, naming the code only', async () => {
    const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: async () => ({ data: null, error: { code: '42P01', message: 'secret' } }) };
    await expect(listSwaps({ client: { from: () => chain } as never, orgId: 'o1' })).rejects.toThrow(/42P01/);
  });

  it('asks hr_swap_options for the workspace', async () => {
    const rpc = vi.fn(async () => ({ data: [opt('a', 'me', '2026-10-26', 'm', true)], error: null }));
    expect(await listSwapOptions({ client: { rpc } as never, orgId: 'o1' })).toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith('hr_swap_options', { p_org: 'o1' });
    const failing = vi.fn(async () => ({ data: null, error: { code: 'X1' } }));
    await expect(listSwapOptions({ client: { rpc: failing } as never, orgId: 'o1' })).rejects.toThrow(/X1/);
  });
});
