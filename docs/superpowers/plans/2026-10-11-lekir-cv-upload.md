# Lekir CV Upload Implementation Plan (slice 2e)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the public apply form, "CV" takes a PDF up to 5 MB as well as a link; a workspace member opens the file from the Applications screen through a 5-minute link; nobody else can read, list or write it.

**Architecture:** A stranger never talks to storage. The apply server action checks the file, uploads it with the service-role client to a private bucket under `<org>/<job>/<random>.pdf`, then calls `submit_public_application` with that path and removes the file if the answer is not `ok`. Members read through one storage `select` policy scoped by the first path segment. Deleted applications leave their path in a private table that a service-key route drains.

**Tech Stack:** Next.js 16.3.8 App Router (read `node_modules/next/dist/docs/` before any Next-specific code), React 19, Supabase Postgres 17 + Storage, Zod, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-11-lekir-cv-upload-design.md`

**Branch:** `feat-104-lekir-cv-upload` (from `origin/main` at `2883202`, which has 2d).

## Where this plan departs from the approved spec (owner to confirm)

1. **Only the server may attach a file.** The spec lets any caller pass `p_cv_path` and answers `ok_duplicate` on a repeat. A stranger calling the database directly could then learn whether an email has applied (the promise 2d made), and could attach a made-up path. Here the function honours `p_cv_path`, and answers `ok_duplicate`, only for the service role; anyone else passing a path gets `invalid_cv_path`. The apply action uses the service-role client for the one call that carries a file.
2. **The rate limit before upload needs its own small read.** The ticks table is private, so a service-role-only function `hire_apply_throttled(job)` answers yes or no. Two requests at the same moment can both pass it; the one the submit function then throttles has its file removed.
3. **No upload progress.** A server action gives the browser no progress events. The button says "Sending…" only.
4. **The 6 MB body limit is app-wide.** `experimental.serverActions.bodySizeLimit` cannot be set per route in this Next version.
5. **The CV group is always shown.** The spec says so (optional when not required); this changes 2d, where the CV link appeared only when required.
6. **The cleanup tables live in `private`,** which the API cannot reach, so the routine goes through two service-role-only functions.
7. **A crash between upload and submit leaves a file with no application.** Nothing sweeps those in this piece. Known limit.

## Global Constraints

- pnpm only. TypeScript strict, 2 spaces, single quotes, semicolons, named exports.
- No reference-product names in `src/`. No purple or violet.
- `org_id` and `job_id` come from the route, never from the form body. The stored file name is a random UUID; the upload's filename is never stored, logged or returned.
- A stranger's values and file are personal data: never logged, never put in an error. Log an error's `code` only.
- `anon` and `authenticated` get no insert, update or delete policy on `hire-cvs`. Writes and deletes are service role only.
- `service_role` has no default privileges here: every function it calls needs an explicit `grant execute`.
- Limits, verbatim: PDF only; `5 * 1024 * 1024` bytes; first five bytes `%PDF-`; signed link 300 seconds; path `^<org uuid>/<job uuid>/<uuid>\.pdf$`.
- Messages, verbatim:
  - `cvRequired`: `Upload a PDF or paste a link to your CV.`
  - `cvFileType`: `Choose a PDF file.`
  - `cvFileTooBig`: ``This file is ${size}. Choose one under 5 MB.`` where size is like `7.2 MB`
  - `cvUploadFailed`: `We couldn't upload your CV, so your application wasn't sent. Please try again.`
  - `cvFileAgain`: `Choose your CV file again before sending.`
  - View CV failure: `Couldn't open the CV. Try again.`; missing file: `This file is no longer available.`
- Implementers never run a `*.rls.test.ts` file, the whole suite, a build, a dev server, `evals/`, or anything against a database. They run only the test files their task names, then `pnpm exec tsc --noEmit` and `pnpm lint`.
- Git: plain separate commands (`git add <files>`, then `git commit -m "..."`). No compound commands.
- The migration is not applied by any task but Task 7, after the owner's yes.

## Review Focus

1. A repeat application that carries a file: the visitor sees the same thank-you, and the file is removed (Task 3 test "a duplicate leaves no object").
2. A text file renamed `.pdf`, or declared `application/pdf` with other bytes: refused before upload (Task 2 `isPdf`, Task 3 action test).
3. An untouched file input (the browser posts a zero-size file with an empty name): treated as no file, not as a bad PDF (Task 2 `chosenFile`, Task 3 action test).
4. A path for another workspace or job, or any path from a caller who is not the server: refused by the function (Task 1 text test, Task 6 live).
5. The upload succeeds and the submit call fails or throws: the file is removed and the form is kept (Task 3 action test).

---

### Task 1: The migration

**Files:**
- Create: `supabase/migrations/20261019090000_hire_cv_upload.sql`
- Test: `tests/hire-cv-upload-migration.test.ts`

**Interfaces:**
- Produces: column `hire_applications.cv_path`; bucket `hire-cvs`; `public.submit_public_application(…11 params…, p_cv_path text default null)` answering the 2d words plus `invalid_cv_path` and `ok_duplicate`; `public.hire_apply_throttled(p_job_id uuid) returns boolean`; `public.hire_cv_deletions_due(p_limit integer default 100) returns setof text`; `public.hire_cv_deletions_done(p_paths text[]) returns integer`.

