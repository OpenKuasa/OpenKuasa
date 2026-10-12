import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { PublicFormNotice, PublicFormShell } from '@/components/reach/public-form-shell';
import { PublicLeadForm } from '@/components/reach/public-lead-form';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { SUBMISSION_MESSAGES } from '@/lib/reach/form-submissions';
import { countFormView } from '@/lib/reach/form-views';
import { createAnonymousClient, getPublicForm } from '@/lib/reach/public-forms';
import { createClient } from '@/lib/supabase/server';
import { submitPublicFormAction } from './actions';

/**
 * A lead form's public page: /f/<form id>. Anyone can open it, signed in or
 * not; it sits outside the signed-in app and shows none of it.
 */

type Props = { params: Promise<{ formId: string }> };

/** Search engines are asked not to list people's forms, whatever state they are in. */
const ROBOTS = { index: false, follow: false } as const;

/**
 * One lookup per request, shared by the page and its title. A link that is not
 * a form id, or a site with no database, has no form behind it.
 */
const loadForm = cache(async (rawId: string) => {
  const id = z.uuid().safeParse(rawId);
  if (!id.success || !hasSupabaseEnv()) return null;
  const form = await getPublicForm(createAnonymousClient(), id.data);
  return form ? { id: id.data, form } : null;
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await loadForm((await params).formId);
  // A closed or missing form gives nothing away, in the title either.
  const title = found?.form.accepting ? `${found.form.name} · ${found.form.orgName}` : 'Form';
  return {
    title,
    description: null,
    robots: ROBOTS,
    // Replaces the site-wide share text, which is about OpenKuasa, not this form.
    openGraph: { title },
    twitter: { card: 'summary', title },
  };
}

export default async function PublicFormPage({ params }: Props) {
  const found = await loadForm((await params).formId);
  if (!found) notFound();
  const { id, form } = found;

  if (!form.accepting) {
    return (
      <PublicFormShell>
        <PublicFormNotice title="Form closed">{SUBMISSION_MESSAGES.closed}</PublicFormNotice>
      </PublicFormShell>
    );
  }

  // The visitor's own session says who they are, so a member of this workspace
  // who is only previewing their form is left out. One view per client per window.
  await countFormView(await createClient(), id);

  return (
    <PublicFormShell>
      <header className="mb-6 space-y-1">
        <p className="text-sm text-muted-foreground">{form.orgName}</p>
        <h1 className="text-2xl font-bold tracking-tight break-words">{form.name}</h1>
      </header>
      <PublicLeadForm action={submitPublicFormAction.bind(null, id)} />
    </PublicFormShell>
  );
}
