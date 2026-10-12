import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PublicCareers, PublicJob, PublicJobSummary } from '@/lib/hire/public-careers';

/**
 * The two public pages, called as the functions they are and rendered to a
 * string. The database readers are replaced; the wording helpers are real.
 */

const NOT_FOUND = 'NOT_FOUND_MARKER';

const mocks = vi.hoisted(() => ({
  getPublicCareers: vi.fn(),
  getPublicJob: vi.fn(),
  readPublicJob: vi.fn(),
  notFound: vi.fn(),
  hasSupabaseEnv: vi.fn(),
  connection: vi.fn(),
  applyForm: vi.fn(),
  submitPublicApplication: vi.fn(),
  consumeRateLimits: vi.fn(),
}));

vi.mock('@/lib/hire/public-careers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hire/public-careers')>()),
  getPublicCareers: mocks.getPublicCareers,
  getPublicJob: mocks.getPublicJob,
  // The page reads a job with the one above; the action it hands the form reads it with this one.
  readPublicJob: mocks.readPublicJob,
}));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));
// The real one throws outside a request ("`connection` was called outside a request scope").
vi.mock('next/server', () => ({ connection: mocks.connection }));
// The real check reads this shell's environment; the pages must not depend on it here.
vi.mock('@/lib/auth/viewer', () => ({ hasSupabaseEnv: mocks.hasSupabaseEnv }));
vi.mock('@/lib/supabase/anonymous', () => ({ createAnonymousClient: () => ({ anonymous: true }) }));
// The action the page hands the form counts each application in the database.
// Only the call that asks the counter is replaced; left alone it would count
// every run against the live limit on applications.
vi.mock('@/lib/security/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/rate-limit')>()),
  consumeRateLimits: mocks.consumeRateLimits,
}));
// The apply form has its own test file. Here a stand-in shows where the page
// puts it and what the page hands it.
vi.mock('@/app/careers/[orgId]/[jobId]/apply-form', () => ({
  ApplyForm: (props: Record<string, unknown>) => {
    mocks.applyForm(props);
    return <div data-apply-form="" />;
  },
}));
vi.mock('@/lib/hire/public-applications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hire/public-applications')>()),
  submitPublicApplication: mocks.submitPublicApplication,
}));

import BoardPage, { generateMetadata as boardMetadata } from '@/app/careers/[orgId]/page';
import JobPage, { generateMetadata as jobMetadata } from '@/app/careers/[orgId]/[jobId]/page';
import CareersNotFound, { metadata as notFoundMetadata } from '@/app/careers/[orgId]/not-found';
import CareersError from '@/app/careers/error';

const ORG = '11111111-1111-4111-8111-111111111111';
const JOB_A = '22222222-2222-4222-8222-222222222222';
const JOB_B = '33333333-3333-4333-8333-333333333333';

const summary = (over: Partial<PublicJobSummary> = {}): PublicJobSummary => ({
  id: JOB_A, title: 'Senior Accountant', department: 'Finance', location: 'Kuala Lumpur',
  workArrangement: 'hybrid', employmentType: 'full_time', closesOn: '2026-10-31', accepting: true,
  ...over,
});
const careers = (over: Partial<PublicCareers> = {}): PublicCareers => ({
  orgName: 'Tanjung Trading', headline: null, tagline: null,
  jobs: [summary(), summary({ id: JOB_B, title: 'Warehouse Lead', department: null, workArrangement: null, accepting: false })],
  ...over,
});
const job = (over: Partial<PublicJob> = {}): PublicJob => ({
  ...summary(), orgName: 'Tanjung Trading', headline: null, tagline: null,
  description: 'Keep the books.\n\nClose each month on time.',
  salaryMinCents: 400000, salaryMaxCents: 600000,
  form: { require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false },
  ...over,
});

