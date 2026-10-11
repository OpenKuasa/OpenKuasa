# Lekir Public Apply Form (slice 2d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-out visitor on an open job's public page can apply; the application appears at once on the workspace's Applications and Candidates screens and its members get an in-app notification.

**Architecture:** One `security definer` database function, `submit_public_application`, is the only thing a visitor can write through; `anon` gets no table grant. The page's server action checks the fields with the same rules, then calls the function with a session-less client and maps the word it returns to a message. One pure module holds the fields, limits and messages so the browser form, the server action and the tests cannot disagree.

**Tech Stack:** Next.js App Router (this repo's version has breaking changes: read `node_modules/next/dist/docs/` before writing a page, a server action or a form), Supabase Postgres with RLS, Zod 4, AI SDK v7, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-11-lekir-public-apply-form-design.md`

## Global Constraints

- pnpm only. TypeScript, 2-space indent, single quotes, semicolons, named exports, `const` by default.
- No reference-product names in `src/`. No purple or violet anywhere (never `var(--chart-5)`).
- A visitor can do exactly one thing: submit an application to an open job of a workspace whose board is on. `anon` gets execute on `submit_public_application` and no table privilege. The function takes values and ids only, builds no dynamic SQL, and returns only a word.
- A refused submission writes nothing. A repeat application answers `ok` and writes nothing new: the form never reveals whether an email has applied before.
- An existing candidate is matched by lowercased email within the workspace and is never overwritten: only a null `phone` may be filled.
- Consent is required and its time is stored. It is never pre-ticked.
- Links are stored as text, must start `http://` or `https://`, are rendered with `rel="noopener noreferrer"`, and are never fetched by the server. Cover letters are rendered as plain text. Never `dangerouslySetInnerHTML`.
- Applicant details are personal data: never logged (no `console.log` of form values, no values in error logs), and returned to the model only when contact details were asked for.
- Any failure on the public page is a plain message; no database error, id or detail reaches a visitor.
- The demo workspace (`slug = 'rimba-ventures-demo'`) takes no applications.
- This shell has live database credentials. Never run a `*.rls.test.ts` file, and do not run the whole suite (`pnpm vitest run --dir tests`). Do not apply migrations, push, or run anything under `evals/`: those are the controller's (Task 6).

## Review Focus

1. Someone submits a known candidate's email with a different name and phone: the candidate's name must not change, a stored phone must not change, and the response must be the same thank-you. Tasks 1 and 5.
2. The same person applies twice to the same job (double tap, or back and resubmit): one application, the same thank-you both times. Tasks 1, 3 and 5.
3. A direct call to the function that skips the page: missing consent, a `javascript:` link, a required CV left out, an over-long cover letter, a job of another workspace, a board that is off. Each is refused with nothing written. Tasks 1 and 5.
4. A visitor on a phone with an error in the form: what they typed is kept, the error is under its field in words, and focus goes to the first problem. Task 3.
5. A CV or portfolio link shown inside the app: clicking it must not hand the opened page a reference back to the app, and a stored value that is somehow not `http(s)` must not become a link. Task 4.

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/20261018100000_hire_public_applications.sql` | New columns, the unique index, `submit_public_application`, `get_public_job` with the form's requirements |
| `src/lib/hire/application-fields.ts` | Pure: the apply form's fields, limits, messages and per-field checks. No imports. |
| `src/lib/hire/public-applications.ts` | The Zod schema, RM to sen, calling the function, mapping its word to a message |
| `src/lib/hire/public-careers.ts` | `PublicJob` gains `form` (the four requirements) |
| `src/app/careers/[orgId]/[jobId]/actions.ts`, `apply-form.tsx`, `page.tsx` | The server action, the form, the page wiring |
| `src/lib/hire/types.ts`, `seed.ts`, `supabase.ts`, `lists.ts` | `Application` gains the five fields; the Applications model carries details |
| `src/screens/hire/application-details.tsx`, `applications.tsx` | The Details control inside the app |
| `src/lib/ai/hire-tools.ts`, `src/lib/ai/agents/prompts.ts` | `listApplications` returns the new fields only when contact details were asked for |
| `tests/hire-public-applications.rls.test.ts` | Live checks (written, not run by implementers) |

---

### Task 1: Migration

**Files:**
- Create: `supabase/migrations/20261018100000_hire_public_applications.sql`
- Test: `tests/hire-public-applications-migration.test.ts`

**Interfaces:**
- Produces: columns `cover_letter`, `cv_url`, `portfolio_url`, `expected_salary_cents`, `consented_at` on `hire_applications`; unique index `hire_candidates_org_email_key`; `public.submit_public_application(p_org_id, p_job_id, p_name, p_email, p_phone, p_cover_letter, p_cv_url, p_portfolio_url, p_expected_salary_cents, p_consent, p_honeypot) returns text`; `public.get_public_job` returning its fourteen columns plus `require_cv, require_cover_letter, ask_portfolio, ask_expected_salary`.
- The words the function can return: `ok`, `name_too_long`, `email_too_long`, `phone_too_long`, `cover_letter_too_long`, `url_too_long`, `invalid_name`, `invalid_email`, `invalid_url`, `invalid_salary`, `not_found`, `closed`, `consent_required`, `cv_required`, `cover_letter_required`, `throttled`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/hire-public-applications-migration.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations', '20261018100000_hire_public_applications.sql'), 'utf8',
);
const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$$;', start));
};
const WORDS = [
  'ok', 'name_too_long', 'email_too_long', 'phone_too_long', 'cover_letter_too_long', 'url_too_long',
  'invalid_name', 'invalid_email', 'invalid_url', 'invalid_salary', 'not_found', 'closed',
  'consent_required', 'cv_required', 'cover_letter_required', 'throttled',
];

describe('hire public applications migration', () => {
  test('adds the five application fields with their checks', () => {
    expect(sql).toContain('alter table public.hire_applications');
    expect(sql).toContain('add column cover_letter text check (char_length(cover_letter) <= 4000)');
    expect(sql).toContain("add column cv_url text check (char_length(cv_url) <= 500 and cv_url ~ '^https?://')");
    expect(sql).toContain("add column portfolio_url text check (char_length(portfolio_url) <= 500 and portfolio_url ~ '^https?://')");
    expect(sql).toContain('add column expected_salary_cents bigint check (expected_salary_cents >= 0)');
    expect(sql).toContain('add column consented_at timestamptz');
  });

  test('makes a candidate email unique within a workspace, whatever its letter case', () => {
    expect(sql).toContain(
      'create unique index hire_candidates_org_email_key on public.hire_candidates (org_id, lower(email)) where email is not null',
    );
  });

  test('gives visitors no table privilege, and execute on exactly two functions', () => {
    expect(sql).not.toMatch(/grant\s+(select|insert|update|delete|all)[^;]*to[^;]*\banon\b/i);
    const grants = sql.match(/grant execute on function public\.\w+\([^)]*\) to anon, authenticated;/g) ?? [];
    expect(grants).toHaveLength(2);
    expect(sql).toContain('revoke execute on function public.submit_public_application(uuid, uuid, text, text, text, text, text, text, bigint, boolean, text) from public, anon, authenticated');
    expect(sql).toContain('revoke execute on function public.get_public_job(uuid, uuid) from public, anon, authenticated');
  });

  test('the submit function is a locked-down definer function that only ever returns a word', () => {
    const body = fn('submit_public_application');
    expect(body).toContain("returns text");
    expect(body).toContain("language plpgsql security definer set search_path = ''");
    expect(body).not.toMatch(/\bexecute\s+(format|')/i);
    const returned = [...body.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]);
    expect([...new Set(returned)].sort()).toEqual([...WORDS].sort());
  });

  test('checks in the order the spec gives: honeypot, lengths, shapes, job, consent, requirements, throttle', () => {
    const body = fn('submit_public_application');
    const order = [
      'p_honeypot', "'name_too_long'", "'invalid_name'", "'not_found'", "'closed'",
      "'consent_required'", "'cv_required'", "'throttled'", 'insert into public.hire_candidates',
      'insert into public.hire_applications',
    ].map((needle) => body.indexOf(needle));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('refuses the demo workspace, a board that is off, a job that is not open or is past its closing date', () => {
    const body = fn('submit_public_application');
    expect(body).toContain("'rimba-ventures-demo'");
    expect(body).toContain('careers_enabled');
    expect(body).toContain("v_status <> 'open'");
    expect(body).toContain("(now() at time zone 'Asia/Kuala_Lumpur')::date");
  });

  test('never overwrites an existing candidate: only a missing phone is filled', () => {
    const body = fn('submit_public_application');
    const updates = [...body.matchAll(/update public\.hire_candidates[\s\S]*?;/g)].map((m) => m[0]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/set phone = v_phone/);
    expect(updates[0]).toContain('phone is null');
    expect(updates[0]).not.toMatch(/\bname\s*=/);
  });

  test('a repeat application is not an error, and a failed notification does not fail the application', () => {
    const body = fn('submit_public_application');
    expect(body).toContain('on conflict (candidate_id, job_id) do nothing');
    expect(body).toContain('private.deliver_notification');
    expect(body).toMatch(/exception\s+when others then/);
  });

  test('the public job function now also says what the form asks for, and still hides what it hid', () => {
    const body = fn('get_public_job');
    const returns = body.slice(body.indexOf('returns table'), body.indexOf('language sql'));
    for (const column of ['require_cv', 'require_cover_letter', 'ask_portfolio', 'ask_expected_salary']) {
      expect(returns, column).toContain(`${column} boolean`);
    }
    for (const hidden of ['headcount', 'status', 'created_at', 'closed_at', 'show_salary']) {
      expect(returns, hidden).not.toContain(hidden);
    }
    expect(body).toContain("language sql security definer stable set search_path = ''");
    expect(sql).toContain('drop function public.get_public_job(uuid, uuid);');
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm vitest run tests/hire-public-applications-migration.test.ts`
Expected: FAIL, the migration file does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20261018100000_hire_public_applications.sql
-- Lekir slice 2d: a visitor can apply to an open job. One function is the only
-- thing a stranger can write through; no table is opened to them.

alter table public.hire_applications
  add column cover_letter text check (char_length(cover_letter) <= 4000),
  add column cv_url text check (char_length(cv_url) <= 500 and cv_url ~ '^https?://'),
  add column portfolio_url text check (char_length(portfolio_url) <= 500 and portfolio_url ~ '^https?://'),
  add column expected_salary_cents bigint check (expected_salary_cents >= 0),
  add column consented_at timestamptz;

-- Matching an applicant to a candidate by email must find at most one.
create unique index hire_candidates_org_email_key on public.hire_candidates (org_id, lower(email)) where email is not null;

-- ---------------------------------------------------------------------------
-- Takes one application from a visitor. Answers with a word, never an id:
-- 'ok', or which rule stopped it. A refused submission writes nothing. An
-- application that already exists is answered 'ok' too, so the form does not
-- reveal whether an email has applied before.
-- ---------------------------------------------------------------------------
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
  p_honeypot text default null
)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_phone text := btrim(coalesce(p_phone, ''));
  v_cover text := btrim(coalesce(p_cover_letter, ''));
  v_cv text := btrim(coalesce(p_cv_url, ''));
  v_portfolio text := btrim(coalesce(p_portfolio_url, ''));
  v_salary bigint := p_expected_salary_cents;
  v_job_id uuid;
  v_title text;
  v_status text;
  v_described boolean;
  v_closes date;
  v_slug text;
  v_enabled boolean;
  v_require_cv boolean;
  v_require_cover boolean;
  v_ask_portfolio boolean;
  v_ask_salary boolean;
  v_candidate_id uuid;
  v_application_id uuid;
  r record;
