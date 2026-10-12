import { visibleAccountSections } from '@/config/account-nav';
import { PRODUCTS, visibleSections } from '@/config/nav';
import type { Viewer } from '@/lib/auth/viewer';

export type SearchEntry = { href: string; label: string; context: string };

/** Every screen this viewer may open: the same sections the product and account sidebars show them. */
export function buildSearchEntries(viewer: Pick<Viewer, 'role' | 'isDemo'>): SearchEntry[] {
  return [
    ...PRODUCTS.flatMap((p) => [
      { href: `/${p.key}`, label: p.name, context: p.tagline },
      ...visibleSections(p, viewer).flatMap((s) =>
        s.items.map((i) => ({
          href: `/${p.key}/${i.slug}`,
          label: i.label,
          context: `${p.name} · ${s.label}`,
        })),
      ),
    ]),
    ...visibleAccountSections(viewer).flatMap((s) =>
      s.items.map((i) => ({
        href: i.href,
        label: i.label,
        context: s.label === 'Account' ? 'Account' : `Account · ${s.label}`,
      })),
    ),
  ];
}
