import { describe, expect, it, test } from 'vitest';
import { PERMISSIONS, can, canSee } from '@/lib/auth/permissions';

test('billing and company edits are owner/admin only', () => {
  expect(can('owner', 'manage-billing')).toBe(true);
  expect(can('admin', 'manage-company')).toBe(true);
  expect(can('member', 'manage-billing')).toBe(false);
  expect(can('viewer', 'manage-company')).toBe(false);
});

test('developer settings and workspace deletion are owner only', () => {
  expect(can('owner', 'manage-developers')).toBe(true);
  expect(can('admin', 'manage-developers')).toBe(false);
  expect(can('admin', 'delete-workspace')).toBe(false);
});

test('members do not see screens outside their role', () => {
  const member = { role: 'member' as const, isDemo: false };
  expect(canSee(member, 'manage-billing')).toBe(false);
  expect(canSee(member, undefined)).toBe(true);
});

test('demo guests can look at every screen', () => {
  const guest = { role: 'viewer' as const, isDemo: true };
  expect(canSee(guest, 'manage-billing')).toBe(true);
  expect(canSee(guest, 'manage-developers')).toBe(true);
});

test('agent settings and schedules are owner/admin only; members keep data edits', () => {
  expect(can('owner', 'manage-agents')).toBe(true);
  expect(can('admin', 'manage-agents')).toBe(true);
  expect(can('member', 'manage-agents')).toBe(false);
  expect(can('viewer', 'manage-agents')).toBe(false);
  expect(can('member', 'edit-data')).toBe(true);
});

test('posting, paying and voiding finance documents is owner/admin only; drafts stay with every writer', () => {
  expect(can('owner', 'sign-off-finance')).toBe(true);
  expect(can('admin', 'sign-off-finance')).toBe(true);
  expect(can('member', 'sign-off-finance')).toBe(false);
  expect(can('viewer', 'sign-off-finance')).toBe(false);
  expect(can('member', 'edit-data')).toBe(true);
});

describe("canSee and the nav need 'approve-team'", () => {
  it.each([
    [{ role: 'owner', isDemo: false }, true],
    [{ role: 'admin', isDemo: false }, true],
    [{ role: 'member', isDemo: false }, false],
    [{ role: 'viewer', isDemo: false }, false],
    [{ role: 'member', isDemo: false, managesTeam: true }, true],
    [{ role: 'viewer', isDemo: false, managesTeam: true }, true],
    [{ role: 'member', isDemo: false, managesTeam: false }, false],
    [{ role: 'viewer', isDemo: true }, true],
  ] as const)('%o: %s', (viewer, seen) => {
    expect(canSee(viewer, 'approve-team')).toBe(seen);
  });

  it('a manager gains nothing else', () => {
    const manager = { role: 'member', isDemo: false, managesTeam: true } as const;
    for (const { capability } of PERMISSIONS) {
      expect(canSee(manager, capability), capability).toBe(can('member', capability));
    }
  });

  it("is not a capability: the Team page's table does not list it", () => {
    expect(PERMISSIONS.map((p) => p.capability)).not.toContain('approve-team');
  });
});