begin
  -- A field no person can see was filled in: say thanks and keep nothing.
  if btrim(coalesce(p_honeypot, '')) <> '' then
    return 'ok';
  end if;

  -- Lengths first, so nothing below works on an over-long value.
  if char_length(v_name) > 120 then return 'name_too_long'; end if;
  if char_length(v_email) > 254 then return 'email_too_long'; end if;
  if char_length(v_phone) > 40 then return 'phone_too_long'; end if;
  if char_length(v_cover) > 4000 then return 'cover_letter_too_long'; end if;
  if char_length(v_cv) > 500 or char_length(v_portfolio) > 500 then return 'url_too_long'; end if;

  -- One line of text: runs of spaces, tabs and line breaks become one space.
  v_name := btrim(regexp_replace(v_name, '\s+', ' ', 'g'));
  v_phone := btrim(regexp_replace(v_phone, '\s+', ' ', 'g'));
  if v_name = '' then return 'invalid_name'; end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then return 'invalid_email'; end if;
  -- A web address and nothing else: no spaces, and never another scheme.
  if v_cv <> '' and v_cv !~ '^https?://[^\s]+$' then return 'invalid_url'; end if;
  if v_portfolio <> '' and v_portfolio !~ '^https?://[^\s]+$' then return 'invalid_url'; end if;
  if v_salary is not null and (v_salary < 0 or v_salary > 100000000) then return 'invalid_salary'; end if;

  -- Locking the job's row makes applications to one job take turns, so the
  -- throttle below cannot be raced.
  select j.id, j.title, j.status, j.description ~ '\S', j.closes_on, o.slug,
         coalesce(s.careers_enabled, false), coalesce(s.require_cv, false),
         coalesce(s.require_cover_letter, false), coalesce(s.ask_portfolio, false),
         coalesce(s.ask_expected_salary, false)
    into v_job_id, v_title, v_status, v_described, v_closes, v_slug,
         v_enabled, v_require_cv, v_require_cover, v_ask_portfolio, v_ask_salary
    from public.hire_jobs j
    join public.orgs o on o.id = j.org_id
    left join public.hire_settings s on s.org_id = j.org_id
   where j.id = p_job_id and j.org_id = p_org_id
     for update of j;
  if v_job_id is null then return 'not_found'; end if;
  -- The same rule as the public job page: what a visitor cannot see, they cannot apply to.
  if not v_enabled
     or v_slug is not distinct from 'rimba-ventures-demo'
     or v_status <> 'open'
     or v_described is not true
     or (v_closes is not null and v_closes < (now() at time zone 'Asia/Kuala_Lumpur')::date) then
    return 'closed';
  end if;

  if p_consent is not true then return 'consent_required'; end if;

  if v_require_cv and v_cv = '' then return 'cv_required'; end if;
  if v_require_cover and v_cover = '' then return 'cover_letter_required'; end if;
  -- Not asked for by this workspace: not kept.
  if not v_ask_portfolio then v_portfolio := ''; end if;
  if not v_ask_salary then v_salary := null; end if;

  if (select count(*) from public.hire_applications a
       where a.job_id = v_job_id and a.applied_at > now() - interval '1 minute') >= 30 then
    return 'throttled';
  end if;

  -- Two jobs of one workspace receiving the same new email at the same moment
  -- must not race to make the candidate.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || v_email, 0));

  select c.id into v_candidate_id
    from public.hire_candidates c
   where c.org_id = p_org_id and lower(c.email) = v_email;

  if v_candidate_id is null then
    insert into public.hire_candidates (org_id, name, email, phone, source, pool_status)
    values (p_org_id, v_name, v_email, nullif(v_phone, ''), 'Careers page', 'none')
    returning id into v_candidate_id;
  elsif v_phone <> '' then
    -- A known candidate is left as they are: a visitor must not be able to
    -- rewrite a record by typing someone else's email. Only a missing phone is filled.
    update public.hire_candidates
       set phone = v_phone
     where id = v_candidate_id and phone is null;
  end if;

  insert into public.hire_applications
    (org_id, candidate_id, job_id, stage, outcome, source,
     cover_letter, cv_url, portfolio_url, expected_salary_cents, consented_at)
  values
    (p_org_id, v_candidate_id, v_job_id, 'applied', 'active', 'Careers page',
     nullif(v_cover, ''), nullif(v_cv, ''), nullif(v_portfolio, ''), v_salary, now())
  on conflict (candidate_id, job_id) do nothing
  returning id into v_application_id;

  -- Only a new application is announced. Telling the workspace must never be
  -- the reason an application is lost.
  if v_application_id is not null then
    begin
      for r in select m.user_id from public.org_members m where m.org_id = p_org_id loop
        perform private.deliver_notification(
          r.user_id, p_org_id, 'hiring', 'New application',
          v_name || ' applied for ' || v_title, '/hire/applications');
      end loop;
    exception when others then
      null;
    end;
  end if;

  return 'ok';
