import { describe, expect, it } from 'vitest';
import { ACCOUNT_SECTIONS, visibleAccountSections } from '@/config/account-nav';
import { buildSearchEntries } from '@/components/app/nav-search-entries';

type Role = 'owner' | 'admin' | 'member' | 'viewer';

const sidebarHrefs = (role: Role, isDemo = false) =>
  visibleAccountSections({ role, isDemo }).flatMap((section) => section.items.map((item) => item.href));
const searchHrefs = (role: Role, isDemo = false) =>
  buildSearchEntries({ role, isDemo })
    .map((entry) => entry.href)
    .filter((href) => href.startsWith('/account/'));

const BILLING = ['/account/subscriptions', '/account/plan', '/account/add-ons', '/account/payment-methods', '/account/transactions'];

describe('account screens in jump-to search', () => {
  it('offers exactly the screens the account sidebar shows, for every role', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(searchHrefs(role), role).toEqual(sidebarHrefs(role));
    }
    expect(searchHrefs('viewer', true)).toEqual(sidebarHrefs('viewer', true));
  });

  it('offers an owner every account screen', () => {
    const all = ACCOUNT_SECTIONS.flatMap((section) => section.items.map((item) => item.href));
    expect(all).toHaveLength(15);
    expect(searchHrefs('owner')).toEqual(all);
  });

  it('offers a member no billing screen and not Developers', () => {
    const hrefs = searchHrefs('member');
    for (const href of [...BILLING, '/account/developers']) expect(hrefs, href).not.toContain(href);
    expect(hrefs).toContain('/account/activity');
    expect(hrefs).toContain('/account/connected-apps');
  });

  it('finds each screen by the name the sidebar gives it', () => {
    const entries = buildSearchEntries({ role: 'owner', isDemo: false });
    for (const item of ACCOUNT_SECTIONS.flatMap((section) => section.items)) {
      expect(entries.find((entry) => entry.href === item.href)?.label).toBe(item.label);
    }
  });
});
