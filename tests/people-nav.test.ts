import { describe, expect, it } from 'vitest';
import { PRODUCTS, getProduct, visibleSections } from '@/config/nav';
import { buildSearchEntries } from '@/components/app/nav-search-entries';

const people = getProduct('people')!;
const HR_ONLY = ['approve-leave', 'approve-claims', 'approve-overtime', 'approve-time-off', 'payroll', 'payment-vouchers', 'settings', 'attendance'];
const TEAM = ['approve-leave', 'approve-claims', 'approve-overtime', 'approve-time-off', 'attendance'];
const HR_STILL = ['payroll', 'payment-vouchers', 'settings'];
const slugs = (role: 'owner' | 'admin' | 'member' | 'viewer', isDemo = false, managesTeam = false) =>
  visibleSections(people, { role, isDemo, managesTeam }).flatMap((section) => section.items.map((item) => item.slug));

describe('Lekiu navigation by role', () => {
  it('marks five pages for HR or a manager and three for HR alone', () => {
    const marked = people.sections.flatMap((s) => s.items).filter((i) => i.needs !== undefined);
    expect(marked.filter((i) => i.needs === 'approve-team').map((i) => i.slug).sort()).toEqual([...TEAM].sort());
    expect(marked.filter((i) => i.needs === 'approve').map((i) => i.slug).sort()).toEqual([...HR_STILL].sort());
    expect(marked).toHaveLength(8);
  });

  it.each(['member', 'viewer'] as const)('shows a %s who manages a team the five team pages and none of the HR-only three', (role) => {
    const seen = slugs(role, false, true);
    for (const slug of TEAM) expect(seen).toContain(slug);
    for (const slug of HR_STILL) expect(seen).not.toContain(slug);
    expect(seen).toHaveLength(27);
  });

  it('puts a waiting badge on each of the four approval pages and none on team attendance', () => {
    const badge = (slug: string) => people.sections.flatMap((s) => s.items).find((i) => i.slug === slug)?.badge;
    expect(badge('approve-leave')).toBe('waitingLeave');
    expect(badge('approve-time-off')).toBe('waitingTimeOff');
    expect(badge('approve-claims')).toBe('waitingClaims');
    expect(badge('approve-overtime')).toBe('waitingOvertime');
    expect(badge('attendance')).toBeUndefined();
  });

  it.each(['owner', 'admin'] as const)('shows an %s every page', (role) => {
    expect(slugs(role)).toHaveLength(30);
  });

  it.each(['member', 'viewer'] as const)('hides the HR pages from a %s, and the sections left empty', (role) => {
    const seen = slugs(role);
    for (const slug of HR_ONLY) expect(seen).not.toContain(slug);
    expect(seen).toContain('employees');
    expect(seen).toContain('public-holidays');
    expect(seen).toHaveLength(22);
    const labels = visibleSections(people, { role, isDemo: false }).map((s) => s.label);
    expect(labels).not.toContain('Payroll');
    expect(labels).not.toContain('Configuration');
    expect(labels).toContain('Approvals');
  });

  it('puts Attendance under Management for owners and admins, and hides it from members', () => {
    const management = visibleSections(people, { role: 'admin', isDemo: false }).find((s) => s.label === 'Management');
    expect(management?.items.find((i) => i.slug === 'attendance')?.label).toBe('Attendance');
    const memberManagement = visibleSections(people, { role: 'member', isDemo: false }).find((s) => s.label === 'Management');
    expect(memberManagement?.items.map((i) => i.slug)).toEqual(['employees']);
  });

  it('shows a demo visitor every page, whatever their role', () => {
    expect(slugs('viewer', true)).toHaveLength(30);
  });

  it('changes nothing for the other products', () => {
    for (const product of PRODUCTS.filter((p) => p.key !== 'people')) {
      const all = product.sections.flatMap((s) => s.items);
      expect(all.some((i) => i.needs !== undefined), product.key).toBe(false);
      expect(visibleSections(product, { role: 'viewer', isDemo: false })).toEqual(product.sections);
    }
  });
});

describe('jump-to search by role', () => {
  const hrHrefs = (role: 'owner' | 'member') =>
    buildSearchEntries({ role, isDemo: false })
      .map((e) => e.href)
      .filter((href) => HR_ONLY.some((slug) => href === `/people/${slug}`));

  it('offers a member none of the HR-only pages', () => {
    expect(hrHrefs('member')).toEqual([]);
  });

  it('offers an owner all eight', () => {
    expect(hrHrefs('owner')).toHaveLength(8);
  });

  it('offers a member who manages a team exactly the five team pages of the eight', () => {
    const hrefs = buildSearchEntries({ role: 'member', isDemo: false, managesTeam: true })
      .map((e) => e.href)
      .filter((href) => HR_ONLY.some((slug) => href === `/people/${slug}`));
    expect(hrefs.sort()).toEqual(TEAM.map((slug) => `/people/${slug}`).sort());
  });
});
