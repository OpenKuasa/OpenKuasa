import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowRight } from 'lucide-react';
import { DocsSearch } from '@/components/docs/docs-search';
import { getAllGuides } from '@/lib/docs/content';
import { buildDocsIndex } from '@/lib/docs/search';
import { DOC_SECTIONS } from '@/lib/docs/sections';

const title = 'OpenKuasa Docs';
const description = 'Guides for every OpenKuasa product, and developer docs.';

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: '/docs' },
  openGraph: { title, description, url: '/docs' },
};

export default function DocsHome() {
  const guides = getAllGuides();
  const sections = DOC_SECTIONS.map((s) => ({
    ...s,
    guides: guides.filter((g) => g.section === s.key),
  })).filter((s) => s.guides.length > 0);

  return (
    <main>
      <section className="relative overflow-hidden border-b border-mk-border">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_50%_0%,color-mix(in_oklch,var(--mk-accent)_12%,transparent),transparent)]" />
        <div className="relative mx-auto max-w-3xl px-6 py-16 sm:py-24">
          <p className="text-sm font-semibold tracking-wider text-mk-accent uppercase">Docs</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">How can we help?</h1>
          <p className="mt-4 max-w-[60ch] text-lg text-mk-muted">
            Plain-English guides for running your business on OpenKuasa. Search for what you need, or pick a
            topic below.
          </p>
          <div className="mt-8">
            <DocsSearch index={buildDocsIndex()} />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-14 sm:py-20">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {sections.map((s) => (
            <div key={s.key} id={s.key} className="flex flex-col rounded-2xl border border-mk-border bg-mk-surface p-6">
              <h2 className="text-lg font-semibold tracking-tight">{s.title}</h2>
              <p className="mt-1.5 text-sm text-mk-muted">{s.blurb}</p>
              <ul className="mt-5 space-y-1 border-t border-mk-border pt-4">
                {s.guides.map((g) => (
                  <li key={g.url}>
                    <Link
                      href={g.url}
                      className="group -mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm font-medium text-mk-fg/85 transition-colors hover:bg-mk-surface-2 hover:text-mk-accent"
                    >
                      {g.title}
                      <ArrowRight className="size-4 shrink-0 text-mk-subtle transition-colors group-hover:text-mk-accent" />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
