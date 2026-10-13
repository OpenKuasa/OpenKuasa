#!/usr/bin/env node
/**
 * Brings the Supabase project in `.env.local` up to date with
 * `supabase/migrations`.
 *
 *   pnpm db:migrate           list the migrations the project has not had; change nothing
 *   pnpm db:migrate --apply   apply them, oldest first
 *
 * Run it after every pull from main: code that needs a column the database
 * does not have yet fails, and some pages then quietly show their samples.
 *
 * A migration counts as applied when `supabase_migrations.schema_migrations`
 * has its version or its name. The first migrations were recorded under other
 * versions than their files carry, so the name has to count too.
 *
 * Each migration runs in one transaction together with its record, so it is
 * applied whole or not at all. The run stops at the first one that fails.
 * Supabase's rate limit (429) refuses a request before anything runs, so that
 * one is waited out and sent again.
 *
 * Needs OPENKUASA_SUPABASE_TOKEN (a Supabase access token, see .env.example)
 * and NEXT_PUBLIC_SUPABASE_URL. It talks to the Management API, so no database
 * password is needed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const FILE = /^(\d+)_(.+)\.sql$/;
/** Between requests, to stay under the Management API's rate limit. */
const PAUSE_MS = 1500;
const MAX_RETRIES = 8;

/** Reads `.env.local` into process.env without overriding what is already set. */
function loadEnv() {
  let text;
  try {
    text = readFileSync(join(ROOT, '.env.local'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

/** The migration files, oldest first. */
export function migrationFiles(dir = MIGRATIONS) {
  return readdirSync(dir)
    .map((file) => file.match(FILE))
    .filter(Boolean)
    .map(([file, version, name]) => ({ file, version, name }))
    .sort((a, b) => a.version.localeCompare(b.version));
}

/** The files the project has neither the version nor the name of. */
export function pendingMigrations(files, recorded) {
  const versions = new Set(recorded.map((r) => r.version));
  const names = new Set(recorded.map((r) => r.name).filter(Boolean));
  return files.filter((f) => !versions.has(f.version) && !names.has(f.name));
}

const literal = (s) => `'${s.replace(/'/g, "''")}'`;

/** One migration and its record, as a single transaction. */
export function migrationSql(migration, sql) {
  return [
    'begin;',
    sql,
    ';',
    `insert into supabase_migrations.schema_migrations (version, name) values (${literal(migration.version)}, ${literal(migration.name)});`,
    'commit;',
  ].join('\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function client(ref, token) {
  return async function query(sql) {
    for (let attempt = 0; ; attempt += 1) {
      await sleep(PAUSE_MS);
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql }),
      });
      const text = await res.text();
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const wait = 15 * (attempt + 1);
        console.log(`  rate limited, waiting ${wait}s`);
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 2000)}`);
      return JSON.parse(text);
    }
  };
}

async function main() {
  loadEnv();
  const apply = process.argv.includes('--apply');
  const token = process.env.OPENKUASA_SUPABASE_TOKEN;
  const ref = process.env.NEXT_PUBLIC_SUPABASE_URL?.match(/^https:\/\/([^.]+)\.supabase\.co/)?.[1];
  if (!token || !ref) {
    console.error('Set OPENKUASA_SUPABASE_TOKEN and NEXT_PUBLIC_SUPABASE_URL in .env.local.');
    process.exit(1);
  }

  const query = client(ref, token);
  const recorded = await query('select version, name from supabase_migrations.schema_migrations');
  const pending = pendingMigrations(migrationFiles(), recorded);

  console.log(`Project ${ref}: ${pending.length} migration(s) to apply.`);
  for (const m of pending) console.log(`  ${m.version} ${m.name}`);
  if (pending.length === 0 || !apply) {
    if (pending.length > 0) console.log('\nNothing changed. Run with --apply to apply them.');
    return;
  }

  console.log('');
  for (const m of pending) {
    const started = Date.now();
    try {
      await query(migrationSql(m, readFileSync(join(MIGRATIONS, m.file), 'utf8')));
    } catch (error) {
      console.error(`FAIL  ${m.version} ${m.name}\n${error.message}`);
      console.error('\nThis one was rolled back; the ones before it are applied. Fix it and run again.');
      process.exit(1);
    }
    console.log(`ok    ${m.version} ${m.name} (${Date.now() - started}ms)`);
  }
  console.log('\nAll applied.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
