import { describe, expect, it } from 'vitest';
import { peopleWriteFor } from '@/lib/ai/people-tools';
import type { PeopleViewer } from '@/lib/people/types';

/**
 * Both chat routes — Tuah's `/api/chat` and Ask-Lekiu's `/api/people/chat` — decide who may
 * change HR data the same way, through this one helper. These cases are the behaviour that
 * decision has to keep, not the text of either route. The one that catches the bug this PR
 * fixes is "a linked plain member keeps the self tier": drop the employee-id arm of the gate
 * and that member — and every manager — silently loses their tools in chat, which is the
 * regression a source-text test could not see.
 */
describe('the write access the chat routes give the HR tools', () => {
  const ctx = { client: {} as never, orgId: 'org-1' };
  const viewer = (v: Partial<PeopleViewer>): PeopleViewer => ({ employeeId: null, isHr: false, isDemo: false, ...v });
  const call = (v: Partial<PeopleViewer>) => peopleWriteFor(viewer(v), ctx, null, 'user-1');

  it('gives an owner or admin (hr) the tools, with their own employee id when they are linked', () => {
    expect(call({ isHr: true, employeeId: 'emp-1' })).toEqual({
      ctx,
      tier: 'hr',
      employeeId: 'emp-1',
      receipt: null,
      userId: 'user-1',
    });
  });

  it('keeps an unlinked owner or admin on the hr tier, with a null employee id', () => {
    expect(call({ isHr: true, employeeId: null })).toMatchObject({ tier: 'hr', employeeId: null });
  });

  it('gives a member with reports the manager tier', () => {
    expect(call({ managesTeam: true, employeeId: 'emp-2' })).toMatchObject({ tier: 'manager', employeeId: 'emp-2' });
  });

  it('keeps a linked plain member on the self tier — the tools a role-only gate used to drop', () => {
    expect(call({ employeeId: 'emp-3' })).toMatchObject({ tier: 'self', employeeId: 'emp-3' });
  });

  it('gives an unlinked non-hr member no write access', () => {
    expect(call({ employeeId: null })).toBeUndefined();
  });

  it('gives nobody in the demo write access, not even an hr owner', () => {
    expect(call({ isHr: true, employeeId: 'emp-4', isDemo: true })).toBeUndefined();
  });
});
