// tests/hire-cv-upload-migration.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations', '20261019090000_hire_cv_upload.sql'), 'utf8',
);
const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$$;', start));
};
const policies = () => [...sql.matchAll(/create policy[\s\S]*?;/g)].map((m) => m[0]);
const WORDS = [
  'ok', 'name_too_long', 'email_too_long', 'phone_too_long', 'cover_letter_too_long', 'url_too_long',
  'invalid_name', 'invalid_email', 'invalid_url', 'invalid_salary', 'not_found', 'closed',
  'consent_required', 'cv_required', 'cover_letter_required', 'throttled',
  'invalid_cv_path', 'ok_duplicate',
];
const OLD_SIGNATURE = 'uuid, uuid, text, text, text, text, text, text, bigint, boolean, text';
const NEW_SIGNATURE = `${OLD_SIGNATURE}, text`;

describe('hire cv upload migration', () => {
  test('adds cv_path with a shape check and a unique index', () => {
    expect(sql).toContain('alter table public.hire_applications');
    expect(sql).toContain(
      "add column cv_path text check (cv_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\\.pdf$')",
    );
    expect(sql).toContain(
      'create unique index hire_applications_cv_path_key on public.hire_applications (cv_path) where cv_path is not null',
    );
  });

  test('makes a private, PDF-only, 5 MB bucket', () => {
    expect(sql).toContain("values ('hire-cvs', 'hire-cvs', false, 5242880, array['application/pdf'])");
  });

  test('gives the bucket one select policy and no write policy for anyone', () => {
    const all = policies();
    const forBucket = all.filter((p) => p.includes("'hire-cvs'"));
    expect(forBucket.filter((p) => /for select/.test(p))).toHaveLength(1);
    for (const p of forBucket) {
      expect(p).not.toMatch(/for insert/);
      expect(p).not.toMatch(/for update/);
      expect(p).not.toMatch(/for delete/);
    }
    const forAll = all.filter((p) => /for all/.test(p));
    expect(forAll.length).toBeGreaterThan(0);
    for (const p of forAll) expect(p).toContain('as restrictive');
    for (const p of all) expect(p).not.toMatch(/\banon\b/);
  });

  test('drops the old submit function by its exact signature before making the new one', () => {
    const drop = sql.indexOf(`drop function public.submit_public_application(${OLD_SIGNATURE});`);
    const create = sql.indexOf('create or replace function public.submit_public_application(');
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
  });

  test('only the server may attach a file, and the path is bound to this workspace and job', () => {
    const body = fn('submit_public_application');
    expect(body).toContain('p_cv_path text default null');
    // The service-role gate comes before the job is read.
    const gate = body.indexOf("coalesce((select auth.role()), '') <> 'service_role'");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(body.indexOf('from public.hire_jobs j'));
    // The path shape is built from the route's workspace and job.
    expect(body).toContain("(v_cv_path ~ ('^' || p_org_id::text || '/' || p_job_id::text");
    expect(body).toContain('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.pdf$');
    // A CV is missing only when both the link and the path are missing.
    expect(body).toContain("if v_require_cv and v_cv = '' and v_cv_path is null then return 'cv_required'; end if;");
    expect(body.match(/return 'cv_required'/g)).toHaveLength(1);
    // ok_duplicate only inside a branch that tests the path.
    expect(body.match(/return 'ok_duplicate'/g)).toHaveLength(1);
    const dup = body.indexOf("return 'ok_duplicate'");
    const branch = body.lastIndexOf('if ', dup);
    expect(body.slice(branch, dup)).toContain('v_cv_path is not null');
    const returned = [...body.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]);
    expect([...new Set(returned)].sort()).toEqual([...WORDS].sort());
    // The path is stored with the application.
    expect(body).toContain('cover_letter, cv_url, cv_path, portfolio_url, expected_salary_cents, consented_at');
    expect(body).toContain("nullif(v_cover, ''), nullif(v_cv, ''), v_cv_path, nullif(v_portfolio, ''), v_salary, now()");
  });

  test('the submit function is a locked-down definer function that only ever returns a word', () => {
    const body = fn('submit_public_application');
    expect(body).toContain('returns text');
    expect(body).toContain("language plpgsql security definer set search_path = ''");
    expect(body).not.toMatch(/\bexecute\s+(format|')/i);
    // Nothing is returned but a literal word.
    expect(body.match(/\breturn\b(?! '[a-z_]+';)/g) ?? []).toEqual([]);
  });

  test('keeps the 2d order: honeypot, lengths, shapes, job, consent, requirements, throttle, tick, lock, candidate, application', () => {
    const body = fn('submit_public_application');
    const order = [
      'p_honeypot', "'name_too_long'", "'invalid_name'", "'not_found'", "'closed'",
      "'consent_required'", "'cv_required'", "'throttled'", 'insert into private.hire_apply_ticks',
      'pg_advisory_xact_lock', 'insert into public.hire_candidates',
      'insert into public.hire_applications', 'private.deliver_notification',
    ].map((needle) => body.indexOf(needle));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('keeps the 2d rules: closed rule, workspace and job scoping, honeypot first, repeats, notifications', () => {
    const body = fn('submit_public_application');
    expect(body).toContain("'rimba-ventures-demo'");
    expect(body).toContain('careers_enabled');
    expect(body).toContain("v_status <> 'open'");
    expect(body).toContain("(now() at time zone 'Asia/Kuala_Lumpur')::date");
    expect(body).toContain('where j.id = p_job_id and j.org_id = p_org_id');
    expect(body).toContain('where c.org_id = p_org_id and lower(c.email) = v_email');
    expect(body).toContain('if v_application_id is not null then');
    expect(body).toContain('on conflict (candidate_id, job_id) do nothing');
    expect(body).toMatch(/exception\s+when others then/);
    expect(body).toContain("raise log 'submit_public_application: notification skipped (%)', sqlstate");
    const begin = body.indexOf('\nbegin\n');
    expect(body.indexOf("btrim(coalesce(p_honeypot, '')) <> ''", begin)).toBeLessThan(body.indexOf("'name_too_long'"));
    const closed = body.slice(body.indexOf('if not v_enabled'), body.indexOf("return 'closed'"));
    for (const part of ['not v_enabled', "'rimba-ventures-demo'", "v_status <> 'open'", 'v_described is not true', 'v_closes <']) {
      expect(closed, part).toContain(part);
    }
    expect(body).toContain("v_cv !~ '^https?://[^\\s]+$'");
    expect(body).toContain("v_portfolio !~ '^https?://[^\\s]+$'");
    expect(body).toContain("v_cover text := regexp_replace(coalesce(p_cover_letter, ''), '^\\s+|\\s+$', '', 'g');");
    // Only a missing phone is ever filled on a known candidate.
    const updates = [...body.matchAll(/update public\.hire_candidates[\s\S]*?;/g)].map((m) => m[0]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('phone is null');
    expect(updates[0]).not.toMatch(/\bname\s*=/);
    // The tick is written after the last refusal and before the candidate is looked up.
    const tick = body.indexOf('insert into private.hire_apply_ticks');
    expect(tick).toBeGreaterThan(body.indexOf("return 'throttled'"));
    expect(tick).toBeLessThan(body.indexOf('insert into public.hire_candidates'));
    expect(body).not.toMatch(/count\(\*\) from public\.hire_applications/);
  });

  test('execute grants: submit to the three roles, the helpers to the service role only', () => {
    expect(sql).toContain(`revoke execute on function public.submit_public_application(${NEW_SIGNATURE}) from public, anon, authenticated;`);
    expect(sql).toContain(`grant execute on function public.submit_public_application(${NEW_SIGNATURE}) to anon, authenticated, service_role;`);
    for (const sig of ['hire_apply_throttled(uuid)', 'hire_cv_deletions_due(integer)', 'hire_cv_deletions_done(text[])']) {
      const revoke = sql.indexOf(`revoke execute on function public.${sig} from public, anon, authenticated;`);
      const grant = sql.indexOf(`grant execute on function public.${sig} to service_role;`);
      expect(revoke, sig).toBeGreaterThan(-1);
      expect(grant, sig).toBeGreaterThan(revoke);
    }
    expect(sql).not.toMatch(/grant\s+(select|insert|update|delete|all)[^;]*to[^;]*\banon\b/i);
  });

  test('the deletions table is private and filled by a locked-down trigger', () => {
    expect(sql).toContain('create table private.hire_cv_deletions');
    expect(sql).toContain('alter table private.hire_cv_deletions enable row level security');
    expect(sql).toContain('revoke all on private.hire_cv_deletions from public, anon, authenticated');
    expect(sql).toMatch(/create trigger hire_applications_cv_deleted\s+after delete on public\.hire_applications\s+for each row when \(old\.cv_path is not null\)/);
    const start = sql.indexOf('create or replace function private.hire_note_cv_deletion()');
    expect(start).toBeGreaterThan(-1);
    const trigger = sql.slice(start, sql.indexOf('$$;', start));
    expect(trigger).toContain("security definer set search_path = ''");
  });

  test('the read policy is for members of the workspace in the path, and guards its cast', () => {
    const select = policies().find((p) => p.includes('hire_cvs_select'))!;
    expect(select).toContain('to authenticated');
    expect(select).toContain("case when bucket_id = 'hire-cvs' and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'");
    expect(select).toContain('then private.is_org_member(((storage.foldername(name))[1])::uuid)');
    expect(select).toContain('else false end');
  });

  test('the second-factor policy leaves every other bucket alone', () => {
    const mfa = policies().find((p) => p.includes('hire_cvs_mfa_required'))!;
    expect(mfa).toContain("using (bucket_id <> 'hire-cvs' or (select private.mfa_ok()))");
    expect(mfa).toContain("with check (bucket_id <> 'hire-cvs' or (select private.mfa_ok()))");
  });

  test('no server-only function is ever granted to a visitor or a member', () => {
    for (const name of ['hire_apply_throttled', 'hire_cv_deletions_due', 'hire_cv_deletions_done', 'hire_cv_attached', 'hire_cv_files_refused']) {
      const grants = [...sql.matchAll(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to ([^;]+);`, 'g'))];
      expect(grants.map((g) => g[1]), name).toEqual(['service_role']);
      expect(sql, name).toMatch(new RegExp(`revoke execute on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`));
    }
  });

  test('a path is refused unless it matches, even when an id is missing', () => {
    expect(fn('submit_public_application')).toContain("\\.pdf$')) is not true then");
  });

  test('the server can ask whether a file is held by an application', () => {
    expect(fn('hire_cv_attached')).toContain('select exists (select 1 from public.hire_applications a where a.cv_path = p_path)');
  });

  test('a workspace nobody with a real sign-in owns is not sent files', () => {
    const body = fn('hire_cv_files_refused');
    expect(body).toContain('select not exists (');
    expect(body).toContain("m.org_id = p_org_id and m.role = 'owner' and u.is_anonymous is not true");
  });

  test('a workspace takes at most 200 CV files a day, asked before any upload', () => {
    const body = fn('hire_apply_throttled');
    expect(body).toContain("t.at > now() - interval '1 minute'");
    expect(body).toContain('a.cv_path is not null');
    expect(body).toContain("a.created_at > now() - interval '1 day'");
    expect(body).toContain('>= 200');
    expect(body).toContain('j.id = p_job_id');
  });
});