- [ ] **Step 1: Write the failing text test.** Follow `tests/hire-public-applications-migration.test.ts` for how the file is read and how `fn(name)` cuts a function body. Cases, each asserting on the migration text:
  1. `cv_path` is added with a check matching `'^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.pdf$'` and a unique index where not null.
  2. The bucket row: `'hire-cvs'`, `false`, `5242880`, `array['application/pdf']`.
  3. Exactly one `create policy` whose text contains `'hire-cvs'` and `for select`; no policy text contains `'hire-cvs'` with `for insert`, `for update`, `for delete`; the only `for all` one is `as restrictive`. No policy names `anon`.
  4. The old function is dropped by its exact 11-type signature before the new one is created.
  5. In `submit_public_application`: the service-role gate comes before the job is read; the path shape is built from `p_org_id` and `p_job_id`; `cv_required` is answered only when both the link and the path are missing; `'ok_duplicate'` is returned only inside a branch that tests `v_cv_path is not null`; every `return '…'` word is one of the 2d list plus `invalid_cv_path`, `ok_duplicate`.
  6. Everything 2d's migration test asserts about ordering (honeypot first, lengths, shapes, lock, closed rule, consent, requirements, throttle, tick, advisory lock, notification block) still holds for the new body: copy those assertions.
  7. Execute grants: `submit_public_application` (12 types) to `anon, authenticated, service_role`; the three new functions to `service_role` only, each revoked from `public, anon, authenticated` first.
  8. `private.hire_cv_deletions` has RLS enabled and all revoked; the trigger is `after delete … for each row when (old.cv_path is not null)`; its function is `security definer` with `search_path = ''`.

- [ ] **Step 2: Run it.** `pnpm vitest run tests/hire-cv-upload-migration.test.ts` — Expected: FAIL (no such file).

- [ ] **Step 3: Write the migration.** Exactly this, with the body of `submit_public_application` copied from `supabase/migrations/20261018100000_hire_public_applications.sql` and changed only where marked `-- 2e`:

```sql
-- supabase/migrations/20261019090000_hire_cv_upload.sql
-- Lekir slice 2e: an applicant can give their CV as a PDF. A stranger never
-- talks to storage: the server uploads after its own checks, and only the
-- server may attach a file to an application.

alter table public.hire_applications
  add column cv_path text check (cv_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.pdf$');
create unique index hire_applications_cv_path_key on public.hire_applications (cv_path) where cv_path is not null;

-- ---------------------------------------------------------------------------
-- The bucket. Private, PDFs only, 5 MB.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hire-cvs', 'hire-cvs', false, 5242880, array['application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = 5242880, allowed_mime_types = array['application/pdf'];

-- A member may read (sign a link for) a file of their own workspace: the first
-- folder of the path is the workspace. The case keeps the cast from ever
-- running on another bucket's names. No write policy: the server writes.
create policy hire_cvs_select on storage.objects for select to authenticated
  using (case when bucket_id = 'hire-cvs'
              then private.is_org_member(((storage.foldername(name))[1])::uuid)
              else false end);
create policy hire_cvs_mfa_required on storage.objects as restrictive
  for all to authenticated
  using (bucket_id <> 'hire-cvs' or (select private.mfa_ok()))
  with check (bucket_id <> 'hire-cvs' or (select private.mfa_ok()));

-- ---------------------------------------------------------------------------
-- Files to remove. Postgres cannot delete a stored object safely, so a deleted
-- application leaves its path here and the server removes the object.
-- ---------------------------------------------------------------------------
create table private.hire_cv_deletions (
  path text primary key,
  deleted_at timestamptz not null default now()
);
alter table private.hire_cv_deletions enable row level security;
revoke all on private.hire_cv_deletions from public, anon, authenticated;

create or replace function private.hire_note_cv_deletion()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into private.hire_cv_deletions (path) values (old.cv_path) on conflict (path) do nothing;
  return old;
end $$;
revoke execute on function private.hire_note_cv_deletion() from public, anon, authenticated;

create trigger hire_applications_cv_deleted
  after delete on public.hire_applications
  for each row when (old.cv_path is not null)
  execute function private.hire_note_cv_deletion();

create or replace function public.hire_cv_deletions_due(p_limit integer default 100)
returns setof text language sql security definer stable set search_path = '' as $$
  select d.path from private.hire_cv_deletions d
   order by d.deleted_at
   limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

create or replace function public.hire_cv_deletions_done(p_paths text[])
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  delete from private.hire_cv_deletions d where d.path = any(coalesce(p_paths, '{}'));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- True when the job has taken its 30 applications this minute. Asked by the
-- server before it uploads a file, so the limit also bounds storage writes.
create or replace function public.hire_apply_throttled(p_job_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select count(*) >= 30 from private.hire_apply_ticks t
   where t.job_id = p_job_id and t.at > now() - interval '1 minute';
$$;

-- ---------------------------------------------------------------------------
-- The submit function gains the file's path. The argument list changes, so
-- the old function is dropped and made again in this one transaction.
-- ---------------------------------------------------------------------------
drop function public.submit_public_application(uuid, uuid, text, text, text, text, text, text, bigint, boolean, text);

create or replace function public.submit_public_application(
  p_org_id uuid,
  p_job_id uuid,
  p_name text,
  p_email text,
  p_phone text default null,
  p_cover_letter text default null,
  p_cv_url text default null,
  p_portfolio_url text default null,
  p_expected_salary_cents bigint default null,
  p_consent boolean default false,
  p_honeypot text default null,
  p_cv_path text default null                                                   -- 2e
)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  -- … every 2d declaration, unchanged …
  v_cv_path text := nullif(btrim(coalesce(p_cv_path, '')), '');                 -- 2e
begin
  -- honeypot: unchanged

  -- 2e: only the server may attach a file. Anyone else naming one is refused
  -- before anything is read, so the answer says nothing about the job or the email.
  if v_cv_path is not null and coalesce((select auth.role()), '') <> 'service_role' then
    return 'invalid_cv_path';
  end if;

  -- lengths: unchanged
  -- one line of text, name, email, links, salary: unchanged

  -- 2e: the file must sit under this workspace and this job, with a random name.
  if v_cv_path is not null and v_cv_path !~ ('^' || p_org_id::text || '/' || p_job_id::text
       || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$') then
    return 'invalid_cv_path';
  end if;

  -- job lock, not_found, closed rule, consent: unchanged

  if v_require_cv and v_cv = '' and v_cv_path is null then return 'cv_required'; end if;   -- 2e
  -- cover letter, portfolio, salary, throttle, ticks, advisory lock, candidate: unchanged

  insert into public.hire_applications
    (org_id, candidate_id, job_id, stage, outcome, source,
     cover_letter, cv_url, cv_path, portfolio_url, expected_salary_cents, consented_at)     -- 2e
  values
    (p_org_id, v_candidate_id, v_job_id, 'applied', 'active', 'Careers page',
     nullif(v_cover, ''), nullif(v_cv, ''), v_cv_path, nullif(v_portfolio, ''), v_salary, now())
  on conflict (candidate_id, job_id) do nothing
  returning id into v_application_id;

  -- notification block: unchanged

  -- 2e: a repeat that came with a file. Only the server can reach this line;
  -- it removes the file it just stored. The visitor is thanked all the same.
  if v_application_id is null and v_cv_path is not null then
    return 'ok_duplicate';
  end if;

  return 'ok';
end $$;

revoke execute on function public.submit_public_application(uuid, uuid, text, text, text, text, text, text, bigint, boolean, text, text) from public, anon, authenticated;
grant execute on function public.submit_public_application(uuid, uuid, text, text, text, text, text, text, bigint, boolean, text, text) to anon, authenticated, service_role;

revoke execute on function public.hire_apply_throttled(uuid) from public, anon, authenticated;
revoke execute on function public.hire_cv_deletions_due(integer) from public, anon, authenticated;
revoke execute on function public.hire_cv_deletions_done(text[]) from public, anon, authenticated;
grant execute on function public.hire_apply_throttled(uuid) to service_role;
grant execute on function public.hire_cv_deletions_due(integer) to service_role;
grant execute on function public.hire_cv_deletions_done(text[]) to service_role;
```

