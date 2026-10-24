import Link from 'next/link';
import { DOC_SECTIONS } from '@/lib/docs/sections';
import type { Guide } from '@/lib/docs/content';
import { cn } from '@/lib/utils';

type NavGuide = Pick<Guide, 'section' | 'title' | 'url'>;

/** Sections in DOC_SECTIONS order, each with its guides; empty sections are left out. */
export function DocsSidebar({ guides, currentUrl }: { guides: NavGuide[]; currentUrl: string }) {
  const sections = DOC_SECTIONS.map((s) => ({
    ...s,
    guides: guides.filter((g) => g.section === s.key),
  })).filter((s) => s.guides.length > 0);

  return (
    <nav aria-label="Guides" className="space-y-7 text-sm">
      <Link href="/docs" className="block font-medium text-mk-muted transition-colors hover:text-mk-fg">
        All guides
      </Link>
      {sections.map((s) => (
        <div key={s.key}>
          <p className="text-xs font-semibold tracking-wider text-mk-subtle uppercase">{s.title}</p>
          <ul className="mt-2.5 space-y-0.5">
            {s.guides.map((g) => {
              const current = g.url === currentUrl;
              return (
                <li key={g.url}>
                  <Link
                    href={g.url}
                    aria-current={current ? 'page' : undefined}
                    className={cn(
                      'block rounded-lg px-3 py-1.5 transition-colors',
                      current
                        ? 'bg-mk-accent/10 font-medium text-mk-accent'
                        : 'text-mk-muted hover:bg-mk-surface-2 hover:text-mk-fg',
                    )}
                  >
                    {g.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
