import { cache } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { PublicFormNotice, PublicFormShell } from '@/components/reach/public-form-shell';
import { PublicLeadForm } from '@/components/reach/public-lead-form';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { DEFAULT_BUTTON_LABEL } from '@/lib/crm/landing-pages';
import { countLandingPageView, getPublicLandingPage } from '@/lib/crm/public-landing-pages';
import { createAnonymousClient } from '@/lib/reach/public-forms';
import { createClient } from '@/lib/supabase/server';
import { submitLandingPageAction } from './actions';

/**
 * A Kasturi landing page's public address: /p/<page id>. Anyone can open it,
 * signed in or not; it sits outside the signed-in app and shows none of it.
 */

type Props = { params: Promise<{ pageId: string }> };

/** Search engines are asked not to list people's pages, whatever state they are in. */
const ROBOTS = { index: false, follow: false } as const;

/**
 * One lookup per request, shared by the page and its title. A link that is not
 * a page id, or a site with no database, has no page behind it.
 */
const loadPage = cache(async (rawId: string) => {
  const id = z.uuid().safeParse(rawId);
  if (!id.success || !hasSupabaseEnv()) return null;
  const page = await getPublicLandingPage(createAnonymousClient(), id.data);
  return page ? { id: id.data, page } : null;
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await loadPage((await params).pageId);
  // A page that is not available gives nothing away, in the title either.
  const title = found?.page.available ? `${found.page.headline} · ${found.page.orgName}` : 'Page';
  return {
    title,
    description: (found?.page.available && found.page.subheadline) || null,
    robots: ROBOTS,
    // Replaces the site-wide share text, which is about OpenKuasa, not this page.
    openGraph: { title },
    twitter: { card: 'summary', title },
  };
}

export default async function PublicLandingPage({ params }: Props) {
  const found = await loadPage((await params).pageId);
  if (!found) notFound();
  const { id, page } = found;

  if (!page.available) {
    return (
      <PublicFormShell>
        <PublicFormNotice title="Page not available">
          This page is not open at the moment. Please check back later.
        </PublicFormNotice>
      </PublicFormShell>
    );
  }

  // The visitor's own session says who they are, so a member of this workspace
  // who is only previewing their page is left out. One view per client per window.
  await countLandingPageView(await createClient(), id);

  // Blank lines in the text separate paragraphs; single line breaks are kept.
  const paragraphs = (page.body ?? '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  return (
    <div className="flex min-h-dvh w-full flex-col bg-muted/40">
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-10 sm:py-14">
        <header className="space-y-3">
          <p className="text-sm font-medium text-muted-foreground">{page.orgName}</p>
          <h1 className="text-3xl font-bold tracking-tight break-words sm:text-4xl">{page.headline}</h1>
          {page.subheadline ? (
            <p className="text-lg text-muted-foreground break-words">{page.subheadline}</p>
          ) : null}
        </header>
        {paragraphs.length > 0 ? (
          <div className="space-y-3 text-base leading-relaxed break-words">
            {paragraphs.map((paragraph, index) => (
              <p key={index} className="whitespace-pre-line">
                {paragraph}
              </p>
            ))}
          </div>
        ) : null}
        <section className="rounded-xl border bg-card p-6 text-card-foreground shadow-sm sm:p-8">
          <PublicLeadForm
            action={submitLandingPageAction.bind(null, id)}
            submitLabel={page.buttonLabel || DEFAULT_BUTTON_LABEL}
          />
        </section>
      </main>
      <footer className="px-4 pb-6 text-center text-xs text-muted-foreground">
        <Link
          href="/"
          // A plain link: nothing is fetched ahead of a click.
          prefetch={false}
          className="rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Powered by OpenKuasa
        </Link>
      </footer>
    </div>
  );
}
