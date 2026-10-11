import { cache } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { CAREERS_LINK_FOCUS, PublicCareersShell } from '@/components/hire/public-careers-shell';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import {
  ARRANGEMENT_LABEL,
  EMPLOYMENT_LABEL,
  careersPath,
  formatLongDate,
  formatSalary,
  getPublicJob,
  type PublicJob,
} from '@/lib/hire/public-careers';
import { createAnonymousClient } from '@/lib/supabase/anonymous';
import { applyAction } from './actions';
import { ApplyForm } from './apply-form';

/**
 * One open job on a workspace's public board: /careers/<workspace id>/<job id>.
 * Anyone can open it, signed in or not. While the job is taking applications
 * the apply form sits under the description; it is the one thing a visitor
 * can send.
 */

type Props = { params: Promise<{ orgId: string; jobId: string }> };

/**
 * One read per request, shared by the page and its title. It waits for a real
 * request first, so the page is never built ahead of time or served from a
 * copy made before the job closed or the board was switched off.
 */
const loadJob = cache(async (orgId: string, jobId: string) => {
  await connection();
  if (!hasSupabaseEnv()) return null;
  return getPublicJob(createAnonymousClient(), orgId, jobId);
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgId, jobId } = await params;
  const job = await loadJob(orgId, jobId);
  if (!job) {
    // Nothing behind the link gives nothing away, in the title either.
    const title = 'Page not available';
    return {
      title,
      description: null,
      robots: { index: false, follow: false },
      openGraph: { title },
      twitter: { card: 'summary', title },
    };
  }
  const title = `${job.title} at ${job.orgName}`;
  const description = job.description.replace(/\s+/g, ' ').trim().slice(0, 160);
  return {
    title,
    description,
    robots: { index: true, follow: true },
    // Replaces the site-wide share text, which is about OpenKuasa, not this job.
    openGraph: { title, description },
    twitter: { card: 'summary', title, description },
  };
}

type Fact = { label: string; value: string };

/** The key facts, each only when the job has it. A hidden salary arrives as nothing and stays out. */
function keyFacts(job: PublicJob): Fact[] {
  const closes = job.closesOn ? formatLongDate(job.closesOn) : null;
  const facts: { label: string; value: string | null }[] = [
    { label: 'Department', value: job.department },
    { label: 'Location', value: job.location },
    { label: 'Work arrangement', value: job.workArrangement ? ARRANGEMENT_LABEL[job.workArrangement] : null },
    { label: 'Employment type', value: EMPLOYMENT_LABEL[job.employmentType] },
    { label: 'Salary', value: formatSalary(job.salaryMinCents, job.salaryMaxCents) },
    { label: 'Closing date', value: closes && !job.accepting ? `${closes} · Applications closed` : closes },
  ];
  return facts.filter((fact): fact is Fact => Boolean(fact.value));
}

export default async function CareersJobPage({ params }: Props) {
  const { orgId, jobId } = await params;
  const job = await loadJob(orgId, jobId);
  if (!job) notFound();

  return (
    <PublicCareersShell>
      <header className="mb-8 space-y-2">
        <p className="text-sm break-words text-muted-foreground">{job.orgName}</p>
        <h1 className="text-3xl leading-tight font-bold tracking-tight break-words">{job.title}</h1>
      </header>
      <main id="main" tabIndex={-1} className="space-y-8 outline-none">
        <dl className="divide-y rounded-xl border bg-card text-card-foreground shadow-sm">
          {keyFacts(job).map((fact) => (
            <div key={fact.label} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
              <dt className="text-sm text-muted-foreground sm:w-40 sm:shrink-0 sm:pt-0.5">{fact.label}</dt>
              <dd className="min-w-0 break-words tabular-nums">{fact.value}</dd>
            </div>
          ))}
        </dl>
        <section aria-labelledby="about-the-role">
          <h2 id="about-the-role" className="mb-3 text-lg font-semibold tracking-tight">About the role</h2>
          <p className="max-w-prose text-base leading-relaxed break-words whitespace-pre-line">{job.description}</p>
        </section>
        <section aria-labelledby="apply">
          <h2 id="apply" className="mb-3 text-lg font-semibold tracking-tight">Apply for this role</h2>
          {job.accepting ? (
            <ApplyForm action={applyAction.bind(null, orgId, jobId)} form={job.form} orgName={job.orgName} />
          ) : (
            <p className="text-base text-muted-foreground">Applications closed</p>
          )}
        </section>
        <p>
          <Link
            href={careersPath(orgId)}
            prefetch={false}
            className={`inline-flex min-h-11 items-center gap-2 rounded-sm font-medium underline underline-offset-4 ${CAREERS_LINK_FOCUS}`}
          >
            <span aria-hidden="true">←</span>
            All open roles
          </Link>
        </p>
      </main>
    </PublicCareersShell>
  );
}