The "unchanged" comments above are instructions to you, not text for the file: the file must contain the whole function body, written out.

- [ ] **Step 4: Run the test.** Same command — Expected: PASS. Also run `pnpm vitest run tests/hire-public-applications-migration.test.ts` — Expected: PASS (the 2d file is untouched).

- [ ] **Step 5: Commit.** `git add supabase/migrations/20261019090000_hire_cv_upload.sql tests/hire-cv-upload-migration.test.ts` then `git commit -m "feat(hire): a private bucket for CVs; only the server may attach a file to an application"`.

---

### Task 2: File rules, the store, and the submit seam

**Files:**
- Modify: `src/lib/hire/application-fields.ts`, `src/lib/hire/public-applications.ts`
- Create: `src/lib/hire/cv-store.ts`
- Test: `tests/hire-application-fields.test.ts` (extend), `tests/hire-public-applications.test.ts` (extend), `tests/hire-cv-store.test.ts` (new)

**Interfaces:**
- Produces, in `application-fields.ts` (pure, no imports of code):
  - `CV_FILE_FIELD = 'cv_file'`, `CV_MAX_BYTES = 5 * 1024 * 1024`
  - `type CvFileInfo = { name: string; size: number; type: string }`
  - `fileSizeLabel(bytes: number): string` — `7.2 MB`, `480 KB`, one decimal for MB, whole KB
  - `chosenFile(value: unknown): CvFileInfo | null` — null unless the value has a numeric `size` and a string `name`, and is not the untouched input (`size === 0 && name === ''`)
  - `cvFileProblem(file: CvFileInfo | null): string | null` — null for no file; `cvFileType` when `size === 0`, or the type is not `application/pdf` and the name does not end `.pdf` (case-insensitive), or the type is set and is not `application/pdf`; `cvFileTooBig` when over the limit (size check first)
  - `ApplyErrors` becomes `Partial<Record<ApplyField | 'cv_file', string>>`
  - `applyProblems(values, form, hasCvFile = false)` and `fieldProblem(field, values, form, hasCvFile = false)`: a chosen file meets `require_cv`
  - `shownFields`: `cv_url` is always shown
  - the five new messages in `APPLY_MESSAGES` (`cvFileTooBig` is a function of the label), and `cvRequired` reworded
- Produces, in `cv-store.ts` (`import 'server-only'`):
  - `CV_BUCKET = 'hire-cvs'`, `CV_LINK_SECONDS = 300`
  - `isPdf(bytes: Uint8Array): boolean`
  - `cvPath(orgId: string, jobId: string): string` — `${orgId}/${jobId}/${randomUUID()}.pdf`
  - `storeCv(service: SupabaseClient, orgId: string, jobId: string, bytes: Uint8Array): Promise<string | null>` — checks length (1..`CV_MAX_BYTES`) and `isPdf`, uploads with `{ contentType: 'application/pdf', upsert: false }`, returns the path or null; logs only an error code
  - `removeCv(service: SupabaseClient, path: string): Promise<boolean>`
  - `signedCvUrl(client: SupabaseClient, path: string): Promise<string | null>` — `createSignedUrl(path, CV_LINK_SECONDS, { download: 'cv.pdf' })`
