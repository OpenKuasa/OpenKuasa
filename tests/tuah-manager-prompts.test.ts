// Tuah hands a manager (someone with people reporting to them) the four decide tools and the two team reads, so every
// prompt that tells Tuah or its HR specialist who may decide, or whose records a lookup covers, must know managers too.
import { describe, expect, it } from 'vitest';
import { TUAH_SYSTEM, subAgentSystem } from '@/lib/ai/agents/prompts';
import { TEAM_AREA } from '@/lib/ai/agents/orchestrator';
import { AREA } from '@/lib/ai/agents/specialists';

describe('TUAH_SYSTEM and managers', () => {
  const t = TUAH_SYSTEM.toLowerCase();

  it('no longer says only an owner or admin decides, or that everyone else sees only their own', () => {
    expect(t).not.toContain('others see only their own');
    expect(t).not.toContain('an owner or admin can also decide those');
  });

  it('says a manager decides their direct reports\' requests, and only those', () => {
    expect(t).toContain('a manager');
    expect(t).toContain('direct reports');
    expect(t).toContain('listmyteam');
    expect(t).toContain('getwaitingforme');
  });

  it('never gives a manager what a report\'s overtime pays', () => {
    expect(t).toMatch(/manager[^.]*never[^.]*overtime pays|never tell a manager what a report's overtime pays/);
  });
});

describe('the team-mode HR specialist and managers', () => {
  const s = subAgentSystem('people', true).toLowerCase();

  it('lets a manager decide their direct reports\' requests', () => {
    expect(s).not.toMatch(/deciding leave, time-off, claims or overtime \([^)]*\)[^.]*are for an owner or admin\./);
    expect(s).toContain('direct reports');
    expect(s).toContain("the employee's manager or an owner or admin decides it");
  });

  it('knows the manager scope string the lookups return', () => {
    expect(s).toContain('your own records and those of the people who report to you');
  });
});

describe('the HR area descriptions Tuah routes by', () => {
  for (const [name, text] of [
    ['TEAM_AREA.people', TEAM_AREA.people],
    ['AREA.people', AREA.people],
  ] as const) {
    it(`${name} names managers and their direct reports`, () => {
      const a = text.toLowerCase();
      expect(a).not.toContain('others see their own');
      expect(a).toContain('a manager');
      expect(a).toContain('direct reports');
    });
  }
});
