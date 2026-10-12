import { describe, expect, it } from 'vitest';
import { reachAgent } from '@/lib/agents/reach-agent';
import { AGENTS } from '@/lib/agents/registry';
import { agentFor, agentForProduct } from '@/lib/agents/definition';
import { opportunityScan } from '@/lib/agents/proposer';
import { createSeedReachData } from '@/lib/reach/seed';

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
    const now = new Date('2026-10-12T00:00:00Z');
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