end $$;

-- ---------------------------------------------------------------------------
-- The public job, now with what its apply form asks for. The return type
-- changes, so the function is dropped and made again in this one transaction.
-- ---------------------------------------------------------------------------
drop function public.get_public_job(uuid, uuid);

create or replace function public.get_public_job(p_org_id uuid, p_job_id uuid)
returns table (
  org_name text, headline text, tagline text,
  job_id uuid, title text, department text, location text,
  work_arrangement text, employment_type text, closes_on date, accepting boolean,
  description text, salary_min_cents bigint, salary_max_cents bigint,
  require_cv boolean, require_cover_letter boolean, ask_portfolio boolean, ask_expected_salary boolean
)
language sql security definer stable set search_path = '' as $$
  select
    o.name, s.careers_headline, s.careers_tagline,
    j.id, j.title, j.department, j.location,
    j.work_arrangement, j.employment_type, j.closes_on,
    j.closes_on is null or j.closes_on >= (now() at time zone 'Asia/Kuala_Lumpur')::date,
    j.description,
    case when j.show_salary then j.salary_min_cents end,
    case when j.show_salary then j.salary_max_cents end,
    s.require_cv, s.require_cover_letter, s.ask_portfolio, s.ask_expected_salary
  from public.orgs o
  join public.hire_settings s on s.org_id = o.id and s.careers_enabled
  join public.hire_jobs j
    on j.org_id = o.id and j.status = 'open' and j.description ~ '\S'
  where o.id = p_org_id
    and j.id = p_job_id
    and o.slug is distinct from 'rimba-ventures-demo';
$$;

-- New functions are executable by everyone until told otherwise.
revoke execute on function public.submit_public_application(uuid, uuid, text, text, text, text, text, text, bigint, boolean, text) from public, anon, authenticated;
revoke execute on function public.get_public_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.submit_public_application(uuid, uuid, text, text, text, text, text, text, bigint, boolean, text) to anon, authenticated;
grant execute on function public.get_public_job(uuid, uuid) to anon, authenticated;
```

- [ ] **Step 4: Run the test and see it pass**

Run: `pnpm vitest run tests/hire-public-applications-migration.test.ts tests/hire-settings-migration.test.ts`
Expected: PASS. If a test's text match fails on whitespace or wording, the test is the intent: change the SQL's layout to match, never its behaviour, and report what you changed.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261018100000_hire_public_applications.sql tests/hire-public-applications-migration.test.ts
git commit -m "feat(hire): submit_public_application and the application fields"
```

---

### Task 2: The fields module, the submit seam, and the job's form requirements

**Files:**
- Create: `src/lib/hire/application-fields.ts`, `src/lib/hire/public-applications.ts`
- Modify: `src/lib/hire/public-careers.ts`
- Test: `tests/hire-application-fields.test.ts`, `tests/hire-public-applications.test.ts`, `tests/hire-public-careers.test.ts`

**Interfaces:**
- Consumes: `ApplicationFormValues` from `@/lib/hire/application-form` (the four switches), the function's words (Task 1).
- Produces, from `application-fields.ts` (no imports except the type above):
  - `APPLY_FIELDS = ['name', 'email', 'phone', 'cv_url', 'cover_letter', 'portfolio_url', 'expected_salary', 'consent'] as const`, `type ApplyField`, `type ApplyValues = Record<Exclude<ApplyField, 'consent'>, string> & { consent: boolean }`, `EMPTY_APPLY_VALUES`.
  - `APPLY_LIMITS = { name: 120, email: 254, phone: 40, cover_letter: 4000, url: 500, salaryRinggit: 1_000_000 }`.
  - `APPLY_HONEYPOT = 'company_website'`.
  - `APPLY_MESSAGES` (below), `type ApplyErrors = Partial<Record<ApplyField, string>>`.
  - `shownFields(form: ApplicationFormValues): ApplyField[]`, `isRequired(field, form): boolean`.
  - `fieldProblem(field: ApplyField, values: ApplyValues, form: ApplicationFormValues): string | null`, `applyProblems(values, form): ApplyErrors`.
  - `ringgitToSen(text: string): number | null | 'invalid'` (blank is null).
  - `firstName(name: string): string`.
- Produces, from `public-applications.ts`:
  - `applicationInput(form)`: a Zod schema over `ApplyValues` whose issues are exactly `applyProblems`.
  - `type ApplyOutcome = { kind: 'ok' } | { kind: 'closed' } | { kind: 'throttled' } | { kind: 'invalid'; errors: ApplyErrors } | { kind: 'failed' }`.
  - `applyOutcome(word: unknown): ApplyOutcome`.
  - `submitPublicApplication(client, orgId, jobId, values, form, honeypot?): Promise<ApplyOutcome>`.
- Produces, in `public-careers.ts`: `PublicJob` gains `form: ApplicationFormValues`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/hire-application-fields.test.ts
import { describe, expect, it } from 'vitest';
import {
  APPLY_FIELDS, APPLY_LIMITS, APPLY_MESSAGES, EMPTY_APPLY_VALUES, applyProblems, fieldProblem,
  firstName, isRequired, ringgitToSen, shownFields,
} from '@/lib/hire/application-fields';

const OFF = { require_cv: false, require_cover_letter: false, ask_portfolio: false, ask_expected_salary: false };
const ALL = { require_cv: true, require_cover_letter: true, ask_portfolio: true, ask_expected_salary: true };
const good = { ...EMPTY_APPLY_VALUES, name: 'Aina Rahman', email: 'aina@example.com', consent: true };

