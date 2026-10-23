import { describe, expect, it } from 'vitest';
import { type ReachTools, createReachTools } from '@/lib/ai/tools';
import { REACH_WRITE_TOOL_NAMES } from '@/lib/ai/products';
import { createSeedReachData } from '@/lib/reach/seed';
import { reachCreateScheduleInput } from '@/lib/reach/schedule-capabilities';

const ctx = { client: {} as never, orgId: 'org1' };
const tools = createReachTools(createSeedReachData(), () => new Date(), {
  ctx,
  canWrite: true,
  canManageAgents: true,
}) as Extract<ReachTools, { scheduleWeeklyStudio: unknown }>;

describe('scheduleWeeklyStudio chat tool', () => {
  it('is approval-gated in both products', () => {
    expect(REACH_WRITE_TOOL_NAMES).toContain('scheduleWeeklyStudio');
  });

  it('is not offered to a member who may edit data but not manage agents', () => {
    const memberTools = createReachTools(createSeedReachData(), () => new Date(), { ctx, canWrite: true });
    expect(Object.keys(memberTools)).toContain('createCampaign');
    expect(Object.keys(memberTools)).not.toContain('scheduleWeeklyStudio');
  });

  it('inputSchema IS the capability schema (AI/UI parity)', () => {
    expect(tools.scheduleWeeklyStudio.inputSchema).toBe(reachCreateScheduleInput);
  });
});
