import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const text = (file: string) => readFileSync(resolve(file), 'utf8');

/**
 * Tuah builds its HR tools from a change tier. Until now the route worked the tier out from the role, so an owner or
 * admin was `hr` and everyone else `self`: a manager holding a decide tool on their own screen got none in Tuah. The
 * tool set already knows what a manager may do (`createPeopleTools` returns the team and decide tools for
 * `manager`), so the fault was here, in which tier the route passed.
 */
describe('the tier Tuah gives the HR tools', () => {
  const route = text('src/app/api/chat/route.ts');

  it('is worked out from the viewer, as the screens and Lekiu do', () => {
    expect(route).toContain("import { peopleTier } from '@/lib/people/tier'");
    expect(route).toContain('const tier = peopleTier(viewer)');
  });

  it('is passed through rather than written down from the role', () => {
    expect(route).not.toContain("tier: 'hr'");
    expect(route).not.toContain("tier: 'self'");
    expect(route).toContain('tier, employeeId: viewer.employeeId');
  });

  it('is still offered to nobody in the demo workspace', () => {
    expect(route).toContain('if (!viewer.isDemo) {');
  });

  it('is the same call the people chat route makes', () => {
    expect(text('src/app/api/people/chat/route.ts')).toContain('const tier = peopleTier(viewer)');
  });
});
