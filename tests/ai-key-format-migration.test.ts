import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { encryptApiKey, isOpenRouterKeyShape } from '@/lib/ai/key-crypto';

const DIR = join(process.cwd(), 'supabase/migrations');
const FILE = '20261103110000_ai_key_format_check.sql';
/** The applied migration whose check could not run; the file above replaces its function. */
const BROKEN = '20261030101500_ai_key_workspace_binding.sql';

// Comments say what the statements must not do; only the statements are checked.
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

const files = readdirSync(DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const code = statements(FILE);

/**
 * PostgreSQL takes no repetition bound above this in a regular expression
 * (DUPMAX in its regex library): `x{1,1900}` is not a long match but error
 * 2201B, raised when the statement runs, not when the function is created.
 */
const MAX_BOUND = 255;

/** Every `{n}`, `{n,}` and `{n,m}` in `text` with a number above the bound. */
function boundsAbove(text: string, max = MAX_BOUND): string[] {
  return [...text.matchAll(/\{(\d+)(?:,(\d*))?\}/g)]
    .filter(([, low, high]) => Number(low) > max || Number(high ?? 0) > max)
    .map(([found]) => found);
}

/**
 * The newest definition of every function in the migrations, by its
 * schema-qualified name: file name, and the text from `create` to the end of
 * its body.
 *
 * What this relies on, and so cannot see past:
 *   - every function here is written `create [or replace] function <name>(`
 *     with its body between `$$` and `$$` (true of all of them; the test below
 *     fails if one is found that does not close, e.g. a `$tag$` body);
 *   - a function is known by name alone, so of two overloads only the later
 *     is kept (the file-wide check further down covers the other);
 *   - a function that was dropped later still counts;
 *   - migrations are read in file-name order, which is the order they apply.
 */
function newestFunctions(): Map<string, { file: string; text: string }> {
  const newest = new Map<string, { file: string; text: string }>();
  for (const file of files) {
    const sql = statements(file);
    for (const match of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z_][a-z0-9_.]*)\s*\(/gi)) {
      const open = sql.indexOf('$$', match.index);
      const close = open === -1 ? -1 : sql.indexOf('$$', open + 2);
      newest.set(match[1].toLowerCase(), {
        file,
        text: close === -1 ? '' : sql.slice(match.index, close + 2),
      });
    }
  }
  return newest;
}

describe('workspace AI key format migration', () => {
  const start = code.indexOf('create or replace function public.set_org_ai_key(');
  const fn = code.slice(start, code.indexOf('$$;', start));

  test('is one file, alone on its version, after the migration it corrects', () => {
    expect(files.filter((f) => f.includes('ai_key_format_check'))).toEqual([FILE]);
    expect(files.filter((f) => f.startsWith(FILE.slice(0, 14)))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBeGreaterThan(files.indexOf(BROKEN));
    // Nothing later defines the function again.
    expect(newestFunctions().get('public.set_org_ai_key')?.file).toBe(FILE);
  });

  test('the sealed value is matched by shape and capped by length, with no bound above 255', () => {
    expect(start).toBeGreaterThan(-1);
    expect(fn).toContain(
      String.raw`if (p_ciphertext ~ '^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$') is not true`,
    );
    expect(fn).toMatch(/or length\(p_ciphertext\) > 2000\s+or \(p_hint ~ '\^sk-or-…\[A-Za-z0-9_-\]\{4\}\$'\) is not true then\s+raise exception 'invalid key';/);
    expect(boundsAbove(code)).toEqual([]);
    expect(code).not.toContain('{1,1900}');
  });

  test('everything else is the function as it was', () => {
    const before = statements(BROKEN);
    const from = before.indexOf('create or replace function public.set_org_ai_key(');
    const old = before.slice(from, before.indexOf('$$;', from));
    const newCheck = String.raw`[A-Za-z0-9_-]+$') is not true` + '\n     or length(p_ciphertext) > 2000';
    const oldCheck = String.raw`[A-Za-z0-9_-]{1,1900}$') is not true`;
    expect(fn.split(newCheck)).toHaveLength(2);
    // Put the old condition back and the two are the same text, to the character.
    expect(fn.split(newCheck).join(oldCheck)).toBe(old);
    expect(fn).toContain("returns void language plpgsql security definer set search_path = '' as $$");
  });

  test('only the server may call it, stated again in this file', () => {
    expect(code).toContain(
      'revoke all on function public.set_org_ai_key(uuid, uuid, text, text) from public, anon, authenticated;',
    );
    expect(code).toContain('grant execute on function public.set_org_ai_key(uuid, uuid, text, text) to service_role;');
    expect(code).not.toMatch(/grant[^;]*set_org_ai_key[^;]*to (public|anon|authenticated)/i);
    // One function and its grants: no table, policy, trigger or drop.
    expect(code).not.toMatch(/\b(create table|alter table|create policy|create trigger|drop )\b/i);
  });

  // KEEP IN STEP with src/lib/ai/key-crypto.ts: the database must take every value the app can seal.
  test('takes every sealed value the app can produce, and the cap leaves room', () => {
    const pattern = /p_ciphertext ~ '([^']+)'/.exec(fn)?.[1];
    const cap = Number(/length\(p_ciphertext\) > (\d+)/.exec(fn)?.[1]);
    expect(pattern).toBeDefined();
    // The pattern uses nothing that reads differently in JavaScript.
    const shape = new RegExp(pattern!);
    const env = { AI_KEYS_ENCRYPTION_SECRET: 'a-secret-used-only-by-this-test-0123456789' };
    const org = '11111111-1111-4111-8111-111111111111';

    const longest = `sk-or-${'k'.repeat(300)}`;
    const shortest = `sk-or-${'k'.repeat(16)}`;
    expect(isOpenRouterKeyShape(longest)).toBe(true);
    expect(isOpenRouterKeyShape(`${longest}k`)).toBe(false);
    expect(isOpenRouterKeyShape(shortest)).toBe(true);

    const sealedLongest = encryptApiKey(longest, org, env);
    const sealedShortest = encryptApiKey(shortest, org, env);
    // v2. + 16 (iv) + . + 22 (tag) + . + 408 (306 bytes in base64url)
    expect(sealedLongest).toHaveLength(451);
    expect(sealedShortest).toHaveLength(43 + 30);
    for (const sealed of [sealedLongest, sealedShortest]) {
      expect(shape.test(sealed)).toBe(true);
      expect(sealed.length).toBeLessThanOrEqual(cap);
    }
    expect(cap).toBe(2000);

    for (const bad of ['x', '', sealedShortest.replace(/^v2/, 'v1'), `${sealedShortest}=`, `${sealedShortest}.x`, 'v2.short.short.x']) {
      expect(shape.test(bad), bad).toBe(false);
    }
  });
});