describe('which fields a form shows', () => {
  it('asks for name, email, phone and consent when every switch is off', () => {
    expect(shownFields(OFF)).toEqual(['name', 'email', 'phone', 'consent']);
  });
  it('adds each field its switch turns on, in the fixed order', () => {
    expect(shownFields(ALL)).toEqual([...APPLY_FIELDS]);
    expect(shownFields({ ...OFF, ask_portfolio: true })).toEqual(['name', 'email', 'phone', 'portfolio_url', 'consent']);
  });
  it('requires name, email and consent always, a CV and cover letter only when switched on, the rest never', () => {
    for (const field of ['name', 'email', 'consent'] as const) expect(isRequired(field, OFF)).toBe(true);
    expect(isRequired('cv_url', OFF)).toBe(false);
    expect(isRequired('cv_url', ALL)).toBe(true);
    expect(isRequired('cover_letter', ALL)).toBe(true);
    for (const field of ['phone', 'portfolio_url', 'expected_salary'] as const) expect(isRequired(field, ALL)).toBe(false);
  });
});

describe('checking what was typed', () => {
  it('accepts the least a form can ask for', () => {
    expect(applyProblems(good, OFF)).toEqual({});
  });
  it('says what is wrong with each field, in words that say how to fix it', () => {
    expect(applyProblems({ ...EMPTY_APPLY_VALUES }, OFF)).toEqual({
      name: APPLY_MESSAGES.name, email: APPLY_MESSAGES.email, consent: APPLY_MESSAGES.consent,
    });
    expect(fieldProblem('email', { ...good, email: 'aina@' }, OFF)).toBe(APPLY_MESSAGES.emailInvalid);
    expect(fieldProblem('name', { ...good, name: 'x'.repeat(121) }, OFF)).toBe(APPLY_MESSAGES.nameTooLong);
    expect(fieldProblem('phone', { ...good, phone: '1'.repeat(41) }, OFF)).toBe(APPLY_MESSAGES.phoneTooLong);
  });
  it('requires a CV link and a cover letter only when the workspace does', () => {
    expect(applyProblems(good, ALL)).toEqual({ cv_url: APPLY_MESSAGES.cvRequired, cover_letter: APPLY_MESSAGES.coverLetterRequired });
    expect(applyProblems({ ...good, cv_url: 'https://example.com/cv', cover_letter: 'Hello.' }, ALL)).toEqual({});
  });
  it('takes only http and https links, and nothing with a space', () => {
    for (const bad of ['example.com/cv', 'javascript:alert(1)', 'ftp://x.y/z', 'https://exa mple.com']) {
      expect(fieldProblem('cv_url', { ...good, cv_url: bad }, ALL), bad).toBe(APPLY_MESSAGES.urlInvalid);
      expect(fieldProblem('portfolio_url', { ...good, portfolio_url: bad }, ALL), bad).toBe(APPLY_MESSAGES.urlInvalid);
    }
    expect(fieldProblem('cv_url', { ...good, cv_url: 'https://x.y/' + 'a'.repeat(500) }, ALL)).toBe(APPLY_MESSAGES.urlTooLong);
    expect(fieldProblem('portfolio_url', { ...good, portfolio_url: 'http://example.com/work' }, ALL)).toBeNull();
  });
  it('counts a cover letter the way the database does and stops at 4,000', () => {
    expect(fieldProblem('cover_letter', { ...good, cover_letter: 'é'.repeat(APPLY_LIMITS.cover_letter) }, ALL)).toBeNull();
    expect(fieldProblem('cover_letter', { ...good, cover_letter: 'é'.repeat(APPLY_LIMITS.cover_letter + 1) }, ALL)).toBe(APPLY_MESSAGES.coverLetterTooLong);
  });
  it('ignores a field the form does not show', () => {
    expect(applyProblems({ ...good, portfolio_url: 'nonsense', expected_salary: 'lots' }, OFF)).toEqual({});
  });
});

describe('expected salary', () => {
  it('reads ringgit as typed and gives sen', () => {
    expect(ringgitToSen('3500')).toBe(350000);
    expect(ringgitToSen(' RM 3,500.50 ')).toBe(350050);
    expect(ringgitToSen('')).toBeNull();
    expect(ringgitToSen('   ')).toBeNull();
  });
  it('refuses what is not an amount, a negative, or an absurd one', () => {
    for (const bad of ['lots', '-5', '3.5.0', '1e9', '3,5', '12.345']) expect(ringgitToSen(bad), bad).toBe('invalid');
    expect(ringgitToSen(String(APPLY_LIMITS.salaryRinggit))).toBe(APPLY_LIMITS.salaryRinggit * 100);
    expect(ringgitToSen(String(APPLY_LIMITS.salaryRinggit + 1))).toBe('invalid');
    expect(fieldProblem('expected_salary', { ...good, expected_salary: 'lots' }, ALL)).toBe(APPLY_MESSAGES.salaryInvalid);
  });
});

describe('the name on the thank-you', () => {
  it('is the first word of the name, and never empty', () => {
    expect(firstName('  Aina   Rahman ')).toBe('Aina');
    expect(firstName('')).toBe('');
  });
});
```

`tests/hire-public-applications.test.ts`:
- `applicationInput(form).safeParse(values)` succeeds exactly when `applyProblems(values, form)` is empty, and on failure its issues carry the same messages on the same field paths (check three cases: all good, two fields wrong, a field wrong that the form does not show).
- `applyOutcome`: `'ok'` → `{ kind: 'ok' }`; `'closed'` and `'not_found'` → `{ kind: 'closed' }` (a visitor is not told which); `'throttled'` → throttled; each field word maps to `{ kind: 'invalid', errors: { <field>: <message> } }` with these pairs: `name_too_long`→name/nameTooLong, `invalid_name`→name/name, `email_too_long`→email/emailTooLong, `invalid_email`→email/emailInvalid, `phone_too_long`→phone/phoneTooLong, `cover_letter_too_long`→cover_letter/coverLetterTooLong, `cover_letter_required`→cover_letter/coverLetterRequired, `cv_required`→cv_url/cvRequired, `consent_required`→consent/consent, `invalid_salary`→expected_salary/salaryInvalid; `url_too_long` and `invalid_url` name no single field in the function's answer, so they map to `{ kind: 'failed' }` (the page checks both links before sending, so a visitor reaches these only by skipping the page); anything else (`null`, `undefined`, `42`, `'surprise'`) → `{ kind: 'failed' }`.
- `submitPublicApplication` with a fake client whose `rpc` is a `vi.fn()`:
  - sends `submit_public_application` with exactly these argument names and values for a full form: `p_org_id, p_job_id, p_name, p_email, p_phone, p_cover_letter, p_cv_url, p_portfolio_url, p_expected_salary_cents (sen, from RM typed), p_consent, p_honeypot`; blank optional fields go as `null`; the email is sent as typed apart from trimming (the database lowercases it);
  - a field the form does not show is sent as `null` even if a value was posted;
  - values that fail `applyProblems` never reach `rpc` and come back as `{ kind: 'invalid', errors }`;
  - a non-UUID org or job id never reaches `rpc` and is `{ kind: 'closed' }`;
  - an `rpc` error, and an `rpc` that throws, are `{ kind: 'failed' }`, and what is logged contains no form value (spy on `console.error`; assert no logged argument, stringified, contains the applicant's name or email).

`tests/hire-public-careers.test.ts`: `getPublicJob` maps the four requirement columns into `form` (a row with `require_cv: true` gives `form.require_cv === true`), and a row without them (the function before this migration) gives all four `false`.

- [ ] **Step 2: Run and see them fail**

Run: `pnpm vitest run tests/hire-application-fields.test.ts tests/hire-public-applications.test.ts tests/hire-public-careers.test.ts`
Expected: FAIL (modules not found; `form` missing).

- [ ] **Step 3: Implement**

`src/lib/hire/application-fields.ts`:

```ts
// src/lib/hire/application-fields.ts
/**
 * The public apply form's fields, limits, messages and checks. Pure, with no
 * imports of code: the form in the browser, the server action and the tests
 * all use this one set of rules. The database function checks the same things
 * again, because anyone can call it without the page.
 */