- Produces, in `public-applications.ts`: `submitPublicApplication(client, orgId, jobId, values, form, honeypot?, cvPath?: string | null)`; `ApplyOutcome` gains `{ kind: 'duplicate' }`; `applyOutcome('ok_duplicate')` is `duplicate`; `invalid_cv_path` is `failed`; `p_cv_path` is sent only when `cvPath` is given; a given `cvPath` counts as `hasCvFile` for the checks.

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/hire-cv-store.test.ts
import { describe, expect, it, vi } from 'vitest';
import { CV_BUCKET, cvPath, isPdf, removeCv, signedCvUrl, storeCv } from '@/lib/hire/cv-store';

const ORG = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const pdf = (extra = 20) => new Uint8Array([...new TextEncoder().encode('%PDF-1.7\n'), ...new Uint8Array(extra)]);

function fakeService(result: { error: { statusCode?: string } | null } = { error: null }) {
  const upload = vi.fn(async () => ({ data: result.error ? null : {}, ...result }));
  const remove = vi.fn(async () => ({ data: [], error: null }));
  const createSignedUrl = vi.fn(async () => ({ data: { signedUrl: 'https://x/signed' }, error: null }));
  const from = vi.fn(() => ({ upload, remove, createSignedUrl }));
  return { client: { storage: { from } } as never, from, upload, remove, createSignedUrl };
}

describe('isPdf', () => {
  it('is true for bytes that start %PDF-', () => expect(isPdf(pdf())).toBe(true));
  it('is false for a text file with a pdf name', () => expect(isPdf(new TextEncoder().encode('hello world'))).toBe(false));
  it('is false for an empty file', () => expect(isPdf(new Uint8Array())).toBe(false));
  it('is false for four of the five bytes', () => expect(isPdf(new TextEncoder().encode('%PDF'))).toBe(false));
});

describe('cvPath', () => {
  it('is the workspace, the job and a random name', () => {
    expect(cvPath(ORG, JOB)).toMatch(new RegExp(`^${ORG}/${JOB}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.pdf$`));
    expect(cvPath(ORG, JOB)).not.toBe(cvPath(ORG, JOB));
  });
});

describe('storeCv', () => {
  it('uploads a PDF to the private bucket, never replacing, and answers with the path', async () => {
    const s = fakeService();
    const path = await storeCv(s.client, ORG, JOB, pdf());
    expect(path).toMatch(new RegExp(`^${ORG}/${JOB}/`));
    expect(s.from).toHaveBeenCalledWith(CV_BUCKET);
    expect(s.upload).toHaveBeenCalledWith(path, expect.any(Uint8Array), { contentType: 'application/pdf', upsert: false });
  });
  it('refuses what is not a PDF without uploading', async () => {
    const s = fakeService();
    expect(await storeCv(s.client, ORG, JOB, new TextEncoder().encode('not a pdf'))).toBeNull();
    expect(s.upload).not.toHaveBeenCalled();
  });
  it('refuses a file over 5 MB without uploading', async () => {
    const s = fakeService();
    expect(await storeCv(s.client, ORG, JOB, pdf(5 * 1024 * 1024))).toBeNull();
    expect(s.upload).not.toHaveBeenCalled();
  });
  it('answers null when storage refuses', async () => {
    const s = fakeService({ error: { statusCode: '500' } });
    expect(await storeCv(s.client, ORG, JOB, pdf())).toBeNull();
  });
  it('answers null when storage throws', async () => {
    const s = fakeService();
    s.upload.mockRejectedValueOnce(new Error('network'));
    expect(await storeCv(s.client, ORG, JOB, pdf())).toBeNull();
  });
});

