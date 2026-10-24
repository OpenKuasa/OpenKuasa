import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ChevronDown } from 'lucide-react';
import { AskSariBox } from '@/components/docs/ask-sari-box';
import { DocsSidebar } from '@/components/docs/docs-sidebar';
import { GuideBody } from '@/components/docs/guide-body';
import { OnThisPage } from '@/components/docs/on-this-page';
import { getAllGuides, getGuide } from '@/lib/docs/content';
import { DOC_SECTIONS } from '@/lib/docs/sections';

type Props = { params: Promise<{ section: string; slug: string }> };

// Only the guides on disk exist; anything else is a 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return getAllGuides().map((g) => ({ section: g.section, slug: g.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { section, slug } = await params;
  const guide = getGuide(section, slug);
  if (!guide) return {};
  const title = `${guide.title} · OpenKuasa Docs`;
  return {
    title,
    description: guide.description,
    alternates: { canonical: guide.url },
    openGraph: { title, description: guide.description, url: guide.url, type: 'article' },
  };
}

export default async function GuidePage({ params }: Props) {
  const { section, slug } = await params;
  const guide = getGuide(section, slug);
  if (!guide) notFound();

  const guides = getAllGuides();
  const sectionTitle = DOC_SECTIONS.find((s) => s.key === guide.section)?.title;

  return (
    <div className="mx-auto max-w-7xl px-6 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-12 xl:grid-cols-[15rem_minmax(0,1fr)_13rem]">
      <aside className="hidden lg:block">
        <div className="sticky top-16 max-h-[calc(100dvh-4rem)] overflow-y-auto py-10 pr-2">
          <DocsSidebar guides={guides} currentUrl={guide.url} />
        </div>
      </aside>

      <main className="min-w-0 py-8 lg:py-10">
        <details className="group mb-8 rounded-xl border border-mk-border bg-mk-surface lg:hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
            Browse guides
            <ChevronDown className="size-4 text-mk-subtle transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t border-mk-border px-2 py-4">
            <DocsSidebar guides={guides} currentUrl={guide.url} />
          </div>
        </details>

        <article className="max-w-[70ch]">
          <nav aria-label="Breadcrumb" className="text-sm text-mk-muted">
            <Link href="/docs" className="transition-colors hover:text-mk-fg">
              Docs
            </Link>
            <span className="mx-2 text-mk-subtle">/</span>
            <span>{sectionTitle}</span>
          </nav>
          <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">{guide.title}</h1>
          {guide.status === 'coming-soon' ? (
            <span className="mt-3 inline-flex rounded-full border border-mk-border bg-mk-surface-2 px-2.5 py-0.5 text-xs font-semibold text-mk-muted">
              Coming soon
            </span>
          ) : null}
          <p className="mt-4 text-lg text-mk-muted">{guide.description}</p>

          <div className="mt-10">
            <GuideBody guide={guide} />
          </div>

          <div className="mt-14">
            <AskSariBox question={guide.ask} />
          </div>
        </article>
      </main>

      <aside className="hidden xl:block">
        <div className="sticky top-16 max-h-[calc(100dvh-4rem)] overflow-y-auto py-10">
          <OnThisPage headings={guide.headings} />
        </div>
      </aside>
    </div>
  );
}
