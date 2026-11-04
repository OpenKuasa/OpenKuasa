import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { applyPending, clientConfig, connectionString, isLockConflict } from '../scripts/migrate-local.mjs';

type Step = { match: RegExp; error?: unknown; once?: boolean };

/** A client that records every query; `steps` script which ones throw. */
function fakeClient(recorded: { version: string; name: string }[] = [], steps: Step[] = []) {
  const sent: string[] = [];
  const used = new Set<Step>();
  return {
    sent,
    async query(sql: string) {
      sent.push(sql);
      if (sql.includes('from supabase_migrations.schema_migrations') && sql.startsWith('select')) {
        return { rows: recorded };
      }
      for (const step of steps) {
        if (!step.match.test(sql) || used.has(step)) continue;
        if (step.once) used.add(step);
        throw step.error;
      }
      return { rows: [] };
    },
  };
}

const files = {
  '20261001000000_one.sql': 'create table one();',
  '20261002000000_two.sql': 'create table two();',
  '20261003000000_three.sql': 'create table three();',
};
const readSql = (file: string) => files[file as keyof typeof files] ?? `-- ${file}`;
const run = (client: ReturnType<typeof fakeClient>, extra: Record<string, unknown> = {}) =>
  applyPending({ client, dir: '/nowhere', readSql, log: () => {}, pauseMs: 0, ...extra });

// applyPending lists the directory itself, so give it a fixed set of names.
function dirWith(names: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-local-'));
  for (const n of names) writeFileSync(join(dir, n), '');
  return dir;
}
const applies = (client: ReturnType<typeof fakeClient>) => client.sent.filter((s) => s.startsWith('begin;'));
const three = Object.keys(files);

describe('applyPending', () => {
  test('applies pending files oldest first and skips recorded ones', async () => {
    const client = fakeClient([{ version: '20261001000000', name: 'one' }]);
    const result = await run(client, { dir: dirWith(three) });
    expect(result.applied).toBe(2);
    const sent = applies(client);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('create table two();');
    expect(sent[1]).toContain('create table three();');
  });

  test('records the later file of a shared version under its own version', async () => {
    const names = ['20261012160000_agent_runs.sql', '20261012160000_bendahara_purchases.sql'];
    const client = fakeClient();
    await run(client, { dir: dirWith(names) });
    const sent = applies(client);
    expect(sent[0]).toContain("values ('20261012160000', 'agent_runs')");
    expect(sent[1]).toContain("values ('20261012160000_bendahara_purchases', 'bendahara_purchases')");
  });

  test('retries a file that hit a lock conflict, then carries on', async () => {
    const client = fakeClient([], [{ match: /create table two/, error: { code: '55P03' }, once: true }]);
    const result = await run(client, { dir: dirWith(three) });
    expect(result.applied).toBe(3);
    const two = client.sent.map((s, i) => (s.includes('create table two') ? i : -1)).filter((i) => i >= 0);
    expect(two).toHaveLength(2);
    expect(client.sent[two[0] + 1]).toBe('rollback');
    expect(applies(client)).toHaveLength(4);
  });

  test('stops at the first real failure and names the file', async () => {
    const error = { code: '42P01', message: 'relation x does not exist' };
    const client = fakeClient([], [{ match: /create table two/, error }]);
    await expect(run(client, { dir: dirWith(three) })).rejects.toThrow(
      /Migration .*_two\.sql failed: relation x does not exist/,
    );
    expect(client.sent.some((s) => s.includes('create table three'))).toBe(false);
    expect(client.sent).toContain('rollback');
  });

  test('gives up after the retry limit', async () => {
    const client = fakeClient([], [{ match: /create table one/, error: { code: '55P03', message: 'locked' } }]);
    await expect(run(client, { dir: dirWith(three), retries: 2 })).rejects.toThrow(/_one\.sql failed: locked/);
    expect(client.sent.filter((s) => s.includes('create table one'))).toHaveLength(3);
  });
});

describe('isLockConflict', () => {
  test('is true only for 55P03', () => {
    expect(isLockConflict({ code: '55P03' })).toBe(true);
    expect(isLockConflict({ code: '42P01' })).toBe(false);
    expect(isLockConflict(undefined)).toBe(false);
  });
});

describe('connectionString', () => {
  test('builds a connection string with an encoded password', () => {
    expect(connectionString({ POSTGRES_PASSWORD: 'p@ss/w' })).toBe('postgres://postgres:p%40ss%2Fw@db:5432/postgres');
  });

  test('honours host, port and database', () => {
    expect(
      connectionString({ POSTGRES_PASSWORD: 'x', POSTGRES_HOST: 'h', POSTGRES_PORT: '1', POSTGRES_DB: 'd' }),
    ).toBe('postgres://postgres:x@h:1/d');
  });
});

describe('clientConfig', () => {
  const online = 'postgresql://postgres.abc:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres';

  test('uses DATABASE_URL for an online Supabase, encrypted', () => {
    expect(clientConfig({ DATABASE_URL: online, POSTGRES_PASSWORD: 'local' })).toEqual({
      connectionString: online,
      ssl: { rejectUnauthorized: false },
    });
  });

  test('leaves encryption to the URL when it names an sslmode', () => {
    const strict = `${online}?sslmode=verify-full`;
    expect(clientConfig({ DATABASE_URL: strict })).toEqual({ connectionString: strict });
  });

  test('falls back to the Docker database without DATABASE_URL', () => {
    expect(clientConfig({ POSTGRES_PASSWORD: 'x' })).toEqual({ connectionString: 'postgres://postgres:x@db:5432/postgres' });
  });

  test('says what to set when there is neither', () => {
    expect(() => clientConfig({ DATABASE_URL: ' ' })).toThrow(/Set DATABASE_URL .* or POSTGRES_PASSWORD/);
  });
});
