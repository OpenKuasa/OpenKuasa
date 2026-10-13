// tests/hire-cv-sweep-migration.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations', '20261021090000_hire_cv_sweep_and_cap.sql'), 'utf8',
);
const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = sql.indexOf('$$;', start);
  return sql.slice(start, end);
};

describe('hire cv sweep and cap migration', () => {
  test('a stored file with no application is queued for removal, after an hour', () => {
    const body = fn('hire_cv_queue_orphans');
    expect(body).toContain('security definer');
    expect(body).toContain("set search_path = ''");
    expect(body).toContain('insert into private.hire_cv_deletions (path)');
    expect(body).toContain("o.bucket_id = 'hire-cvs'");
    expect(body).toContain("o.created_at < now() - interval '1 hour'");
    expect(body).toContain('not exists (select 1 from public.hire_applications a where a.cv_path = o.name)');
    expect(body).toContain('on conflict (path) do nothing');
  });

  test('only the server may queue', () => {
    expect(sql).toContain('revoke execute on function public.hire_cv_queue_orphans() from public, anon, authenticated;');
    expect(sql).toContain('grant execute on function public.hire_cv_queue_orphans() to service_role;');
    expect(sql).not.toMatch(/grant execute on function public\.hire_cv_queue_orphans\(\) to [^;]*(anon|authenticated)/);
  });

  test('no workspace is sent a file once the bucket holds 500 MB, whoever owns it', () => {
    const body = fn('hire_cv_files_refused');
    expect(body).toContain("m.org_id = p_org_id and m.role = 'owner' and u.is_anonymous is not true");
    expect(body).toContain("o.bucket_id = 'hire-cvs'");
    expect(body).toContain('>= 524288000');
  });

  test('a workspace takes 50 CV files a day, and a job 30 applications a minute', () => {
    const body = fn('hire_apply_throttled');
    expect(body).toContain("t.at > now() - interval '1 minute'");
    expect(body).toContain('>= 30');
    expect(body).toContain('>= 50');
    expect(body).not.toContain('>= 200');
    expect(body).toContain("a.created_at > now() - interval '1 day'");
  });

  test('changes no grant of the two functions it rewrites, and creates nothing a visitor can call', () => {
    expect(sql).not.toMatch(/grant [^;]* to [^;]*\b(anon|authenticated|public)\b/);
  });
});
