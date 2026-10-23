import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENTS, agentForProduct } from '@/lib/agents/registry';
import { AGENT_KEYS } from '@/lib/agents/agent-keys';
import { crmAgent } from '@/lib/agents/crm-agent';
import { reachAgent } from '@/lib/agents/reach-agent';
import {
  crmAgentNoteInput,
  crmCreateAgentNote,
  crmCreateFollowUp,
  crmFollowUpInput,
} from '@/lib/crm/agent/actions';
import { reachSetAgentCadenceInput, reachSetAgentCapInput, reachSetAgentEnabledInput } from '@/lib/agents/config';
import { reachCreateScheduleInput, reachSetWorkspaceCapsInput } from '@/lib/reach/schedule-capabilities';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

describe('registry', () => {
  it('holds both agents and finds the crm one by product', () => {
    expect([...AGENTS.keys()]).toEqual(['weekly-studio', 'crm-focus', 'finance-focus']);
    expect([...AGENT_KEYS]).toEqual([...AGENTS.keys()]);
    expect(agentForProduct('crm', AGENTS)).toBe(crmAgent);
    expect(agentForProduct('reach', AGENTS)).toBe(reachAgent);
  });

  it('has no digest, research or media', () => {
    expect(crmAgent.digest).toBeUndefined();
    expect(crmAgent.research).toBeUndefined();
    expect(crmAgent.media).toBeUndefined();
    expect(Object.keys(crmAgent.actions).sort()).toEqual(['createAgentNote', 'createFollowUp']);
  });

  it('builds the write context from the session client, org and user', () => {
    const client = {} as never;
    expect(crmAgent.buildWriteContext(client, ORG, USER)).toEqual({ client, orgId: ORG, userId: USER });
  });
});

describe('crmAgentNoteInput', () => {
  it('accepts exactly one of deal or contact', () => {
    expect(crmAgentNoteInput.safeParse({ dealId: ID, body: 'x' }).success).toBe(true);
    expect(crmAgentNoteInput.safeParse({ contactId: ID, body: 'x' }).success).toBe(true);
  });
  it('rejects both, neither, and a body over 1000', () => {
    expect(crmAgentNoteInput.safeParse({ dealId: ID, contactId: ID2, body: 'x' }).success).toBe(false);
    expect(crmAgentNoteInput.safeParse({ body: 'x' }).success).toBe(false);
    expect(crmAgentNoteInput.safeParse({ dealId: ID, body: 'x'.repeat(1001) }).success).toBe(false);
    expect(crmAgentNoteInput.safeParse({ dealId: ID, body: 'x'.repeat(1000) }).success).toBe(true);
    expect(crmAgentNoteInput.safeParse({ dealId: ID, body: '   ' }).success).toBe(false);
  });
});

describe('crmFollowUpInput', () => {
  it('needs a uuid contact, a title and a real day', () => {
    expect(crmFollowUpInput.safeParse({ contactId: ID, title: 'Call', dueDay: '2026-10-24' }).success).toBe(true);
    expect(crmFollowUpInput.safeParse({ contactId: 'nope', title: 'Call', dueDay: '2026-10-24' }).success).toBe(false);
    expect(crmFollowUpInput.safeParse({ contactId: ID, title: 'Call', dueDay: '24/10/2026' }).success).toBe(false);
    expect(crmFollowUpInput.safeParse({ contactId: ID, title: 'Call', dueDay: '2026-02-30' }).success).toBe(false);
  });
});

describe('crmAgentNoteInput keeps the exact text', () => {
  it('does not trim the body (the RPC matches the stored proposal text exactly)', () => {
    const parsed = crmAgentNoteInput.parse({ dealId: ID, body: ' Quiet for 9 days. ' });
    expect(parsed.body).toBe(' Quiet for 9 days. ');
  });
});

describe('crmCreateAgentNote', () => {
  it('calls the RPC with the three parameters', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: ID2, error: null });
    const r = await crmCreateAgentNote({ client: { rpc } as never, orgId: ORG, userId: USER }, { dealId: ID, body: 'hi' });
    expect(rpc).toHaveBeenCalledWith('crm_add_agent_note', { p_deal_id: ID, p_contact_id: null, p_body: 'hi' });
    expect(r).toEqual({ ok: true, data: { id: ID2 } });
  });

  it('returns a plain message and logs only the code on failure', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'secret detail' } });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await crmCreateAgentNote({ client: { rpc } as never, orgId: ORG, userId: USER }, { contactId: ID, body: 'hi' });
    expect(r).toEqual({ ok: false, error: 'That note could not be added.' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret detail');
    log.mockRestore();
  });
});

