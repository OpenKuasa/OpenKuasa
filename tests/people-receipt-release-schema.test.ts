import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const WRITES = '20261020090000_people_claims_overtime_writes.sql';
const RELEASE = '20261020100000_people_receipt_release.sql';

/** A migration's statements, without its comment lines (they describe the rules in words the checks would trip on). */
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
const release = () => statements(RELEASE);

/** One function's text: `header` up to `as $$`, `body` from there to its closing `$$;`. */
function fn(text: string, qualified: string): { header: string; body: string } {
  const start = text.indexOf(`create or replace function ${qualified}(`);
  expect(start, qualified).toBeGreaterThan(-1);
  const open = text.indexOf(' as $$', start);
  const close = text.indexOf('$$;', open + 6);
  return { header: text.slice(start, open), body: text.slice(open, close) };
}

const LOCK = 'perform pg_advisory_xact_lock(hashtextextended(';
const REPLACED: { name: string; args: string }[] = [
  { name: 'hr_submit_claim', args: 'uuid, text, bigint, date, text, text' },
  { name: 'hr_cancel_claim', args: 'uuid' },
];

describe('Lekiu receipt release migration', () => {
  test('sorts after the claims migration it builds on, alone on its timestamp', () => {
    expect(RELEASE > WRITES).toBe(true);
    const files = readdirSync(DIR);
    expect(files).toContain(RELEASE);
    expect(files.filter((f) => f.startsWith('20261020100000'))).toEqual([RELEASE]);
  });

  test('makes one table, three functions and nothing else', () => {
    const text = release();
    expect(text.match(/create table (\S+)/g)).toEqual(['create table private.hr_released_receipts']);
    expect([...text.matchAll(/create or replace function ((?:public|private)\.\w+)\(/g)].map((m) => m[1])).toEqual([
      'public.hr_release_receipt',
      'public.hr_submit_claim',
      'public.hr_cancel_claim',
    ]);
    expect(text).not.toMatch(/\b(alter table public\.|alter table storage\.|drop |create policy|create index|create unique index)/);
    expect(text).not.toMatch(/insert into storage\./);
  });

  test('the released list has a path and a time, row level security, and no grant to anyone', () => {
    const text = release();
    expect(text).toContain(
      'create table private.hr_released_receipts (\n'
        + '  path text primary key,\n'
        + '  released_at timestamptz not null default now()\n'
        + ');',
    );
    expect(text).toContain('alter table private.hr_released_receipts enable row level security;');
    expect(text).toContain('revoke all on private.hr_released_receipts from public, anon, authenticated, service_role;');
    expect(text).not.toMatch(/grant [^;]*hr_released_receipts/);
    expect(text).not.toMatch(/disable row level security/);
  });

  test('execute is granted on the three functions and nothing else is granted', () => {
    const grants = release().match(/grant [^;]*;/g) ?? [];
    expect(grants).toEqual([
      'grant execute on function public.hr_release_receipt(text) to authenticated;',
      'grant execute on function public.hr_submit_claim(uuid, text, bigint, date, text, text) to authenticated;',
      'grant execute on function public.hr_cancel_claim(uuid) to authenticated;',
    ]);
    // In particular no write on either claims table.
    expect(release()).not.toMatch(/grant\s+(all|select|insert|update|delete|truncate)/i);
  });

  test('hr_release_receipt runs as the owner on a fixed search path, for signed-in users only', () => {
    const text = release();
    const { header } = fn(text, 'public.hr_release_receipt');
    expect(header).toBe(
      'create or replace function public.hr_release_receipt(p_path text)\n'
        + 'returns boolean language plpgsql security definer set search_path = public',
    );
    expect(text).toContain('revoke all on function public.hr_release_receipt(text) from public, anon;');
  });

  test('hr_release_receipt says no without a user, a second factor, a path, or the caller\'s own folder', () => {
    const { body } = fn(release(), 'public.hr_release_receipt');
    const gate = body.indexOf('if auth.uid() is null or not private.mfa_ok() or p_path is null then return false; end if;');
    const folder = body.indexOf("if split_part(p_path, '/', 1) <> auth.uid()::text then return false; end if;");
    const lock = body.indexOf(`${LOCK}p_path, 0));`);
    expect(gate).toBeGreaterThan(-1);
    expect(folder).toBeGreaterThan(gate);
    // Only a path shaped like a receipt: one anchored pattern, lower case, the five extensions.
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    const shape = body.indexOf(`if p_path !~ '^${uuid}/${uuid}\\.(jpg|png|webp|heic|pdf)$' then\n    return false;\n  end if;`);
    expect(shape).toBeGreaterThan(folder);
    expect(body).not.toContain('~*');
    // Nothing is locked, looked up or recorded for a caller who fails those.
    expect(lock).toBeGreaterThan(shape);
    // It never raises, so the answer says little.
    expect(body).not.toContain('raise');
  });

  test('hr_release_receipt looks at every claim, under the lock, before it records the path', () => {
    const { body } = fn(release(), 'public.hr_release_receipt');
    const lock = body.indexOf(`${LOCK}p_path, 0));`);
    const attached = body.indexOf(
      'if exists (select 1 from public.hr_claims c where c.receipt_path = p_path) then return false; end if;',
    );
    const record = body.indexOf('insert into private.hr_released_receipts (path) values (p_path) on conflict do nothing;');
    expect(lock).toBeGreaterThan(-1);
    expect(attached).toBeGreaterThan(lock);
    expect(record).toBeGreaterThan(attached);
    expect(body.lastIndexOf('return true;')).toBeGreaterThan(record);
    // Every workspace, no row rules, no cap: nothing narrows the lookup.
    expect(body).not.toMatch(/org_id|is_org_|is_own_employee|limit\s+\d/);
    // It deletes nothing itself, and only reads storage.
    expect(body).not.toMatch(/\b(delete from|update public|update storage|insert into storage)/);
  });

  test('hr_release_receipt records only a file that was really uploaded, and stays true for one already released', () => {
    const { body } = fn(release(), 'public.hr_release_receipt');
    const lock = body.indexOf(`${LOCK}p_path, 0));`);
    const attached = body.indexOf('from public.hr_claims c where c.receipt_path = p_path');
    const again = body.indexOf(
      'if exists (select 1 from private.hr_released_receipts x where x.path = p_path) then return true; end if;',
    );
    const uploaded = body.indexOf(
      'if not exists (\n'
        + '    select 1 from storage.objects o\n'
        + "    where o.bucket_id = 'hr-receipts' and o.name = p_path\n"
        + '  ) then\n'
        + '    return false;\n'
        + '  end if;',
    );
    const record = body.indexOf('insert into private.hr_released_receipts (path) values (p_path)');
    expect(lock).toBeGreaterThan(-1);
    // A path on a claim is refused first; a path released before is true whether or not the file is still
    // there (a retried delete); only then is the file looked for, and only then is anything recorded.
    expect(attached).toBeGreaterThan(lock);
    expect(again).toBeGreaterThan(attached);
    expect(uploaded).toBeGreaterThan(again);
    expect(record).toBeGreaterThan(uploaded);
    expect(body.match(/return true;/g)).toHaveLength(2);
  });

  test.each(REPLACED)('$name keeps its signature, owner rights and grants', ({ name, args }) => {
    const text = release();
    const applied = fn(statements(WRITES), `public.${name}`).header;
    expect(fn(text, `public.${name}`).header).toBe(applied);
    expect(applied).toContain('returns jsonb language plpgsql security definer set search_path = public');
    expect(text).toContain(`revoke all on function public.${name}(${args}) from public, anon;`);
    expect(text).toContain(`grant execute on function public.${name}(${args}) to authenticated;`);
  });

  test('hr_submit_claim is the applied function plus the lock and the released test', () => {
    const before = fn(statements(WRITES), 'public.hr_submit_claim').body;
    const after = fn(release(), 'public.hr_submit_claim').body;
    const lockLine = `    ${LOCK}p_receipt_path, 0));\n`;
    const releasedLine =
      '\n       or exists (select 1 from private.hr_released_receipts x where x.path = p_receipt_path)';
    expect(after).toContain(lockLine);
    expect(after).toContain(releasedLine);
    expect(after.replace(lockLine, '').replace(releasedLine, '')).toBe(before);

    // The lock is taken before any of the receipt tests, and those before the insert.
    const lock = after.indexOf(lockLine);
    expect(lock).toBeGreaterThan(after.indexOf('if p_receipt_path is not null then'));
    expect(after.indexOf("split_part(p_receipt_path, '/', 1)")).toBeGreaterThan(lock);
    expect(after.indexOf('from storage.objects o')).toBeGreaterThan(lock);
    expect(after.indexOf('where c.receipt_path = p_receipt_path')).toBeGreaterThan(lock);
    const refusal = after.indexOf("raise exception 'PAY_BAD_RECEIPT';");
    expect(refusal).toBeGreaterThan(after.indexOf(releasedLine));
    expect(after.indexOf('insert into public.hr_claims')).toBeGreaterThan(refusal);
    expect(after).toContain('where e.id = p_employee for no key update;');
  });

  test('hr_cancel_claim is the applied function plus releasing the path it hands back', () => {
    const before = fn(statements(WRITES), 'public.hr_cancel_claim').body;
    const after = fn(release(), 'public.hr_cancel_claim').body;
    const added =
      '  if req.receipt_path is not null then\n'
      + '    insert into private.hr_released_receipts (path) values (req.receipt_path) on conflict do nothing;\n'
      + '  end if;\n';
    expect(after).toContain(added);
    expect(after.replace(added, '')).toBe(before);

    // Still locks the claim before reading it, and releases in the same call that clears the path.
    const rowLock = after.indexOf('select * into req from public.hr_claims r where r.id = p_request for update;');
    expect(rowLock).toBeGreaterThan(-1);
    expect(after.indexOf('req.status')).toBeGreaterThan(rowLock);
    const cleared = after.indexOf("set status = 'cancelled', receipt_path = null, has_receipt = false");
    expect(cleared).toBeGreaterThan(rowLock);
    expect(after.indexOf(added)).toBeGreaterThan(cleared);
    expect(after.indexOf("'removed_receipt_path', req.receipt_path")).toBeGreaterThan(after.indexOf(added));
  });

  test('the two functions that decide about one path take the same lock on it', () => {
    const text = release();
    expect(fn(text, 'public.hr_release_receipt').body).toContain('pg_advisory_xact_lock(hashtextextended(p_path, 0))');
    expect(fn(text, 'public.hr_submit_claim').body).toContain(
      'pg_advisory_xact_lock(hashtextextended(p_receipt_path, 0))',
    );
    expect(text.match(/pg_advisory_xact_lock\(/g)).toHaveLength(2);
    // Transaction-scoped only: nothing to unlock, nothing left held.
    expect(text).not.toMatch(/pg_advisory_lock\(|pg_advisory_unlock/);
  });

  test('a refusal is still a code and nothing else', () => {
    const raised = [...release().matchAll(/raise exception ([^;]*);/g)].map((m) => m[1]);
    expect(raised.length).toBeGreaterThan(8);
    for (const message of raised) expect(message).toMatch(/^'PAY_[A-Z_]+'$/);
    expect(release()).not.toMatch(/raise (notice|warning|log|info)/i);
  });
});