import type { ApplicationFormValues } from './application-form';

/** In the order the form shows them, which is the order problems are reported in. */
export const APPLY_FIELDS = [
  'name', 'email', 'phone', 'cv_url', 'cover_letter', 'portfolio_url', 'expected_salary', 'consent',
] as const;
export type ApplyField = (typeof APPLY_FIELDS)[number];
/** What the form holds, as typed. */
export type ApplyValues = Record<Exclude<ApplyField, 'consent'>, string> & { consent: boolean };
export type ApplyErrors = Partial<Record<ApplyField, string>>;

export const EMPTY_APPLY_VALUES: ApplyValues = {
  name: '', email: '', phone: '', cv_url: '', cover_letter: '', portfolio_url: '', expected_salary: '', consent: false,
};

export const APPLY_LIMITS = {
  name: 120, email: 254, phone: 40, cover_letter: 4000, url: 500, salaryRinggit: 1_000_000,
} as const;

/**
 * A field people never see. A filled one means a script wrote the application,
 * which is then thanked and thrown away. The name is one a script fills and no
 * browser keeps an autofill value for.
 */
export const APPLY_HONEYPOT = 'company_website';

export const APPLY_MESSAGES = {
  name: 'Enter your full name.',
  nameTooLong: `Keep your name to ${APPLY_LIMITS.name} characters or fewer.`,
  email: 'Enter your email address.',
  emailInvalid: 'Enter an email address like name@example.com.',
  emailTooLong: `Keep the email address to ${APPLY_LIMITS.email} characters or fewer.`,
  phoneTooLong: `Keep the phone number to ${APPLY_LIMITS.phone} characters or fewer.`,
  cvRequired: 'Add a link to your CV.',
  coverLetterRequired: 'Write a short cover letter.',
  coverLetterTooLong: 'Keep the cover letter to 4,000 characters or fewer.',
  urlInvalid: 'Enter a link that starts with https://',
  urlTooLong: `Keep the link to ${APPLY_LIMITS.url} characters or fewer.`,
  salaryInvalid: 'Enter the amount in ringgit, for example 3500.',
  consent: 'Tick the box to agree before sending.',
  closed: 'This role is no longer taking applications.',
  throttled: 'Lots of people are applying right now. Please try again in a minute.',
  failed: "Something went wrong on our side. Your application wasn't sent. Please try again.",
} as const;

/** The fields this workspace's form shows. A CV link and a cover letter appear only when required. */
export function shownFields(form: ApplicationFormValues): ApplyField[] {
  const shown: Record<ApplyField, boolean> = {
    name: true, email: true, phone: true,
    cv_url: form.require_cv,
    cover_letter: form.require_cover_letter,
    portfolio_url: form.ask_portfolio,
    expected_salary: form.ask_expected_salary,
    consent: true,
  };
  return APPLY_FIELDS.filter((field) => shown[field]);
}

export function isRequired(field: ApplyField, form: ApplicationFormValues): boolean {
  if (field === 'name' || field === 'email' || field === 'consent') return true;
  if (field === 'cv_url') return form.require_cv;
  if (field === 'cover_letter') return form.require_cover_letter;
  return false;
}

/** Counted the way the database counts: one per character, not per UTF-16 unit. */
const length = (value: string) => [...value].length;
const oneLine = (value: string) => value.trim().replace(/\s+/g, ' ');
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_SHAPE = /^https?:\/\/\S+$/;

/** Ringgit as typed ("3500", "RM 3,500.50") to sen. Blank is null. */
export function ringgitToSen(text: string): number | null | 'invalid' {
  const typed = text.trim().replace(/^RM\s*/i, '');
  if (typed === '') return null;
  // Whole ringgit with optional thousands commas, and at most two decimals.
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(typed)) return 'invalid';
  const ringgit = Number(typed.replace(/,/g, ''));
  if (!Number.isFinite(ringgit) || ringgit > APPLY_LIMITS.salaryRinggit) return 'invalid';
  return Math.round(ringgit * 100);
}

function linkProblem(value: string, required: boolean, missing: string): string | null {
  const link = value.trim();
  if (link === '') return required ? missing : null;
  if (length(link) > APPLY_LIMITS.url) return APPLY_MESSAGES.urlTooLong;
  return URL_SHAPE.test(link) ? null : APPLY_MESSAGES.urlInvalid;
}

/** What is wrong with one field, or null. A field the form does not show is never wrong. */
export function fieldProblem(field: ApplyField, values: ApplyValues, form: ApplicationFormValues): string | null {
  if (!shownFields(form).includes(field)) return null;
  switch (field) {
    case 'name': {
      const name = oneLine(values.name);
      if (name === '') return APPLY_MESSAGES.name;
      return length(name) > APPLY_LIMITS.name ? APPLY_MESSAGES.nameTooLong : null;
    }
    case 'email': {
      const email = values.email.trim();
      if (email === '') return APPLY_MESSAGES.email;
      if (length(email) > APPLY_LIMITS.email) return APPLY_MESSAGES.emailTooLong;
      return EMAIL_SHAPE.test(email) ? null : APPLY_MESSAGES.emailInvalid;
    }
    case 'phone':
      return length(oneLine(values.phone)) > APPLY_LIMITS.phone ? APPLY_MESSAGES.phoneTooLong : null;
    case 'cv_url':
      return linkProblem(values.cv_url, form.require_cv, APPLY_MESSAGES.cvRequired);
    case 'cover_letter': {
      const letter = values.cover_letter.trim();
      if (letter === '') return form.require_cover_letter ? APPLY_MESSAGES.coverLetterRequired : null;
      return length(letter) > APPLY_LIMITS.cover_letter ? APPLY_MESSAGES.coverLetterTooLong : null;
    }
    case 'portfolio_url':
      return linkProblem(values.portfolio_url, false, '');
    case 'expected_salary':
      return ringgitToSen(values.expected_salary) === 'invalid' ? APPLY_MESSAGES.salaryInvalid : null;
    case 'consent':
      return values.consent ? null : APPLY_MESSAGES.consent;
  }
}

/** Every field with a problem, each with its own message. */
export function applyProblems(values: ApplyValues, form: ApplicationFormValues): ApplyErrors {
  const errors: ApplyErrors = {};
  for (const field of APPLY_FIELDS) {
    const problem = fieldProblem(field, values, form);
    if (problem) errors[field] = problem;
  }
  return errors;
}