describe('removeCv and signedCvUrl', () => {
  it('removes one path', async () => {
    const s = fakeService();
    expect(await removeCv(s.client, `${ORG}/${JOB}/x.pdf`)).toBe(true);
    expect(s.remove).toHaveBeenCalledWith([`${ORG}/${JOB}/x.pdf`]);
  });
  it('signs for five minutes as a download', async () => {
    const s = fakeService();
    expect(await signedCvUrl(s.client, 'p.pdf')).toBe('https://x/signed');
    expect(s.createSignedUrl).toHaveBeenCalledWith('p.pdf', 300, { download: 'cv.pdf' });
  });
  it('answers null when signing fails', async () => {
    const s = fakeService();
    s.createSignedUrl.mockResolvedValueOnce({ data: null, error: { statusCode: '404' } } as never);
    expect(await signedCvUrl(s.client, 'p.pdf')).toBeNull();
  });
});
```

  In `tests/hire-application-fields.test.ts` add cases:
  - `fileSizeLabel(7.2 * 1024 * 1024)` is `7.2 MB`; `fileSizeLabel(480 * 1024)` is `480 KB`; `fileSizeLabel(5 * 1024 * 1024)` is `5.0 MB`.
  - `chosenFile({ name: '', size: 0, type: 'application/octet-stream' })` is null; `chosenFile('text')` is null; `chosenFile(null)` is null; `chosenFile({ name: 'cv.pdf', size: 10, type: 'application/pdf' })` returns the three fields only.
  - `cvFileProblem(null)` is null; a 10-byte PDF is null; `{ name: 'cv.pdf', size: 0, type: 'application/pdf' }` is `Choose a PDF file.`; `{ name: 'cv.docx', size: 10, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }` is `Choose a PDF file.`; `{ name: 'CV.PDF', size: 10, type: '' }` is null; `{ name: 'cv.pdf', size: 10, type: 'text/plain' }` is `Choose a PDF file.`; a 7.2 MB PDF is `This file is 7.2 MB. Choose one under 5 MB.`.
  - With `require_cv` on and no link: `applyProblems(values, form)` has `cv_url: 'Upload a PDF or paste a link to your CV.'`; `applyProblems(values, form, true)` has no `cv_url` key.
  - `shownFields` with everything off includes `cv_url`. Update every existing case that expected it hidden.
  - A bad link with a file chosen is still `urlInvalid`.

  In `tests/hire-public-applications.test.ts` add: `applyOutcome('ok_duplicate')` is `{ kind: 'duplicate' }`; `applyOutcome('invalid_cv_path')` is `{ kind: 'failed' }`; with `cvPath` given the rpc args carry `p_cv_path` and, with `require_cv` on and no link, the call is made (not `invalid`); without `cvPath` the args have no `p_cv_path` key.

- [ ] **Step 2: Run them.** `pnpm vitest run tests/hire-cv-store.test.ts tests/hire-application-fields.test.ts tests/hire-public-applications.test.ts` — Expected: FAIL (missing exports).

- [ ] **Step 3: Implement** the three files to the interfaces above. `cv-store.ts` wraps each storage call in `try/catch` and logs `console.error('[cv-store] upload failed:', { code })` with the error's `statusCode` or `name` only.

- [ ] **Step 4: Run again** — Expected: PASS. Then the other files that use these modules: `pnpm vitest run tests/hire-apply-action.test.ts tests/hire-apply-form.test.tsx tests/hire-careers-pages.test.tsx` — fix only expectations that change because the CV link is now always shown or the message was reworded. `pnpm exec tsc --noEmit` and `pnpm lint` clean.

- [ ] **Step 5: Commit.** `git commit -m "feat(hire): the rules for a CV file, the private store, and a path on the submit call"` after adding the files by name.

---

### Task 3: The apply action and the form's CV group

**Files:**
- Modify: `src/app/careers/[orgId]/[jobId]/actions.ts`, `src/app/careers/[orgId]/[jobId]/apply-form.tsx`, `next.config.ts`
- Test: `tests/hire-apply-action.test.ts`, `tests/hire-apply-form.test.tsx`

**Interfaces:**
- Consumes: everything Task 2 produces; `serviceClient()` from `@/lib/supabase/service`; `hire_apply_throttled` (rpc, boolean).
- Produces: `ApplyState` gains `fileDropped?: true` (a file was posted and the application was not taken, so a form re-rendered by the server has lost it).

Read first: the two files as they stand (the 27 rules of 2d still bind and are documented in the header comment of `apply-form.tsx`), and in `node_modules/next/dist/docs/`: `serverActions.md` (`bodySizeLimit`), the forms guide, and what `useActionState` does with a file input.

**The action, in this order:**
1. Not a form → `{ error: failed }` (unchanged).
2. Read the eight values (unchanged). Read `formData.get(CV_FILE_FIELD)` through `chosenFile`.
3. Honeypot → thank-you, nothing kept, nothing uploaded.
4. Bad ids or no environment → `{ closed: true }`. `readPublicJob`: `failed` → error and values; `missing` or not accepting → closed.
5. `errors = applyProblems(values, job.form, file !== null)`; if `cvFileProblem(file)` add it as `errors.cv_file`. Any error → `{ errors, values, fileDropped }` where `fileDropped` is true when a file was posted.
6. No file → exactly the 2d path with the anonymous client.
7. A file: read its bytes once (`new Uint8Array(await raw.arrayBuffer())`). Over the limit or not `isPdf` → `{ errors: { cv_file: cvFileType or cvFileTooBig }, values, fileDropped: true }`. The declared size and type are not trusted: the bytes decide.
8. `serviceClient()` inside `try`: if it throws (no key) → `{ error: failed, values, fileDropped: true }`.
9. `hire_apply_throttled`: an error → `failed`; `true` → `{ error: throttled, values, fileDropped: true }`.
10. `storeCv` → null → `{ error: cvUploadFailed, values, fileDropped: true }`.
11. `submitPublicApplication(service, orgId, jobId, values, job.form, null, path)` inside `try/finally`: unless the outcome is `ok`, `removeCv(service, path)` is awaited (also when the call throws). `ok` and `duplicate` both → the thank-you. Others as in 2d, each with `fileDropped: true`.
12. Nothing logs a value, a filename or a path.

**`next.config.ts`:** add `experimental: { serverActions: { bodySizeLimit: '6mb' } }` with a one-line comment: a 5 MB CV plus the form's other fields.

**The form, rules (numbered on from 2d's 27):**
28. One group labelled "CV": a `<fieldset>` with a `<legend>` "CV" carrying the required mark or "(optional)", helper text `Upload a PDF or paste a link.` always, and the group's missing-CV problem under the legend, tied by `aria-describedby`.
29. Inside, in this order: the file input, the word "or", the link input (2d's `cv_url`, relabelled "Link to your CV"; its own problems stay under it).
30. The file input is a real `<input type="file" name="cv_file" accept="application/pdf,.pdf">` with a visible `<label>` "Upload a PDF" and the text `PDF, up to 5 MB` beside it before anything is chosen, tied by `aria-describedby`. It is never `display:none` or `hidden`; if a styled button sits over it, the input stays focusable and shows a focus ring. 44 px target.
31. On change (script running): `cvFileProblem` runs at once. A problem shows under the input with `role="alert"`, and the input keeps focus. No problem: the file's name (wrapping, never widening the page at 375 px) and `fileSizeLabel` are shown with a "Remove" button (`aria-label` "Remove <name>") that clears the input and returns focus to it.
32. A file with a problem stops sending, like any field problem: it is in the summary at the top, and the summary link moves focus to the file input.
33. The missing-CV problem appears only when required and neither a link nor a file is given. Choosing a file or typing a link clears it.
34. The `<form>` posts as `multipart/form-data` in both layers; confirm from the docs how a function `action` sets it and say what you found.
35. Sending: the scripted path sends the same `FormData` (file included). The button says "Sending…" and cannot be pressed twice (unchanged). No progress bar.
36. A rejected or failed scripted send keeps the chosen file in the input (the DOM is not reset; verify with the docs as 2d did).
37. Without the script, a re-rendered form cannot keep a file. When the state has `fileDropped`, the server-rendered form shows `Choose your CV file again before sending.` under the file input. The scripted layer does not show it while the input still holds a file.
38. A post the framework refuses for size reaches the scripted `catch`: it shows `unreachable` as now. Nothing more is needed.
39. Field order in `APPLY_FIELDS` is unchanged; `cv_file` problems are reported at the `cv_url` position in the summary, before the link's own.

- [ ] **Step 1: Write the failing action tests** in `tests/hire-apply-action.test.ts`, extending its existing mocks with `storeCv`, `removeCv`, `serviceClient` (returning an object whose `rpc` is a mock answering `{ data: false, error: null }`), and a helper `withFile(fields, bytes, name = 'cv.pdf', type = 'application/pdf')` that appends a `File`. Cases:
  1. An untouched file input (empty `File`, name `''`) takes the 2d path: the anonymous client submits, `storeCv` is not called.
  2. A PDF with valid fields: `hire_apply_throttled` asked with the job id, `storeCv` called with the route's ids, `submitPublicApplication` called with the service client and the path, answer is the thank-you, `removeCv` not called.
  3. A text file named `cv.pdf` declared `application/pdf`: `errors.cv_file` is `Choose a PDF file.`, `storeCv` not called, `fileDropped` true.
  4. A file of `5 * 1024 * 1024 + 1` bytes: `errors.cv_file` matches `/^This file is 5\.0 MB\. Choose one under 5 MB\.$/`, `storeCv` not called.
  5. A PDF with a missing name: field errors come back, `storeCv` not called, `fileDropped` true.
  6. Throttled before upload: `throttled` message, `storeCv` not called.
  7. The throttle read errors: `failed`, `storeCv` not called.
  8. `storeCv` answers null: `cvUploadFailed`, submit not called.
  9. Submit answers `duplicate`: thank-you, `removeCv` called with the path.
  10. Submit answers `closed`, `throttled`, `invalid`, `failed` (four cases): the 2d answer for each, `removeCv` called with the path.
  11. Submit throws: `removeCv` called with the path; the action answers `failed` with the values.
  12. `serviceClient` throws: `failed` with the values, nothing uploaded.
  13. The honeypot filled with a PDF attached: thank-you, nothing read from storage, nothing uploaded.
  14. `require_cv` on, no link, a PDF: goes through. `require_cv` on, no link, no file: `errors.cv_url` is `Upload a PDF or paste a link to your CV.`
  15. No call in any case logs the filename (spy on `console.error` and `console.log`, assert no argument contains `cv.pdf`).

- [ ] **Step 2: Run** `pnpm vitest run tests/hire-apply-action.test.ts` — Expected: the new cases FAIL.
- [ ] **Step 3: Implement the action and the config.** Run again — Expected: PASS.
- [ ] **Step 4: Commit.** `git commit -m "feat(hire): the apply action stores a CV after its checks and removes it when the application is refused"`.
- [ ] **Step 5: Write the failing form tests** in `tests/hire-apply-form.test.tsx` (server-rendered markup, as the file does now): the fieldset and legend; "(optional)" when not required and the required mark when required; `PDF, up to 5 MB` present before any choice; the file input's `name`, `type`, `accept` and label; the "or"; the link input's new label; `fileDropped` renders `Choose your CV file again before sending.`; a `cv_file` error renders under the file input with `role="alert"`; the group shows with every switch off.
- [ ] **Step 6: Run** — Expected: FAIL. **Implement the form.** Run `pnpm vitest run tests/hire-apply-action.test.ts tests/hire-apply-form.test.tsx tests/hire-careers-pages.test.tsx tests/hire-application-fields.test.ts` — Expected: PASS. `pnpm exec tsc --noEmit`, `pnpm lint` clean.
- [ ] **Step 7: Commit.** `git commit -m "feat(hire): the apply form takes a CV as a PDF or a link"`.

In the report, give a browser checklist for what a rendered-markup test cannot show (rules 31, 32, 35, 36, 37 at 375 px, with a keyboard, and with JavaScript off).

---

### Task 4: Inside the app

**Files:**
- Modify: `src/lib/hire/types.ts`, `src/lib/hire/supabase.ts`, `src/lib/hire/seed.ts`, `src/lib/hire/lists.ts`, `src/app/(app)/hire/actions.ts`, `src/screens/hire/application-details.tsx`, `src/screens/hire/applications.tsx` (only if it builds row data), `src/lib/ai/hire-tools.ts`, `src/lib/ai/agents/prompts.ts`
- Test: `tests/hire-lists.test.ts`, `tests/hire-view-cv-action.test.ts` (new), the existing hire-tools test file

**Interfaces:**
- Consumes: `signedCvUrl` (Task 2).
- Produces:
  - `Application.cv_path: string | null`; `'cv_path'` in `APPLICATION_COLUMNS`; `cv_path: null` on every seed application.
  - `ApplicationDetails.hasCvFile: boolean`; details are non-null when any of the five is present. **The path never leaves the server:** it is not in `ApplicationDetails`, not in row data, not in a tool result.
  - `viewCvAction(applicationId: unknown): Promise<{ ok: true; url: string } | { ok: false; error: string }>` in `src/app/(app)/hire/actions.ts`.
  - `listApplications` tool: with `includeContact`, each row gains `has_cv_file: boolean`.

**`viewCvAction`:** `getViewer()`; a demo viewer → `{ ok: false, error: 'This file is no longer available.' }` (the demo has no files). The id must be a UUID. With the session client (`createClient()`), `select cv_path from hire_applications where id = … and org_id = viewer.orgId` (`maybeSingle`): no row or a null path → `This file is no longer available.`; a read error → `Couldn't open the CV. Try again.` Then `signedCvUrl(client, path)`: null → `Couldn't open the CV. Try again.`; else `{ ok: true, url }`. Any member may view, viewers included: do not gate on `edit-data`. Nothing is revalidated. The path is never returned or logged.

**The details panel:** when `details.hasCvFile`, a "View CV" button (`type="button"`, 44 px target, the file's row labelled "CV file" in the `dl`). On press: open a blank tab at once (`window.open('about:blank', '_blank')`) so a popup blocker allows it, call the action in a transition, then on success set `tab.opener = null` and `tab.location.replace(url)`; if no tab could be opened, `window.location.assign(url)` (the link is a download, so the page stays). On failure close the blank tab and show the action's message under the button with `role="alert"`. While pending the button is `aria-disabled`, says "Opening…", and ignores presses. If both a file and a link exist, both show; the link row keeps the label "CV".

**The tool and prompt:** `has_cv_file: a.cv_path !== null` inside the `people &&` block. In `prompts.ts`, where 2d told the assistant what an applicant's details include, add that `has_cv_file` says whether a PDF was uploaded, that it cannot read the file, and that the owner opens it from Applications → Details → View CV.

- [ ] **Step 1: Failing tests.**
  - `tests/hire-lists.test.ts`: an application with only `cv_path` set has details with `hasCvFile: true` and no other value; one with nothing has `details: null`; no key of the details object equals or contains the path string.
  - `tests/hire-view-cv-action.test.ts` (mock `@/lib/auth/viewer`, `@/lib/supabase/server`, `@/lib/hire/cv-store`, following `tests/hire-apply-action.test.ts` for the mocking style): demo viewer → not available, no query; a non-UUID id → not available, no query; no row → not available; null path → not available; read error → couldn't open; signing null → couldn't open; success → `{ ok: true, url }` and the query filtered by both the id and the viewer's org; a viewer-role member succeeds; the result never contains the path.
  - hire-tools test: `has_cv_file` true/false with `includeContact`, absent without; no `cv_path` key in any result.
- [ ] **Step 2: Run** the three files — Expected: FAIL.
- [ ] **Step 3: Implement.** Run again — Expected: PASS. Then `pnpm vitest run tests/hire-seed.test.ts tests/hire-supabase.test.ts` if those files exist, `pnpm exec tsc --noEmit`, `pnpm lint`.
- [ ] **Step 4: Commit.** `git commit -m "feat(hire): a member opens an applicant's CV file through a five-minute link"`.

---

### Task 5: Cleanup

**Files:**
- Create: `src/lib/hire/cv-cleanup.ts`, `src/app/api/hire/cv-cleanup/route.ts`
- Test: `tests/hire-cv-cleanup.test.ts`, `tests/hire-cv-cleanup-route.test.ts`

**Interfaces:**
- Consumes: `CV_BUCKET` (Task 2); rpc `hire_cv_deletions_due`, `hire_cv_deletions_done` (Task 1); `isTriggerAuthorized`, `serviceClient`.
- Produces: `cleanCvFiles(service: SupabaseClient, limit = 100): Promise<{ removed: number; failed: boolean }>`.

**`cleanCvFiles`:** call `hire_cv_deletions_due({ p_limit: limit })`; an error → log the code, `{ removed: 0, failed: true }`; no paths → `{ removed: 0, failed: false }`. `service.storage.from(CV_BUCKET).remove(paths)`: an error → log the code, `{ removed: 0, failed: true }` and the rows stay for the next run. No error (an object already gone is not an error) → `hire_cv_deletions_done({ p_paths: paths })`; its error → `failed: true`; else `{ removed: paths.length, failed: false }`. Paths are never logged.

**The route:** copy `src/app/api/agents/poll/route.ts`: `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, `POST`, 401 without `isTriggerAuthorized`, then `cleanCvFiles(serviceClient())` and `NextResponse.json({ ok: !result.failed, removed: result.removed })`. Check how `src/proxy.ts` (or the middleware file this version uses) lets `/api/agents/poll` through without a session and make sure `/api/hire/cv-cleanup` is treated the same; say what you found.