const boardParams = { params: Promise.resolve({ orgId: ORG }) };
const jobParams = { params: Promise.resolve({ orgId: ORG, jobId: JOB_A }) };
const renderBoard = async () => renderToStaticMarkup(await BoardPage(boardParams));
const renderJob = async () => renderToStaticMarkup(await JobPage(jobParams));
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;
/** Tags out, so text that sits in neighbouring elements can be read as a visitor reads it. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasSupabaseEnv.mockReturnValue(true);
  mocks.connection.mockResolvedValue(undefined);
  mocks.notFound.mockImplementation(() => { throw new Error(NOT_FOUND); });
  mocks.getPublicCareers.mockResolvedValue(careers());
  mocks.getPublicJob.mockResolvedValue(job());
  mocks.readPublicJob.mockResolvedValue({ state: 'found', job: job() });
  mocks.consumeRateLimits.mockResolvedValue({ allowed: true, enforced: true });
});

describe('the board page', () => {
  it('reads the board of the workspace in the address, with a client that carries no session', async () => {
    await renderBoard();
    expect(mocks.getPublicCareers).toHaveBeenCalledWith({ anonymous: true }, ORG);
  });

  it('waits for a request before it reads, so it is never built ahead of time', async () => {
    await renderBoard();
    expect(mocks.connection.mock.invocationCallOrder[0]).toBeLessThan(mocks.getPublicCareers.mock.invocationCallOrder[0]);
  });

  it('shows the workspace name, and "Join our team" when no headline is set', async () => {
    const html = await renderBoard();
    expect(html).toContain('Tanjung Trading');
    expect(count(html, /<h1[\s>]/g)).toBe(1);
    expect(html).toMatch(/<h1[^>]*>Join our team<\/h1>/);
    expect(html).toMatch(/<h2[^>]*>Open roles<\/h2>/);
  });

  it('shows the headline and the tagline when they are set', async () => {
    mocks.getPublicCareers.mockResolvedValue(careers({ headline: 'Build with us', tagline: 'Small team, real work.' }));
    const html = await renderBoard();
    expect(html).toMatch(/<h1[^>]*>Build with us<\/h1>/);
    expect(html).not.toContain('Join our team');
    expect(html).toMatch(/<p[^>]*>Small team, real work\.<\/p>/);
  });

  it('has a skip link to the main part of the page', async () => {
    const html = await renderBoard();
    expect(html).toMatch(/<a[^>]*href="#main"[^>]*>Skip to main content<\/a>/);
    expect(count(html, /<main[^>]*id="main"/g)).toBe(1);
    expect(html.indexOf('href="#main"')).toBeLessThan(html.indexOf('<header'));
  });

  it('lists each job as one link to its own page, with the title as the link text', async () => {
    const html = await renderBoard();
    expect(html).toMatch(new RegExp(`<a[^>]*href="/careers/${ORG}/${JOB_A}"[^>]*>Senior Accountant</a>`));
    expect(html).toMatch(new RegExp(`<a[^>]*href="/careers/${ORG}/${JOB_B}"[^>]*>Warehouse Lead</a>`));
    expect(count(html, /<li[\s>]/g)).toBe(2);
    expect(count(html, new RegExp(`href="/careers/${ORG}/`, 'g'))).toBe(2);
  });

  it('puts the facts that are present under the title, and leaves out the ones that are not', async () => {
    const html = await renderBoard();
    expect(html).toContain('Finance · Kuala Lumpur · Hybrid · Full-time');
    // The second job has no department and no arrangement.
    expect(html).toContain('>Kuala Lumpur · Full-time<');
  });

  it('says "Applications closed" for a job past its closing date, and only for that one', async () => {
    const html = await renderBoard();
    expect(count(html, /Applications closed/g)).toBe(1);
    expect(html.indexOf('Applications closed')).toBeGreaterThan(html.indexOf('Warehouse Lead'));
  });

  it('shows the workspace and an empty-state sentence when there are no open jobs', async () => {
    mocks.getPublicCareers.mockResolvedValue(careers({ jobs: [] }));
    const html = await renderBoard();
    expect(html).toContain('Tanjung Trading');
    expect(html).toContain('No open roles right now. Check back soon.');
    expect(html).not.toContain('<ul');
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it('links out only to the credit at the foot', async () => {
    const html = await renderBoard();
    expect(html).toMatch(/<footer[^>]*>\s*<a[^>]*href="\/"[^>]*>Powered by OpenKuasa<\/a>/);
    expect(html).not.toMatch(/<(script|form|button|input)[\s>]/);
  });

  it('is "not found" when the reader returns nothing', async () => {
    mocks.getPublicCareers.mockResolvedValue(null);
    await expect(BoardPage(boardParams)).rejects.toThrow(NOT_FOUND);
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
  });

  it('is "not found", without a read, on a site with no database', async () => {
    mocks.hasSupabaseEnv.mockReturnValue(false);
    await expect(BoardPage(boardParams)).rejects.toThrow(NOT_FOUND);
    expect(mocks.getPublicCareers).not.toHaveBeenCalled();
  });
});

describe('the job page', () => {
  it('reads the job under the workspace in the address', async () => {
    await renderJob();
    expect(mocks.getPublicJob).toHaveBeenCalledWith({ anonymous: true }, ORG, JOB_A);
  });

  it('waits for a request before it reads, so it is never built ahead of time', async () => {
    await renderJob();
    expect(mocks.connection.mock.invocationCallOrder[0]).toBeLessThan(mocks.getPublicJob.mock.invocationCallOrder[0]);
  });

  it('has the job title as its only h1, under the workspace name', async () => {
    const html = await renderJob();
    expect(count(html, /<h1[\s>]/g)).toBe(1);
    expect(html).toMatch(/<h1[^>]*>Senior Accountant<\/h1>/);
    expect(html).toContain('Tanjung Trading');
    expect(html).toMatch(/<a[^>]*href="#main"[^>]*>Skip to main content<\/a>/);
    expect(count(html, /<main[^>]*id="main"/g)).toBe(1);
  });

  it('lists the key facts above the description', async () => {
    const html = await renderJob();
    const facts = text(html.slice(html.indexOf('<dl'), html.indexOf('</dl>')));
    expect(facts).toContain('Department Finance');
    expect(facts).toContain('Location Kuala Lumpur');
    expect(facts).toContain('Work arrangement Hybrid');
    expect(facts).toContain('Employment type Full-time');
    expect(facts).toContain('Salary RM 4,000 – RM 6,000 a month');
    expect(facts).toContain('Closing date 31 October 2026');
    expect(facts).not.toContain('Applications closed');
    expect(html.indexOf('</dl>')).toBeLessThan(html.indexOf('About the role'));
  });

  it('leaves out each fact that is not there, a hidden salary among them', async () => {
    mocks.getPublicJob.mockResolvedValue(job({
      department: null, location: null, workArrangement: null, closesOn: null,
      salaryMinCents: null, salaryMaxCents: null,
    }));
    const html = await renderJob();
    expect(count(html, /<dt[\s>]/g)).toBe(1);
    expect(html).toContain('Employment type');
    for (const label of ['Department', 'Location', 'Work arrangement', 'Salary', 'Closing date']) {
      expect(html).not.toContain(label);
    }
  });

  it('says "Applications closed" after the closing date once it has passed', async () => {
    mocks.getPublicJob.mockResolvedValue(job({ accepting: false }));
    expect(text(await renderJob())).toContain('31 October 2026 · Applications closed');
  });

  it('shows the description as text with its line breaks, under "About the role"', async () => {
    const html = await renderJob();
    expect(html).toMatch(/<h2[^>]*>About the role<\/h2>/);
    expect(html).toMatch(/<p[^>]*class="[^"]*whitespace-pre-line[^"]*"[^>]*>Keep the books\.\n\nClose each month on time\.<\/p>/);
  });

  it('escapes markup in a description', async () => {
    mocks.getPublicJob.mockResolvedValue(job({ description: 'Hello <script>alert(1)</script> <b>bold</b>' }));
    const html = await renderJob();
    expect(html).toContain('Hello &lt;script&gt;alert(1)&lt;/script&gt; &lt;b&gt;bold&lt;/b&gt;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>');
  });

  it('links back to the board, under the way to apply', async () => {
    const html = await renderJob();
    expect(html).toMatch(new RegExp(`<a[^>]*href="/careers/${ORG}"[^>]*>(?:<[^>]+>|[^<])*All open roles`));
    expect(html.indexOf('All open roles')).toBeGreaterThan(html.indexOf('data-apply-form'));
    expect(html).not.toMatch(/apply now/i);
  });

  it('offers the apply form under the description of a job that is taking applications', async () => {
    mocks.getPublicJob.mockResolvedValue(job({ form: { ...job().form, require_cv: true } }));
    const html = await renderJob();
    expect(html).toMatch(/<h2[^>]*>Apply for this role<\/h2>/);
    expect(count(html, /data-apply-form/g)).toBe(1);
    expect(html.indexOf('Apply for this role')).toBeGreaterThan(html.indexOf('Keep the books.'));
    expect(html.indexOf('data-apply-form')).toBeGreaterThan(html.indexOf('Apply for this role'));
    expect(count(html, /<h1[\s>]/g)).toBe(1);
    expect(mocks.applyForm).toHaveBeenCalledTimes(1);
    const props = mocks.applyForm.mock.calls[0][0];
    expect(props).toEqual({
      action: expect.any(Function),
      form: { require_cv: true, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false },
      orgName: 'Tanjung Trading',
    });
  });

  it('hands the form an action already tied to this workspace and this job', async () => {
    await renderJob();
    const { action } = mocks.applyForm.mock.calls[0][0];
    mocks.submitPublicApplication.mockResolvedValue({ kind: 'ok' });
    const formData = new FormData();
    for (const [key, value] of Object.entries({ name: 'Aisyah Rahman', email: 'aisyah@example.com', consent: 'on' })) {
      formData.set(key, value);
    }
    expect(await action(undefined, formData)).toEqual({ done: { firstName: 'Aisyah' } });
    expect(mocks.readPublicJob).toHaveBeenCalledWith({ anonymous: true }, ORG, JOB_A);
    expect(mocks.submitPublicApplication.mock.calls[0].slice(1, 3)).toEqual([ORG, JOB_A]);
    // Counted once, as an application with no file.
    expect(mocks.consumeRateLimits).toHaveBeenCalledTimes(1);
    expect(mocks.consumeRateLimits.mock.calls[0][0].map((c: { bucket: string }) => c.bucket)).toEqual(['apply_client']);
  });

  it('says "Applications closed" and offers no way to apply once a job has stopped taking applications', async () => {
    mocks.getPublicJob.mockResolvedValue(job({ accepting: false }));
    const html = await renderJob();
    expect(html).toMatch(/<h2[^>]*>Apply for this role<\/h2>/);
    const apply = html.slice(html.indexOf('Apply for this role'), html.indexOf('All open roles'));
    expect(text(apply)).toContain('Applications closed');
    expect(html).not.toContain('data-apply-form');
    expect(mocks.applyForm).not.toHaveBeenCalled();
    expect(html).not.toMatch(/<(script|form|button|input|textarea)[\s>]/);
  });

  it('is "not found" when the reader returns nothing', async () => {
    mocks.getPublicJob.mockResolvedValue(null);
    await expect(JobPage(jobParams)).rejects.toThrow(NOT_FOUND);
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
  });

  it('is "not found", without a read, on a site with no database', async () => {
    mocks.hasSupabaseEnv.mockReturnValue(false);
    await expect(JobPage(jobParams)).rejects.toThrow(NOT_FOUND);
    expect(mocks.getPublicJob).not.toHaveBeenCalled();
  });
});

describe('the page for a link with nothing behind it', () => {
  it('says the page is not available, and nothing about why', () => {
    const html = renderToStaticMarkup(<CareersNotFound />);
    expect(html).toMatch(/<h1[^>]*>This page isn(?:'|&#x27;)t available<\/h1>/);
    expect(html).toContain('The role may have been filled or the link may be out of date.');
    expect(count(html, /<main[^>]*id="main"/g)).toBe(1);
    expect(html).toContain('Powered by OpenKuasa');
  });
  it('carries its own title and asks not to be indexed, since a not-found response takes its head from here', () => {
    expect(notFoundMetadata).toMatchObject({
      title: 'Page not available',
      description: null,
      robots: { index: false, follow: false },
      openGraph: { title: 'Page not available' },
    });
  });
});

describe('the page for anything that went wrong under /careers', () => {
  const error = Object.assign(new Error('relation "hire_jobs" does not exist'), { digest: 'abc123' });
  const html = renderToStaticMarkup(<CareersError error={error} retry={() => {}} />);

  it('says something went wrong inside the careers frame, with a button to try again', () => {
    expect(html).toMatch(/<h1[^>]*>Something went wrong<\/h1>/);
    expect(html).toMatch(/This page couldn(?:'|&#x27;)t be shown\. Please try again\./);
    expect(count(html, /<main[^>]*id="main"/g)).toBe(1);
    expect(html).toContain('Powered by OpenKuasa');
    const button = /<button([^>]*)>([\s\S]*?)<\/button>/.exec(html)!;
    expect(button[1]).toContain('type="button"');
    expect(button[2]).toBe('Try again');
    expect(button[1]).toMatch(/class="[^"]*\bh-11\b/);
  });
  it('shows nothing of the error itself', () => {
    expect(html).not.toContain('hire_jobs');
    expect(html).not.toContain('abc123');
  });
});

describe('the titles search engines and share cards see', () => {
  it('board: "Careers at <workspace>", described by the workspace when there is no tagline', async () => {
    const meta = await boardMetadata(boardParams);
    expect(meta.title).toBe('Careers at Tanjung Trading');
    expect(meta.description).toBe('Open roles at Tanjung Trading.');
    expect(meta.openGraph).toMatchObject({ title: 'Careers at Tanjung Trading' });
    expect(meta.twitter).toMatchObject({ title: 'Careers at Tanjung Trading' });
    expect(meta.robots).toEqual({ index: true, follow: true });
  });

  it('board: described by the tagline when there is one', async () => {
    mocks.getPublicCareers.mockResolvedValue(careers({ tagline: 'Small team, real work.' }));
    expect((await boardMetadata(boardParams)).description).toBe('Small team, real work.');
  });

  it('job: "<job title> at <workspace>", described by the start of the description', async () => {
    mocks.getPublicJob.mockResolvedValue(job({ description: `Keep  the books.\n\n${'word '.repeat(60)}` }));
    const meta = await jobMetadata(jobParams);
    expect(meta.title).toBe('Senior Accountant at Tanjung Trading');
    expect(meta.description).toHaveLength(160);
    expect(meta.description).toMatch(/^Keep the books\. word word /);
    expect(meta.openGraph).toMatchObject({ title: 'Senior Accountant at Tanjung Trading' });
    expect(meta.twitter).toMatchObject({ title: 'Senior Accountant at Tanjung Trading' });
    expect(meta.robots).toEqual({ index: true, follow: true });
  });

  it('nothing behind the link: "Page not available", not to be listed, and no "not found" thrown', async () => {
    mocks.getPublicCareers.mockResolvedValue(null);
    mocks.getPublicJob.mockResolvedValue(null);
    for (const meta of [await boardMetadata(boardParams), await jobMetadata(jobParams)]) {
      expect(meta.title).toBe('Page not available');
      expect(meta.robots).toEqual({ index: false, follow: false });
      expect(meta.openGraph).toMatchObject({ title: 'Page not available' });
    }
    expect(mocks.notFound).not.toHaveBeenCalled();
  });
});
