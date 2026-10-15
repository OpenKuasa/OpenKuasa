import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');

/**
 * Migrations that share a version with another file. They were written in
 * parallel and are already applied, so they keep their names. This list is
 * closed: a new migration takes a version no other file has.
 */
const KNOWN_SHARED_VERSIONS: Record<string, string[]> = {
  '20261012160000': ['20261012160000_agent_runs.sql', '20261012160000_bendahara_purchases.sql'],
  '20261012170000': ['20261012170000_agent_assets_storage_policy.sql', '20261012170000_bendahara_foundation.sql'],
  '20261013090000': ['20261013090000_agent_schedules.sql', '20261013090000_hire_foundation.sql'],
};

/** The files that share a version, by version; `allowed` are the ones permitted to. */
export function sharedVersionProblems(files: string[], allowed: Record<string, string[]>): string[] {
  const byVersion = new Map<string, string[]>();
  for (const file of files) {
    const version = file.slice(0, 14);
    byVersion.set(version, [...(byVersion.get(version) ?? []), file]);
  }
  const problems: string[] = [];
  for (const [version, sharing] of byVersion) {
    if (sharing.length < 2) continue;
    const unexpected = sharing.filter((file) => !(allowed[version] ?? []).includes(file));
    if (unexpected.length > 0) {
      problems.push(`${unexpected.join(', ')}: version ${version} is already used by another migration`);
    }
  }
  return problems;
}

describe('migration versions', () => {
  const files = readdirSync(DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  test('every migration is named <14-digit version>_<name>.sql', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(file).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });

  test('no migration reuses a version, apart from the known earlier pairs', () => {
    expect(sharedVersionProblems(files, KNOWN_SHARED_VERSIONS)).toEqual([]);
  });

  test('the check catches a new file on a used version, including a third on a known pair', () => {
    expect(sharedVersionProblems(['20270101000000_a.sql', '20270101000000_b.sql'], KNOWN_SHARED_VERSIONS)).toEqual([
      '20270101000000_a.sql, 20270101000000_b.sql: version 20270101000000 is already used by another migration',
    ]);
    expect(
      sharedVersionProblems(
        [...KNOWN_SHARED_VERSIONS['20261013090000'], '20261013090000_something_new.sql'],
        KNOWN_SHARED_VERSIONS,
      ),
    ).toEqual(['20261013090000_something_new.sql: version 20261013090000 is already used by another migration']);
    // A single file on a known-pair version, passed alone, is not a reuse.
    expect(sharedVersionProblems(['20261013090000_agent_schedules.sql'], KNOWN_SHARED_VERSIONS)).toEqual([]);
  });

  test('the known pairs are exactly three, two files each', () => {
    expect(Object.keys(KNOWN_SHARED_VERSIONS)).toHaveLength(3);
    for (const [version, pair] of Object.entries(KNOWN_SHARED_VERSIONS)) {
      expect(pair).toHaveLength(2);
      for (const file of pair) expect(file.startsWith(`${version}_`)).toBe(true);
    }
  });
});