- [ ] **Step 1: Failing tests.** `cleanCvFiles`: nothing due; three due and removed (remove called once with the three, done called with the three, `removed: 3`); the due read errors; remove errors (done not called); done errors; the limit is passed through. Route: 401 with no header and with a wrong key (the routine not called); 200 with the right `x-service-key`; `ok: false` when the routine reports `failed`. Mock `@/lib/supabase/service` and set `process.env.SUPABASE_SERVICE_ROLE_KEY` in the test as `tests/agent-runner.test.ts` or the agents route tests do.
- [ ] **Step 2: Run** `pnpm vitest run tests/hire-cv-cleanup.test.ts tests/hire-cv-cleanup-route.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Run again — Expected: PASS. `tsc`, `lint` clean.
- [ ] **Step 4: Commit.** `git commit -m "feat(hire): files of deleted applications are removed by a service-key route"`.

---

### Task 6: The live test (written, not run)

**Files:**
- Create: `tests/hire-cv-upload.rls.test.ts`

Follow `tests/hire-public-applications.rls.test.ts` for setup (`ownedOrg`, `newJob`, turning the board on, the viewer membership, `afterAll`). The file needs a service-role client (`createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, …)`); skip every case when that key or the Supabase environment is missing. **Do not run this file.** Ordered cases:

1. As a signed-out visitor (anonymous key, no session) on `hire-cvs`: `upload` is refused; `list('')` returns nothing or an error; `download` of a real path is refused; `remove` of a real path leaves the object there (check with the service client); `createSignedUrl` is refused.
2. As an anonymous signed-in user who is in no workspace: the same five.
3. The service client uploads a small PDF to `<ownerOrg>/<job>/<uuid>.pdf`. The owner signs a link for it and fetching the link returns 200 with the PDF bytes. A viewer of that workspace can too. The owner of the other workspace cannot sign it. A member cannot `upload`, `update` or `remove` in the bucket (the object is still there afterwards).
4. The service client cannot upload a `text/plain` object or one over 5 MB to the bucket (the bucket refuses).
5. `submit_public_application` called by a visitor with a well-shaped `p_cv_path`: answers `invalid_cv_path`; no candidate, application or tick is written.
6. Called by the service client: a path under another workspace, another job, a non-UUID name, and a `.txt` name each answer `invalid_cv_path`.
7. Called by the service client with a good path on a job that requires a CV and no link: `ok`; the application row has `cv_path` and a null `cv_url`.
8. The same email and job again with a second path: `ok_duplicate`; the stored `cv_path` is still the first.
9. A visitor repeating an application without a path still gets `ok` (2d's promise).
10. `hire_apply_throttled`, `hire_cv_deletions_due`, `hire_cv_deletions_done`: a visitor and a member each get a permission error; the service client gets a boolean / a list / a number.
11. A member cannot read `hire_cv_deletions` through the API (the `private` schema is not exposed).
12. `get_public_job` still returns its 18 columns and nothing about a path.

`afterAll`: remove every object this run uploaded (service client), then the 2d file's cleanup. The header comment says what stays behind, as 2d's does. Deleting an application to prove the trigger is not possible from a test (no delete path exists yet); Task 7 proves it by hand.

- [ ] **Step 1:** Write the file. `pnpm exec tsc --noEmit` and `pnpm lint` clean.
- [ ] **Step 2: Commit.** `git commit -m "test(hire): live checks of the CV bucket and of who may attach a file"`.

---

### Task 7: Apply, prove, ship (controller only)

- [ ] Whole-branch review by a fresh reviewer on the most capable model; one fix pass.
- [ ] Ask the owner: (1) apply `hire_cv_upload`; (2) push and open the PR after the checks; (3) add the cleanup call to the scheduler.
- [ ] Read-only pre-checks on live: no object named `hire-cvs`; `auth.role()` exists; the 11-type function signature matches the `drop`.
- [ ] Apply in one `apply_migration` call. Verify: the column, check and unique index; the bucket row; the two policies and no other naming `hire-cvs`; `has_function_privilege` for `anon`, `authenticated`, `service_role` on all four functions; `has_table_privilege('service_role', …)` is not needed (functions only); the trigger exists; `select private.reseed_demo_hire()`; security advisors.
- [ ] Confirm production (still on 2d code) can apply: one signed-out application through openkuasa.com to the smoke job with the board on, then the board off again.
- [ ] `pnpm vitest run tests/hire-cv-upload.rls.test.ts`, then `tests/hire-public-applications.rls.test.ts` (its repeat case must still pass), then the suite without rls files, `tsc`, `lint`, `build`.
- [ ] Local smoke at 375 px, signed out: the CV group with everything off; choose a 7 MB file; choose a renamed `.txt`; choose a PDF, see name, size and Remove; send with a PDF; repeat with the same email and another PDF (thank-you; one object in the bucket for that application; the second gone); required with neither; offline with a file chosen (file kept); JavaScript off with a PDF; JavaScript off with a PDF and a bad email (the "choose again" line). Signed in: View CV downloads the PDF; the link fails after 5 minutes; a second workspace's member cannot open it; Lekir says the applicant uploaded a CV file (one billed question).
- [ ] Trigger and cleanup by hand, after a yes for the delete: delete one test application by id in SQL, see its path in `private.hire_cv_deletions`, `POST /api/hire/cv-cleanup` locally with the service key header, see the object and the row gone.
- [ ] Restore the smoke workspace. `gh api user --jq .login` is `OpenKuasa`. Fetch, rebase onto `origin/main`, re-run the suite if main moved. Check no other branch holds migration version `20261019090000` and that `feat-104` is free on the remote; renumber if not. Push. PR titled with the branch name; the body lists the migration as applied, the departures from the spec, the app-wide 6 MB limit, and the operator step (a third `POST` to `/api/hire/cv-cleanup` in the Railway cron function). No close keyword. Do not merge until asked.
- [ ] After the merge and the owner's sign-in: production smoke (apply with a PDF, View CV, a renamed `.txt`), the scheduler step, delete the workspace folder for this plan, update the roadmap memory.
