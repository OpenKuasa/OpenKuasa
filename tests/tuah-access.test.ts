// tests/tuah-access.test.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({ viewerFails: false }));

vi.mock('@/lib/reach/supabase', () => ({ getReachData: vi.fn(async () => ({ reach: true })) }));
vi.mock('@/lib/hire/supabase', () => ({ getHireData: vi.fn(async () => ({ hire: true })) }));
vi.mock('@/lib/people/viewer', () => ({
  getPeopleViewer: vi.fn(async () => {
    if (ctl.viewerFails) throw new Error('viewer down');
    return { employeeId: 'e1', isHr: true, isDemo: false, managesTeam: false };
  }),
}));
vi.mock('@/lib/people/supabase', () => ({ createSupabasePeopleData: vi.fn(() => ({ people: true })) }));
vi.mock('@/lib/ai/crm-tools', () => ({
  loadRequireLostReason: vi.fn(async () => false),
  ensureCrmPipeline: vi.fn(async () => undefined),
}));
vi.mock('@/lib/auth/viewer', () => ({ hasSupabaseEnv: () => true }));

import { buildTuahAccess } from '@/lib/ai/tuah-access';
import { can } from '@/lib/auth/permissions';

const supabase = {} as SupabaseClient;
const base = { supabase, userId: 'u1', origin: null, withCvReader: false, receipt: null };

describe('buildTuahAccess', () => {
  beforeEach(() => {
    ctl.viewerFails = false;
  });

  it('viewer gets no write access anywhere', async () => {
    const a = await buildTuahAccess({ ...base, org: { orgId: 'o1', role: 'viewer' } });
    expect(a.reach.write).toBeUndefined();
    expect(a.crm?.canWrite).toBe(false);
    expect(a.finance?.canWrite).toBe(false);
    expect(a.hire.write).toBeUndefined();
  });

  it('member gets write access and a CV reader when asked', async () => {
    const a = await buildTuahAccess({ ...base, org: { orgId: 'o1', role: 'member' }, withCvReader: true });
    expect(a.reach.write?.canWrite).toBe(true);
    expect(a.hire.files).toBeDefined();
    expect(a.hire.cvShelf).toEqual([]);
  });

  it('no workspace means no crm, people or finance', async () => {
    const a = await buildTuahAccess({ ...base, org: null });
    expect(a.crm).toBeNull();
    expect(a.people).toBeNull();
    expect(a.finance).toBeNull();
  });

  it('people falls back to null when the HR viewer fails to load', async () => {
    ctl.viewerFails = true;
    const a = await buildTuahAccess({ ...base, org: { orgId: 'o1', role: 'member' } });
    expect(a.people).toBeNull();
  });

  it('no CV reader unless asked for', async () => {
    const a = await buildTuahAccess({ ...base, org: { orgId: 'o1', role: 'member' }, withCvReader: false });
    expect(a.hire.files).toBeUndefined();
    expect(a.hire.cvShelf).toBeUndefined();
  });

  it('only owners and admins may manage agents', async () => {
    const member = await buildTuahAccess({ ...base, org: { orgId: 'o1', role: 'member' } });
    const owner = await buildTuahAccess({ ...base, org: { orgId: 'o1', role: 'owner' } });
    expect(can('member', 'manage-agents')).toBe(false);
    expect(can('owner', 'manage-agents')).toBe(true);
    expect(member.reach.write?.canManageAgents).toBe(false);
    expect(owner.reach.write?.canManageAgents).toBe(true);
  });

  it('an HR viewer gets people write access for this user', async () => {
    const a = await buildTuahAccess({ ...base, org: { orgId: 'o1', role: 'member' } });
    expect(a.people?.write).toBeDefined();
    expect(a.people?.write?.userId).toBe('u1');
  });
});