describe('crmCreateFollowUp', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T04:00:00.000Z')); // 12:00 on 23 Oct in Kuala Lumpur
  });
  afterEach(() => vi.useRealTimers());

  it('moves a due day that has already come to the next Kuala Lumpur day', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const ctx = { client: { from: () => ({ insert }) } as never, orgId: ORG, userId: USER };
    await crmCreateFollowUp(ctx, { contactId: ID, title: 'Call', dueDay: '2026-10-20' });
    await crmCreateFollowUp(ctx, { contactId: ID, title: 'Call', dueDay: '2026-10-23' });
    await crmCreateFollowUp(ctx, { contactId: ID, title: 'Call', dueDay: '2026-10-30' });
    expect(insert.mock.calls.map((c) => c[0].due_at)).toEqual([
      '2026-10-24T00:00:00Z',
      '2026-10-24T00:00:00Z',
      '2026-10-30T00:00:00Z',
    ]);
  });

  it('uses the Kuala Lumpur day, not the UTC day, late in the UTC evening', async () => {
    vi.setSystemTime(new Date('2026-10-23T17:00:00.000Z')); // 01:00 on 24 Oct in Kuala Lumpur
    const insert = vi.fn().mockResolvedValue({ error: null });
    await crmCreateFollowUp(
      { client: { from: () => ({ insert }) } as never, orgId: ORG, userId: USER },
      { contactId: ID, title: 'Call', dueDay: '2026-10-24' },
    );
    expect(insert.mock.calls[0][0].due_at).toBe('2026-10-25T00:00:00Z');
  });

  it('inserts a task due at midnight UTC owned by the approving user', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({ insert });
    const r = await crmCreateFollowUp(
      { client: { from } as never, orgId: ORG, userId: USER },
      { contactId: ID, title: 'Call', dueDay: '2026-10-24' },
    );
    expect(from).toHaveBeenCalledWith('crm_activities');
    expect(insert).toHaveBeenCalledWith({
      org_id: ORG,
      contact_id: ID,
      type: 'task',
      title: 'Call',
      due_at: '2026-10-24T00:00:00Z',
      owner_user_id: USER,
    });
    expect(r).toEqual({ ok: true, data: null });
  });

  it('says plainly when the contact no longer exists', async () => {
    const insert = vi.fn().mockResolvedValue({ error: { code: '23503', message: 'fk detail' } });
    const r = await crmCreateFollowUp(
      { client: { from: () => ({ insert }) } as never, orgId: ORG, userId: USER },
      { contactId: ID, title: 'Call', dueDay: '2026-10-24' },
    );
    expect(r).toEqual({ ok: false, error: 'That contact no longer exists.' });
  });

  it('never throws a raw database error', async () => {
    const insert = vi.fn().mockResolvedValue({ error: { code: '42501', message: 'fk detail' } });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await crmCreateFollowUp(
      { client: { from: () => ({ insert }) } as never, orgId: ORG, userId: USER },
      { contactId: ID, title: 'Call', dueDay: '2026-10-24' },
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('fk detail');
    log.mockRestore();
  });
});

describe('proposal settings', () => {
  const p = crmAgent.proposals;
  it('puts the read-back in the pick prompt and never the raw focus', () => {
    const prompt = p.pickPrompt('Open deals: 2.\nWhat the owner asked to watch:\n- Deals quiet for 14 days', '0. Follow up on A');
    expect(prompt).toContain('What the owner asked to watch');
    expect(prompt).toContain('0. Follow up on A');
    expect(prompt).toContain('at most 5');
  });

  it('keys the dedupe by action, check and record', () => {
    const k = p.dedupeKey!;
    expect(k('createAgentNote', { dealId: ID, body: 'a' }, 'deal_quiet')).not.toBe(
      k('createAgentNote', { dealId: ID, body: 'a' }, 'deal_closing_soon'),
    );
    expect(k('createFollowUp', { contactId: ID }, 'contact_idle')).toBe(`createFollowUp:contact_idle:${ID}`);
    expect(p.cooldownDays).toBe(14);
    expect(p.expiresInDays).toBe(7);
  });
});

describe('reach inputs are locked to Jebat', () => {
  it('rejects crm-focus', () => {
    expect(reachSetAgentEnabledInput.safeParse({ agent_key: 'crm-focus', enabled: true }).success).toBe(false);
    expect(reachSetAgentCadenceInput.safeParse({ agent_key: 'crm-focus', cadence: 'daily' }).success).toBe(false);
    expect(reachSetAgentCapInput.safeParse({ agent_key: 'crm-focus', max_cost_cents: 5 }).success).toBe(false);
    expect(reachCreateScheduleInput.safeParse({ agent_key: 'crm-focus', interval_seconds: 3600 }).success).toBe(false);
    expect(
      reachSetWorkspaceCapsInput.safeParse({ agent_key: 'crm-focus', daily_cap_cents: 1, weekly_cap_cents: 1 }).success,
    ).toBe(false);
  });
  it('still accepts weekly-studio', () => {
    expect(reachSetAgentEnabledInput.safeParse({ agent_key: 'weekly-studio', enabled: true }).success).toBe(true);
    expect(reachCreateScheduleInput.safeParse({ agent_key: 'weekly-studio', interval_seconds: 3600 }).success).toBe(true);
    expect(reachSetWorkspaceCapsInput.safeParse({ daily_cap_cents: 1, weekly_cap_cents: 1 }).success).toBe(true);
  });
});
