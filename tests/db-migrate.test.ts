import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrationFiles, migrationSql, pendingMigrations } from '../scripts/db-migrate.mjs';

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
      { file: '20261011090000_reach_foundation.sql', version: '20261011090000', name: 'reach_foundation' },
      { file: '20261102083000_kasturi_invoice_links.sql', version: '20261102083000', name: 'kasturi_invoice_links' },
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
});
