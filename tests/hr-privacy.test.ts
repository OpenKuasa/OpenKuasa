import { describe, expect, it } from 'vitest';
import { touchedPeople, withoutPeopleTurns } from '@/lib/chat/hr-privacy';
import { ALL_PEOPLE_TOOL_NAMES } from '@/lib/ai/products';
import { createPeopleTools } from '@/lib/ai/people-tools';
import { createSeedPeopleData } from '@/lib/people/seed';

const part = (type: string) => ({ type });
const text = (t: string) => ({ type: 'text', text: t });

describe('touchedPeople', () => {
  it('is true when Tuah asked Lekiu (team mode)', () => {
    expect(touchedPeople([part('tool-askLekiu')])).toBe(true);
  });

  it('is true when an HR tool ran directly (single-agent mode)', () => {
    expect(touchedPeople([part('tool-getPayrollSummary')])).toBe(true);
    expect(touchedPeople([part('tool-decideLeave')])).toBe(true);
    expect(touchedPeople([part('tool-listEmployees')])).toBe(true);
  });

  it('is false for the other specialists and for plain tools', () => {
    expect(touchedPeople([part('tool-askJebat'), part('tool-askKasturi'), part('tool-askLekir')])).toBe(false);
    expect(touchedPeople([part('tool-getCampaigns'), text('six jobs are open')])).toBe(false);
    expect(touchedPeople([text('hello')])).toBe(false);
    expect(touchedPeople([])).toBe(false);
  });

  it('catches an applyChange on an HR proposal from an earlier turn (no askLekiu present)', () => {
    const peopleProposal = { id: 'p1', product: 'people', action: 'decideLeave', input: {}, title: 'Approve leave?', detail: null };
    const crmProposal = { id: 'c1', product: 'crm', action: 'createContact', input: {}, title: 'Add?', detail: null };
    const proposals = new Map([[peopleProposal.id, peopleProposal], [crmProposal.id, crmProposal]]);
    const applyPart = (id: string) => ({ type: 'tool-applyChange', input: { proposalId: id }, output: { ok: true } });

    // The decisive case: a bare applyChange, no askLekiu in this message.
    expect(touchedPeople([applyPart('p1')], proposals)).toBe(true);
    // A non-HR apply stays out of the HR net.
    expect(touchedPeople([applyPart('c1')], proposals)).toBe(false);
    // Without the proposal map we cannot tell; the tool name alone is not HR.
    expect(touchedPeople([applyPart('p1')])).toBe(false);
  });
});

describe('withoutPeopleTurns', () => {
  it('drops an HR turn and the question that prompted it, keeping the rest', () => {
    const messages = [
      { role: 'user', parts: [text('how many campaigns?')] },
      { role: 'assistant', parts: [part('tool-getCampaigns'), text('three campaigns')] },
      { role: 'user', parts: [text("what is Ali's salary?")] },
      { role: 'assistant', parts: [part('tool-askLekiu'), text('Ali earns RM 6,000')] },
      { role: 'user', parts: [text('and the open jobs?')] },
      { role: 'assistant', parts: [text('six jobs are open')] },
    ];
    const kept = withoutPeopleTurns(messages);
    const flat = JSON.stringify(kept);
    expect(flat).not.toContain('salary');
    expect(flat).not.toContain('RM 6,000');
    expect(flat).toContain('three campaigns');
    expect(flat).toContain('six jobs are open');
    expect(kept).toHaveLength(4);
  });

  it('leaves a conversation with no HR untouched', () => {
    const messages = [
      { role: 'user', parts: [text('hi')] },
      { role: 'assistant', parts: [part('tool-getLeadSummary'), text('ok')] },
    ];
    expect(withoutPeopleTurns(messages)).toHaveLength(2);
  });

  it('drops a cross-turn HR apply when given the proposal map', () => {
    const proposals = new Map([
      ['p1', { id: 'p1', product: 'people', action: 'decideLeave', input: {}, title: 'Approve?', detail: null }],
    ]);
    const messages = [
      { role: 'user', parts: [text('go ahead with the leave decision')] },
      { role: 'assistant', parts: [{ type: 'tool-applyChange', input: { proposalId: 'p1' } }, text('Leave approved.')] },
      { role: 'user', parts: [text('open jobs?')] },
      { role: 'assistant', parts: [text('six jobs are open')] },
    ];
    const kept = withoutPeopleTurns(messages, proposals);
    const flat = JSON.stringify(kept);
    expect(flat).not.toContain('Leave approved');
    expect(flat).not.toContain('leave decision');
    expect(flat).toContain('six jobs are open');
  });
});

describe('ALL_PEOPLE_TOOL_NAMES', () => {
  it('covers every tool createPeopleTools can return, so a turn is never missed', () => {
    const now = new Date('2026-10-09T04:00:00Z');
    const data = createSeedPeopleData(now);
    // A linked owner/admin with full write produces the widest tool set
    // (lookups, previews, clock and every change).
    const viewer = { employeeId: 'seed-emp-2', isHr: true, isDemo: false };
    const write = {
      ctx: { client: {} as never, orgId: 'org-1' },
      tier: 'hr' as const,
      employeeId: 'seed-emp-2',
      receipt: null,
      userId: 'u1',
    };
    const names = Object.keys(createPeopleTools(data, viewer, () => now, write));
    expect(names.length).toBeGreaterThan(40);
    const missing = names.filter((name) => !ALL_PEOPLE_TOOL_NAMES.has(name));
    expect(missing).toEqual([]);
    // Spot-check the sensitive ones are in the set.
    for (const name of ['getPayrollSummary', 'listPayslips', 'decideLeave', 'getMyAttendanceToday', 'previewOvertime', 'setReportsTo', 'listMyTeam', 'getWaitingForMe']) {
      expect(ALL_PEOPLE_TOOL_NAMES.has(name), name).toBe(true);
    }
  });
});