describe('regular expressions in the migrations', () => {
  test('the check finds a bound above 255 in each of its forms, and nothing at or under it', () => {
    expect(boundsAbove("x ~ '^a{1,1900}$'")).toEqual(['{1,1900}']);
    expect(boundsAbove("x ~ '^a{256}$' or y ~ 'b{300,}' or z ~ 'c{0,256}'")).toEqual(['{256}', '{300,}', '{0,256}']);
    expect(boundsAbove("x ~ '^a{255}b{1,255}c{16}d{2,}$'")).toEqual([]);
    expect(boundsAbove("select '{}'::jsonb, '{1,2,3}'::int[], 'x{1, 1900}'")).toEqual([]);
  });

  test('every function body is read to its end', () => {
    const functions = newestFunctions();
    expect(functions.size).toBeGreaterThan(100);
    const unread = [...functions].filter(([, f]) => f.text === '').map(([name, f]) => `${name} (${f.file})`);
    expect(unread).toEqual([]);
  });

  /**
   * The fault this file exists for: a function whose pattern the database
   * cannot compile is created without complaint and fails on every call.
   *
   * Simple on purpose. It reads any `{n}`, `{n,}` or `{n,m}` with a number
   * above 255 inside a function's text as a regex bound, without working out
   * whether it sits in a pattern, so a body that needs such text for another
   * reason (a JSON or array literal, say) would have to be written another
   * way or named here. It does not see a pattern assembled at run time.
   */
  test('the newest definition of every function has no repetition bound above 255', () => {
    const faults = [...newestFunctions()]
      .map(([name, f]) => ({ name, file: f.file, bounds: boundsAbove(f.text) }))
      .filter((f) => f.bounds.length > 0)
      .map((f) => `${f.name} in ${f.file}: ${f.bounds.join(', ')}`);
    expect(faults).toEqual([]);
  });

  /**
   * The same text anywhere else in a migration: a check constraint, a policy,
   * a plain statement, an earlier overload. The one file known to hold it is
   * applied and stays as written; its function is replaced by FILE. This list
   * is closed: a new migration with such a bound fails here.
   */
  test('no migration holds such a bound at all, apart from the one already applied', () => {
    const holding = files.filter((file) => boundsAbove(statements(file)).length > 0);
    expect(holding).toEqual([BROKEN]);
    expect(boundsAbove(statements(BROKEN))).toEqual(['{1,1900}']);
  });
});