/** The first word of a name, for the thank-you. */
export function firstName(name: string): string {
  return oneLine(name).split(' ')[0] ?? '';
}
```

`src/lib/hire/public-applications.ts`: write to the Interfaces block and the test cases above. Requirements: `applicationInput(form)` is `z.object({...strings, consent: z.boolean()}).superRefine(...)` adding one issue per entry of `applyProblems`, with `path: [field]`; `submitPublicApplication` checks UUIDs with `z.uuid()` before anything, parses with the schema, builds the arguments (trimmed; blank and not-shown as `null`; salary through `ringgitToSen`), wraps the `rpc` call in try/catch, and on an error logs only the function name and the error's `code` and `message` (never the arguments). It takes the client as a parameter and imports no server-only module, so the action can pass `createAnonymousClient()`.

`src/lib/hire/public-careers.ts`: `PublicJob` gains `form: ApplicationFormValues`; the row type gains the four optional booleans; `getPublicJob` sets `form` with `row.<name> === true` for each.

- [ ] **Step 4: Run and see them pass**

Run the Step 2 command plus `tests/hire-careers-pages.test.tsx` (its `PublicJob` fakes need `form`; add all-false and change nothing else), then `pnpm exec tsc --noEmit`.
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/hire/application-fields.ts src/lib/hire/public-applications.ts src/lib/hire/public-careers.ts tests/hire-application-fields.test.ts tests/hire-public-applications.test.ts tests/hire-public-careers.test.ts tests/hire-careers-pages.test.tsx
git commit -m "feat(hire): the apply form's rules and the seam to submit_public_application"
```

---

### Task 3: The server action, the form and the page

**Files:**
- Create: `src/app/careers/[orgId]/[jobId]/actions.ts`, `src/app/careers/[orgId]/[jobId]/apply-form.tsx` (client)
- Modify: `src/app/careers/[orgId]/[jobId]/page.tsx`
- Test: `tests/hire-apply-action.test.ts`, `tests/hire-apply-form.test.tsx`, `tests/hire-careers-pages.test.tsx`

**Interfaces:**
- Consumes: everything from Task 2; `getPublicJob`, `createAnonymousClient`, `hasSupabaseEnv`.
- Produces: `type ApplyState = { done?: { firstName: string }; closed?: true; error?: string; errors?: ApplyErrors; values?: ApplyValues } | undefined`; `applyAction(orgId: string, jobId: string, prev: ApplyState, formData: FormData): Promise<ApplyState>`; `ApplyForm({ action, form, orgName })`.

Before writing, read: `src/app/f/[formId]/actions.ts` and `src/components/reach/public-lead-form.tsx` (the house pattern for a public form: `useActionState`, values kept after a rejection, the outcome panel that takes focus, the hidden honeypot, `noValidate`), the current `src/app/careers/[orgId]/[jobId]/page.tsx`, and the forms, server actions and `useActionState` guides under `node_modules/next/dist/docs/`.

**The action — rules:**

