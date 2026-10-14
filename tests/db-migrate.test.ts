import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  migrationFiles,
  migrationSql,
  parseRows,
  pendingMigrations,
  readEnvFile,
  recordVersion,
} from '../scripts/db-migrate.mjs';

type Migration = { file: string; version: string; name: string };

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('migrationFiles', () => {
  it('lists the .sql migrations oldest first, with version and name', () => {
    dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    for (const f of ['20261102083000_kasturi_invoice_links.sql', '20261011090000_reach_foundation.sql', 'README.md']) {
      writeFileSync(join(dir, f), '');
    }
    expect(migrationFiles(dir)).toEqual([
      {
        file: '20261011090000_reach_foundation.sql',
        version: '20261011090000',
        name: 'reach_foundation',
      },
      {
        file: '20261102083000_kasturi_invoice_links.sql',
        version: '20261102083000',
        name: 'kasturi_invoice_links',
      },
    ]);
  });

  it('reads the repo migrations', () => {
    const files: Migration[] = migrationFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files.map((f) => f.version)).toEqual([...files.map((f) => f.version)].sort());
  });
});

describe('pendingMigrations', () => {
  const files: Migration[] = [
    { file: 'a', version: '20261011090000', name: 'reach_foundation' },
    { file: 'b', version: '20261102083000', name: 'kasturi_invoice_links' },
    { file: 'c', version: '20261117100000', name: 'bendahara_save_voucher' },
  ];

  it('counts a migration as applied by its version or by its name', () => {
    const recorded = [
      // Recorded under another version, as the first migrations were.
      { version: '20261011055738', name: 'reach_foundation' },
      { version: '20261102083000', name: null },
    ];
    expect(pendingMigrations(files, recorded).map((f: Migration) => f.name)).toEqual(['bendahara_save_voucher']);
  });

  it('is everything for an empty project', () => {
    expect(pendingMigrations(files, [])).toHaveLength(3);
  });

  it('does not take a later file that reuses a name as applied', () => {
    const reused = [...files, { file: 'd', version: '20261201090000', name: 'reach_foundation' }];
    const recorded = [{ version: '20261011055738', name: 'reach_foundation' }];
    expect(pendingMigrations(reused, recorded).map((f: Migration) => f.file)).toEqual(['b', 'c', 'd']);
  });
});

describe('two files sharing a version', () => {
  const pair = (): Migration[] => {
    dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    for (const f of [
      '20261012160000_bendahara_purchases.sql',
      '20261012160000_agent_runs.sql',
      '20261012160100_seed.sql',
    ]) {
      writeFileSync(join(dir, f), '');
    }
    return migrationFiles(dir);
  };

  it('records the later file under a version of its own, so both fit the primary key', () => {
    const files = pair();
    expect(files.map((f) => f.name)).toEqual(['agent_runs', 'bendahara_purchases', 'seed']);
    expect(files.map((f) => recordVersion(f, files))).toEqual([
      '20261012160000',
      '20261012160000_bendahara_purchases',
      '20261012160100',
    ]);
  });

  it('applies both on a fresh project, and neither again once recorded', () => {
    const files = pair();
    const first: Migration[] = pendingMigrations(files, []);
    expect(first).toHaveLength(3);
    // What a fresh --apply writes: one record each, no two with one version.
    const recorded: { version: string; name: string }[] = first.map((f) => ({
      version: recordVersion(f, files),
      name: f.name,
    }));
    expect(new Set(recorded.map((r) => r.version)).size).toBe(3);
    expect(pendingMigrations(files, recorded)).toEqual([]);
  });

  it('still applies the other file when only one of the pair is recorded under the shared version', () => {
    const files = pair();
    const recorded = [{ version: '20261012160000', name: 'agent_runs' }];
    expect(pendingMigrations(files, recorded).map((f: Migration) => f.name)).toEqual(['bendahara_purchases', 'seed']);
  });

  it('records each repo pair under distinct versions', () => {
    const files: Migration[] = migrationFiles();
    const versions = files.map((f) => recordVersion(f, files));
    expect(new Set(versions).size).toBe(files.length);
  });
});

describe('readEnvFile', () => {
  it('reads the file alone, whatever the shell has exported', () => {
    dir = mkdtempSync(join(tmpdir(), 'env-'));
    const path = join(dir, '.env.local');
    writeFileSync(
      path,
      '# comment\nNEXT_PUBLIC_SUPABASE_URL="https://fromfile.supabase.co"\r\nOPENKUASA_SUPABASE_TOKEN=abc\n',
    );
    const before = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fromshell.supabase.co';
    try {
      expect(readEnvFile(path)).toEqual({
        NEXT_PUBLIC_SUPABASE_URL: 'https://fromfile.supabase.co',
        OPENKUASA_SUPABASE_TOKEN: 'abc',
      });
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = before;
    }
  });

  it('is empty when there is no file', () => {
    expect(readEnvFile(join(tmpdir(), 'no-such-dir', '.env.local'))).toEqual({});
  });
});

describe('parseRows', () => {
  it('takes an empty body as no rows, not a failure', () => {
    expect(parseRows('')).toEqual([]);
    expect(parseRows('[{"tracked":true}]')).toEqual([{ tracked: true }]);
  });
});

describe('migrationSql', () => {
  it('applies the file and records it in one transaction', () => {
    const sql: string = migrationSql({ file: 'x', version: '20261117100000', name: "o'brien" }, 'create table t ();');
    expect(sql.startsWith('begin;\ncreate table t ();')).toBe(true);
    expect(sql).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('20261117100000', 'o''brien');",
    );
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
  });

  it('records under the version it is given', () => {
    const m = {
      file: 'x',
      version: '20261012160000',
      name: 'bendahara_purchases',
    };
    expect(migrationSql(m, 'select 1;', '20261012160000_bendahara_purchases')).toContain(
      "values ('20261012160000_bendahara_purchases', 'bendahara_purchases');",
    );
  });
});
