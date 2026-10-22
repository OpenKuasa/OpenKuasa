import { describe, expect, it } from 'vitest';
import { reachAgent, opportunityScan } from '@/lib/agents/reach-agent';
import { AGENTS } from '@/lib/agents/registry';
import { agentFor, agentForProduct } from '@/lib/agents/definition';
import { createSeedReachData } from '@/lib/reach/seed';

const now = new Date('2026-10-11T00:00:00Z');
const LEAD_ID = '11111111-1111-4111-8111-111111111111';
const lead = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: LEAD_ID,
    name: 'Aina Rahman',
    channel: 'whatsapp',
    stage: 'won',
    source: 'Free Catering Quote',
    promoted_contact_id: null,
    created_at: '2026-10-01T00:00:00Z',
    ...over,
  }) as never;

const appt = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: '99999999-9999-4999-8999-999999999999',
    contact_name: 'Aina Rahman',
    kind: 'Follow-up call',
    scheduled_at: '2026-10-01T09:00:00Z', // past, so it is never "upcoming"
    via: 'Phone',
    status: 'completed',
    created_at: '2026-09-30T00:00:00Z',
    ...over,
  }) as never;

describe('opportunityScan', () => {
  it('proposes promote for a won, unpromoted lead', () => {
    const cands = opportunityScan([lead()], [], now);
    expect(cands.some((c) => c.action === 'promoteLeadToContact')).toBe(true);
  });
  it('does not propose promote for an already-promoted lead', () => {
    const cands = opportunityScan([lead({ promoted_contact_id: 'c1' })], [], now);
    expect(cands.some((c) => c.action === 'promoteLeadToContact')).toBe(false);
  });

  it('proposes advancing a lead that completed a meeting but is still below booked', () => {
    const cands = opportunityScan([lead({ stage: 'qualified' })], [appt()], now);
    const advance = cands.find((c) => c.action === 'setLeadStage');
    expect(advance?.input).toEqual({ id: LEAD_ID, stage: 'booked' });
  });

  it('does not advance a lead that is already booked or won', () => {
    for (const stage of ['booked', 'won'] as const) {
      const cands = opportunityScan([lead({ stage })], [appt()], now);
      expect(cands.some((c) => c.action === 'setLeadStage')).toBe(false);
    }
  });

  it('does not advance a lead whose appointment is not completed', () => {
    const cands = opportunityScan([lead({ stage: 'qualified' })], [appt({ status: 'scheduled' })], now);
    expect(cands.some((c) => c.action === 'setLeadStage')).toBe(false);
  });
});

describe('reachAgent definition', () => {
  it('is the weekly-studio/reach agent with the 7 allow-listed actions', () => {
    expect(reachAgent.agentKey).toBe('weekly-studio');
    expect(reachAgent.product).toBe('reach');
    expect(Object.keys(reachAgent.actions).sort()).toEqual([
      'createAppointment',
      'createForm',
      'promoteLeadToContact',
      'setAppointmentStatus',
      'setLeadStage',
      'updateAppointment',
      'updateForm',
    ]);
    expect(reachAgent.ui.screenPath).toBe('/reach/agents');
    expect(reachAgent.ui.assetKinds).toEqual(['poster', 'image', 'video']);
  });

  it('scan delegates to opportunityScan with the raw leads/appts (pure, no DB)', async () => {
    const data = createSeedReachData(now);
    const [leads, appts] = await Promise.all([data.listLeads(), data.listAppointments()]);
    expect(reachAgent.scan({ leads, appts, campaigns: [] }, now)).toEqual(
      opportunityScan(leads, appts, now),
    );
  });

  it('is registered in the static AGENTS map', () => {
    expect(agentFor('weekly-studio', AGENTS)).toBe(reachAgent);
    expect(agentForProduct('reach', AGENTS)).toBe(reachAgent);
  });

  it('buildWriteContext returns a ReachWriteContext', () => {
    const fakeClient = {} as never;
    expect(reachAgent.buildWriteContext(fakeClient, 'org-1', 'user-1')).toEqual({
      client: fakeClient,
      orgId: 'org-1',
    });
  });
});

describe('reach pick prompt is unchanged', () => {
  const list = '0. Promote Aina Rahman to a contact\n1. Create a draft lead-capture form';
  const head = [
    'You help a small business owner decide which suggested CRM changes are worth queueing for their approval.',
    'Choose ONLY from the numbered candidates below. Do not invent new items or change them.',
    'Reply with JSON only: an array of {"index": number, "rationale": string} objects, where rationale is one short sentence.',
    'If a candidate is about creating a lead-capture form, also include a short "name" (max 60 characters) for the draft form, inspired by this week\'s market angles.',
    'Reply [] if none are worthwhile.',
    '',
    'Business snapshot:\nSNAP',
  ];

  it('matches the text suggestProposals built before, without a trend', () => {
    const expected = [...head, '', `Candidates:\n${list}`].join('\n');
    expect(reachAgent.proposals.pickPrompt('SNAP', list)).toBe(expected);
  });

  it('matches the text suggestProposals built before, with a trend', () => {
    const expected = [...head, '', "This week's market angles:\nRaya gifting", '', `Candidates:\n${list}`].join('\n');
    expect(reachAgent.proposals.pickPrompt('SNAP', list, 'Raya gifting')).toBe(expected);
  });

  it('sets no cooldown, expiry or custom dedupe key', () => {
    expect(reachAgent.proposals.cooldownDays).toBeUndefined();
    expect(reachAgent.proposals.expiresInDays).toBeUndefined();
    expect(reachAgent.proposals.dedupeKey).toBeUndefined();
  });
});