1. `'use server'`; exports only async functions (types may be exported).
2. Reads each field with a `read(formData, key)` helper that takes strings only and cuts them at 5,000 characters before any check; `consent` is true only for the value a ticked checkbox posts.
3. A filled honeypot (`APPLY_HONEYPOT`) returns `{ done: { firstName: firstName(values.name) } }` without touching the database.
4. Not a UUID for either id, or no database configured → `{ closed: true }`.
5. The form's requirements are NOT taken from the posted form: the action reads the job again with `getPublicJob(createAnonymousClient(), orgId, jobId)`. Null → `{ closed: true }`. `accepting === false` → `{ closed: true }`.
6. `applyProblems(values, job.form)` non-empty → `{ errors, values }`, nothing sent.
7. `submitPublicApplication(...)`: `ok` → `{ done: { firstName } }`; `closed` → `{ closed: true }`; `throttled` → `{ error: APPLY_MESSAGES.throttled, values }`; `invalid` → `{ errors, values }`; `failed` → `{ error: APPLY_MESSAGES.failed, values }`.
8. Never logs a form value. Never returns an id, an error object or anything from the database except through the mapping above.
9. No redirect and no `revalidatePath` (the app's screens read per request).

**The form — rules (each is a requirement; applicants are strangers, most on a phone):**

10. A client component using `useActionState(action, undefined)`; a plain `<form action={formAction} noValidate>` so it posts and shows the server's answer without JavaScript.
11. It renders exactly `shownFields(form)`, in that order, plus the honeypot. Labels: "Full name", "Email", "Phone", "CV link", "Cover letter", "Portfolio link", "Expected monthly salary", and the consent sentence. Required fields (`isRequired`) carry a visible asterisk with `aria-hidden` and the input carries `required` and `aria-required="true"`; one line above the first field says "* Required". Optional fields say "(optional)" in the label.
12. One column. Every input and the button at least 44px tall (`h-11` / `min-h-11`), text at least 16px (`text-base`) so iOS does not zoom, no horizontal scrolling at 375px.
13. Input types and autofill: name `autoComplete="name"`; email `type="email" autoComplete="email" inputMode="email"`; phone `type="tel" autoComplete="tel"`; links `type="url" inputMode="url"`; salary `type="text" inputMode="decimal"` with "RM" before and "a month" after as visible text tied to the input by `aria-describedby`.
14. Helper text under the CV link, tied by `aria-describedby`: "Paste a link to your CV, for example Google Drive or LinkedIn. Make sure anyone with the link can view it."
15. Checking a field when the visitor leaves it (blur), not on each keystroke, with `fieldProblem`. The message sits directly under its field with `role="alert"`, is tied by `aria-describedby`, and the input gets `aria-invalid`. A field's message clears when the visitor fixes it and leaves again.
16. On submit: the browser does not block the post (`noValidate`); if `applyProblems` finds anything the client stops the post, shows a summary at the top of the form ("1 thing needs fixing" / "N things need fixing") as a list of links to each field (`href="#<input id>"`), and moves focus to the first invalid field. Errors that come back from the server are shown the same way.
17. The cover letter shows a live count "N / 4,000" under it (`aria-live="polite"`), counted with the same character rule as the check.
18. Consent is an unticked native checkbox with the whole sentence as its label: "I agree that {orgName} may store and use the details I've given to consider me for this role, and that they are processed through OpenKuasa." followed by a link "Privacy" to `/privacy` (`target="_blank" rel="noopener"`). The checkbox's tap area, with its label, is at least 44px tall. It is never ticked by default, including after a rejected submit unless the visitor had ticked it.
19. The submit button reads "Send application"; while pending it reads "Sending…" and is disabled, so a double tap sends once.
20. Done → the form is replaced by a panel with heading "Application sent" and the sentence "Thanks, {firstName}. {orgName} has your details and will be in touch if there's a match." (when `firstName` is empty: "Thanks. {orgName} has …"). The panel takes focus (`tabIndex={-1}`, `role="status"`). The same panel serves a repeat application.
21. Closed → the form is replaced by "This role is no longer taking applications." in the same panel style.
22. A whole-form error (throttled, failed) shows in a `role="alert"` above the button with what was typed kept in every field.
23. The honeypot: an input named `APPLY_HONEYPOT`, in a wrapper that is off-screen (not `display:none`), with `aria-hidden="true"`, `tabIndex={-1}`, `autoComplete="off"`, and a label a script would read.
24. Existing tokens only; no purple or violet; visible focus rings (the classes the careers shell uses); no animation that ignores reduced motion.
25. The form never renders anything it received from the server as HTML.

**The page — rules:**

26. Under the description: an `<h2>` "Apply for this role", then `<ApplyForm action={applyAction.bind(null, orgId, jobId)} form={job.form} orgName={job.orgName} />` when `job.accepting`; when it is not, the words "Applications closed" and no form.
27. The existing structure, metadata, back link and tests of the page stay as they are.

**Tests:**
- `tests/hire-apply-action.test.ts` (mock `@/lib/hire/public-careers`' `getPublicJob`, `@/lib/hire/public-applications`' `submitPublicApplication`, `@/lib/supabase/anonymous`, `hasSupabaseEnv`; build `FormData` by hand): one case per rule 3–7, including: a filled honeypot never calls either mock; a bad id never calls either; the requirements come from the job (post no CV to a job whose form requires one → `errors.cv_url`, and `submitPublicApplication` not called); each outcome maps as rule 7 says; a 6,000-character name is cut before the check; rejected states carry the values back; `done` carries only the first name.
- `tests/hire-apply-form.test.tsx` (render with `renderToStaticMarkup`, as `tests/hire-careers-pages.test.tsx` does; a client component with `useActionState` renders its initial state on the server): for the four switch combinations in `[all off, all on, CV only, portfolio and salary]`, the inputs present are exactly `shownFields`; required marks and `aria-required` follow `isRequired`; every input has a label tied by `for`/`id`; the email, tel, url input types and autocomplete values; the consent checkbox is present and not `checked`; the honeypot wrapper has `aria-hidden="true"` and its input `tabindex="-1"`; the button text; the "* Required" line. If `useActionState` cannot render under `renderToStaticMarkup` in this setup, say so in the report with the error and test the form's pure parts instead; do not add a component-test library.
- `tests/hire-careers-pages.test.tsx`: an accepting job renders the "Apply for this role" heading and the form; a non-accepting one renders "Applications closed" and no `<form`.

- [ ] **Step 1:** Write the tests; run `pnpm vitest run tests/hire-apply-action.test.ts tests/hire-apply-form.test.tsx tests/hire-careers-pages.test.tsx`. Expected: FAIL.
- [ ] **Step 2:** Write the action, the form and the page change to the rules.
- [ ] **Step 3:** Run the tests again, then `pnpm exec tsc --noEmit` and `pnpm exec eslint "src/app/careers" tests/hire-apply-action.test.ts tests/hire-apply-form.test.tsx`. Expected: PASS, clean.
- [ ] **Step 4:** Re-read each of the 27 rules against the finished files and list in the report the file and line that meets it, plus what can only be confirmed in a browser.
- [ ] **Step 5: Commit**

```bash
git add "src/app/careers/[orgId]/[jobId]/actions.ts" "src/app/careers/[orgId]/[jobId]/apply-form.tsx" "src/app/careers/[orgId]/[jobId]/page.tsx" tests/hire-apply-action.test.ts tests/hire-apply-form.test.tsx tests/hire-careers-pages.test.tsx
git commit -m "feat(hire): the public apply form on a job page"
```

---

### Task 4: Inside the app: application details, and Lekir's lookup

**Files:**
- Create: `src/screens/hire/application-details.tsx` (client)
- Modify: `src/lib/hire/types.ts`, `src/lib/hire/seed.ts`, `src/lib/hire/supabase.ts`, `src/lib/hire/lists.ts`, `src/screens/hire/applications.tsx`, `src/lib/ai/hire-tools.ts`, `src/lib/ai/agents/prompts.ts`
- Test: `tests/hire-lists.test.ts`, `tests/hire-provider.test.ts`, `tests/hire-seed.test.ts`, `tests/hire-tools.test.ts`, `tests/lekir-prompt.test.ts`

**Interfaces:**
- Produces: `Application` gains `cover_letter: string | null`, `cv_url: string | null`, `portfolio_url: string | null`, `expected_salary_cents: number | null`, `consented_at: string | null`; `ApplicationsModel.rows[]` gains `details: ApplicationDetails | null` where `ApplicationDetails = { coverLetter: string | null; cv: SafeLink | null; portfolio: SafeLink | null; expectedSalary: string | null }` and `SafeLink = { href: string; host: string }`; exported pure helper `safeLink(url: string | null): SafeLink | null` in `lists.ts`.

- [ ] **Step 1: Write the failing tests**

`tests/hire-lists.test.ts`:

```ts
describe('safeLink', () => {
  it('gives the address and its host for an http or https link', () => {
    expect(safeLink('https://drive.google.com/file/d/abc')).toEqual({ href: 'https://drive.google.com/file/d/abc', host: 'drive.google.com' });
    expect(safeLink('http://example.com')).toEqual({ href: 'http://example.com/', host: 'example.com' });
  });
  it('gives nothing for anything else, so it can never become a link', () => {
    for (const bad of [null, '', 'javascript:alert(1)', 'data:text/html,x', 'ftp://x.y', 'not a url', '//example.com', ' https://example.com']) {
      expect(safeLink(bad as string | null), String(bad)).toBeNull();
    }
  });
});
```
and, for `buildApplicationsModel`: an application with a cover letter, a CV link, a portfolio link and `expected_salary_cents: 350000` gives `details` with the letter, both `SafeLink`s and `expectedSalary: 'RM 3,500 a month'`; an application with none of the four gives `details: null`; a stored `cv_url` of `javascript:alert(1)` gives `cv: null`.

`tests/hire-provider.test.ts`: the applications select includes the five new columns; `tests/hire-seed.test.ts`: every seeded application has the five fields as `null`.

`tests/hire-tools.test.ts`, for `listApplications` (use the file's helpers):
- without `includeContact`, no row has any of `cover_letter`, `cv_url`, `portfolio_url`, `expected_salary_cents`;
- with `includeContact: true`, each row has all four; a 3,000-character cover letter comes back cut to 600 characters and ending with `…`; a short one comes back whole.

`tests/lekir-prompt.test.ts`: `LEKIR_SYSTEM` (lower-cased as the file does) contains `cover letter`, `cv link` and `expected salary` within the sentence about `includecontact`. Read the existing contact-details test first and extend it; do not restructure the file.

- [ ] **Step 2: Run and see them fail**

Run: `pnpm vitest run tests/hire-lists.test.ts tests/hire-provider.test.ts tests/hire-seed.test.ts tests/hire-tools.test.ts tests/lekir-prompt.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `types.ts`: the five fields on `Application`, each with a one-line doc comment. `supabase.ts`: append `cover_letter,cv_url,portfolio_url,expected_salary_cents,consented_at` to `APPLICATION_COLUMNS`. `seed.ts`: the five as `null` on every seeded application.
- `lists.ts`:

```ts
export type SafeLink = { href: string; host: string };

/** A stored link as something safe to render: http or https only, or nothing. */
export function safeLink(url: string | null): SafeLink | null {
  if (!url || url !== url.trim()) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return { href: parsed.href, host: parsed.host };
  } catch {
    return null;
  }
}
```
  and `details` on each row of `buildApplicationsModel`: `null` when all of cover letter, both links (after `safeLink`) and salary are absent; `expectedSalary` formatted as `RM 3,500 a month` (whole ringgit with thousands commas; sen shown only when not zero). Reuse an existing ringgit formatter if one is exported in `src/lib/hire` (`public-careers.ts` has one for the job page; export and reuse it rather than writing a third).
- `application-details.tsx` (client) and `applications.tsx`. Rules:
  1. The Applications table gains a last column with a "Details" button per row that has `details`; rows without show nothing there. The button has `aria-expanded` and `aria-controls`, a 44px target, and an accessible name that includes the candidate ("Details for Aina Rahman").
  2. Expanding shows a panel directly under that row (a full-width row in the same table, so reading order follows): the cover letter as plain text with line breaks kept (`whitespace-pre-line`, `break-words`); "CV" and "Portfolio" as links whose visible text is the host, opening in a new tab with `target="_blank" rel="noopener noreferrer"`; "Expected salary" as text. Only what is present is shown. Read-only.
  3. Only plain data crosses to the client component (the `details` object and the name). Text is rendered as React text children only.
  4. Nothing else on the Applications screen changes; no purple or violet.
- `hire-tools.ts`, `listApplications`: inside the existing `...(people && {...})` block add `cover_letter` (cut to 600 characters with `…` when longer), `cv_url`, `portfolio_url`, `expected_salary_cents`; extend the tool's description sentence about `includeContact` to say these are returned only then.
- `prompts.ts`: in `LEKIR_SYSTEM`'s existing sentence about `includeContact`, extend the list of what counts as contact details to name the cover letter, the CV link, the portfolio link and expected salary. Make the same extension where the hire specialist rule or the Tuah prompts already mention `includeContact`; touch no other sentence.

- [ ] **Step 4: Run and see them pass**

Run the Step 2 command plus `tests/hire-helpers.test.ts tests/hire-screen-parts.test.ts tests/tuah-hire.test.ts`, then `pnpm exec tsc --noEmit` and `pnpm exec eslint src/screens/hire src/lib/hire src/lib/ai`. Any test fake of `Application` that tsc flags gets the five `null` fields; list each such file in the report.
Expected: PASS; clean.

- [ ] **Step 5: Commit** (stage every file you changed by name)

```bash
git commit -m "feat(hire): application details inside the app, and to Lekir only when contact details are asked for"
```

---

### Task 5: Live checks (written, not run)

**Files:**
- Create: `tests/hire-public-applications.rls.test.ts`

Read `tests/hire-careers.rls.test.ts` and `tests/hire-application-form.rls.test.ts` first and reuse their exact helpers (`ownedOrg`, the skip condition, the viewer through `join_demo_org`, `createAnonymousClient` as the visitor). Do NOT run the file. Cases run in file order; a positive case asserts returned values, not merely "no error". Every email the file sends is unique to the run (`rls-<timestamp>-<n>@example.com`) so a re-run never collides with rows a previous run left.

The owner can read `hire_candidates` and `hire_applications` for their own workspace but cannot delete from them (they are read-only inside the app until slice 3), so the rows this file creates stay in the two test workspaces it makes. Say so in a comment at the top; `afterAll` switches every board off and deletes the jobs it can (a job with applications cannot be deleted: close it instead).

Setup: owner workspace with the board on and the form switches all off; one open described job `openJob`; one draft job; one open job past its closing date; a second workspace with its board on and one open job; a small `apply(overrides)` helper that calls the function as the visitor with good defaults.

Cases:
1. Each refusal writes nothing. For every one of these, the word comes back and the owner's count of candidates and applications is unchanged: a 121-character name → `name_too_long`; a 4,001-character cover letter → `cover_letter_too_long`; a 501-character link → `url_too_long`; a blank name → `invalid_name`; `aina@` → `invalid_email`; `javascript:alert(1)` as the CV link → `invalid_url`; `-1` salary → `invalid_salary`; the other workspace's org id with this job id → `not_found`; the draft job → `closed`; the job past its closing date → `closed`; consent false → `consent_required`.
2. A filled honeypot answers `ok` and writes nothing.
3. A valid application: `ok`; the owner now reads exactly one new candidate (name, lowercased email, phone, `source 'Careers page'`, `pool_status 'none'`) and one application (`stage 'applied'`, `outcome 'active'`, `source 'Careers page'`, `consented_at` set within the last minute, the four optional fields null because the switches are off even though a portfolio link and a salary were sent).
4. The same application again: `ok`, and the counts are unchanged.
5. An existing candidate is not overwritten: apply to the second open job of the owner's workspace (make one) with the same email in different letter case, a different name and a different phone → `ok`; the candidate's name and phone are what case 3 stored; there is still one candidate with that email and now two applications.
6. A missing phone is filled: a new email applies with no phone, then applies to the other job with a phone → the candidate's phone is now that phone.
7. Requirements follow the settings: the owner switches `require_cv` and `require_cover_letter` on → a submission without a CV is `cv_required`, with a CV but no letter `cover_letter_required`, with both `ok` and the application stores both; the owner switches `ask_portfolio` and `ask_expected_salary` on → a submission with a portfolio link and `350000` stores both.
8. The members were told: after case 3 the owner reads at least one notification with title `New application`, a body containing the applicant's name and the job title, and `href` `/hire/applications`.
9. A board that is off: the owner switches the board off → `closed`; back on for the next case.
10. The demo workspace: the visitor applies to a demo job id (read one as the viewer) → `closed`.
11. The visitor has no table access: selecting from `hire_candidates` and from `hire_applications` each fails with code `42501`.
12. Another workspace's owner reads none of the first workspace's candidates or applications.
13. `get_public_job` returns the four requirement columns matching the owner's settings, and still none of `headcount`, `status`, `created_at`, `closed_at`.
14. Last, the throttle: on a fresh open job, 30 applications from 30 emails in a row are each `ok` and the 31st is `throttled`; the applications count for that job is 30. Give this case a 120-second timeout.

- [ ] **Step 1:** Write the file. Do NOT run it.
- [ ] **Step 2:** `pnpm exec tsc --noEmit` and `pnpm exec eslint tests/hire-public-applications.rls.test.ts`. Expected: clean.
- [ ] **Step 3: Commit**

```bash
git add tests/hire-public-applications.rls.test.ts
git commit -m "test(hire): live checks for public applications"
```

---

### Task 6 (controller): apply, verify, smoke, pull request

Not for an implementer. The migration, the push and any question-set run each wait for the user's yes.

- [ ] Rebase onto `origin/main`; if another migration took version `20261018090000`, renumber this one and its test.
- [ ] Before applying: confirm on the live database that no workspace has two candidates with the same lowercased email (the unique index would fail), and that `private.deliver_notification` has the six-argument signature the function calls.
- [ ] Apply `hire_public_applications` through the `openkuasa-supabase` MCP (one call). It must go in before the branch deploys.
- [ ] Verify live: five columns and their checks; the unique index; `anon` can execute the two functions and has no table privilege; `get_public_job` returns eighteen columns; the security advisors show nothing new.
- [ ] Run `tests/hire-public-applications.rls.test.ts`, then the full suite, `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm build`.
- [ ] Local smoke as the smoke account plus a signed-out context at 375px: board on, one open job; apply with the least the form asks for; see the thank-you, the application on the Applications screen with source "Careers page", the candidate on Candidates, and the notification in the bell; apply again and see the same thank-you with nothing added; switch on all four form switches and apply with a new email, checking each field, the errors on blur, the summary and focus on a bad submit, the character count, the unticked consent, a double tap sending once; open Details inside the app and check both links open in a new tab with the host as their text; with JavaScript disabled, submit once and see the server's answer; ask Lekir for the newest application with contact details. Then restore: board and switches off. The test candidates and applications cannot be removed through the app yet: remove them by id through the database after the user's yes, or leave them and say so.
- [ ] After a yes: next free branch number, push, open the pull request (title = branch name; no close keyword unless a tracking issue exists). Do not merge until asked. After merge: smoke test production the same way, with the user signed in to the smoke account.
