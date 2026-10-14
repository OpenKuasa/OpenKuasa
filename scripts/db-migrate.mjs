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
 * has its version, or, for the first migrations, which were recorded under
 * versions no file carries, its name. See pendingMigrations.
 *
 * A few early migrations share a version with another file (see
 * tests/migration-versions.test.ts). The version is the table's primary key,
 * so the later file of such a pair is recorded as `<version>_<name>`, which no
 * file carries and so is matched by name like the first migrations.
 *
 * `.env.local` decides the project: the variables below are read from it
 * alone, never from the shell, and --apply asks you to type the project ref
 * before it writes anything.
 *
 * Each migration runs in one transaction together with its record, so it is
 * applied whole or not at all. The run stops at the first one that fails.
 * Supabase's rate limit (429) refuses a request before anything runs, so that
 * one is waited out and sent again.
 *
 * Needs OPENKUASA_SUPABASE_TOKEN (a Supabase access token, see .env.example)
 * and NEXT_PUBLIC_SUPABASE_URL in `.env.local`. It talks to the Management API,
 * so no database password is needed. Without a terminal to type the ref into,
 * pass it as `--confirm=<ref>`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const FILE = /^(\d+)_(.+)\.sql$/;
/** Between requests, to stay under the Management API's rate limit. */
const PAUSE_MS = 1500;
const MAX_RETRIES = 8;

/**
 * The KEY=value lines of an env file. Nothing is taken from process.env: the
 * shell may export another project's variables (the live tests need them),
 * and the file is what decides which database gets written to.
 */
export function readEnvFile(path = join(ROOT, '.env.local')) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

/** The migration files, oldest first. */
export function migrationFiles(dir = MIGRATIONS) {
  return readdirSync(dir)
    .map((file) => file.match(FILE))
    .filter(Boolean)
    .map(([file, version, name]) => ({ file, version, name }))
    .sort((a, b) => a.version.localeCompare(b.version) || a.name.localeCompare(b.name));
}

/**
 * The files the project has not had. Version first: a record whose version a
 * file carries counts for that file (for a shared version, the file with the
 * record's name). Only a record whose version no file carries, as the first
 * migrations were recorded, is matched by name, and then to the oldest file of
 * that name not already counted, so a later file reusing a name is not taken
 * as applied.
 */
export function pendingMigrations(files, recorded) {
  const byVersion = new Map();
  for (const f of files) byVersion.set(f.version, [...(byVersion.get(f.version) ?? []), f]);
  const applied = new Set();
  const byName = [];
  for (const r of recorded) {
    const same = byVersion.get(r.version);
    if (!same) {
      byName.push(r);
      continue;
    }
    const match = same.length === 1 ? same[0] : same.find((f) => f.name === r.name);
    if (match) applied.add(match);
  }
  for (const r of byName) {
    const match = r.name && files.find((f) => f.name === r.name && !applied.has(f));
    if (match) applied.add(match);
  }
  return files.filter((f) => !applied.has(f));
}

/**
 * The version a migration is recorded under: its own, unless an earlier file
 * shares it and so holds the primary key, then `<version>_<name>`.
 */
export function recordVersion(migration, files) {
  const first = files.find((f) => f.version === migration.version);
  return !first || first.name === migration.name ? migration.version : `${migration.version}_${migration.name}`;
}

const literal = (s) => `'${s.replace(/'/g, "''")}'`;

/** One migration and its record, as a single transaction. */
export function migrationSql(migration, sql, version = migration.version) {
  return [
    'begin;',
    sql,
    ';',
    `insert into supabase_migrations.schema_migrations (version, name) values (${literal(version)}, ${literal(migration.name)});`,
    'commit;',
  ].join('\n');
}

/** A query response as rows; a DDL batch can answer with an empty body and still have committed. */
export function parseRows(text) {
  return text.trim() ? JSON.parse(text) : [];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function client(ref, token) {
  return async function query(sql) {
    for (let attempt = 0; ; attempt += 1) {
      await sleep(PAUSE_MS);
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
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
      return parseRows(text);
    }
  };
}

/** Created as the Supabase CLI creates it, for a project it has never touched. */
const TRACKING_TABLE = `create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text);`;

/** --apply goes ahead only once the project ref has been typed, or passed as --confirm=<ref>. */
async function confirmed(ref) {
  const given = process.argv.find((a) => a.startsWith('--confirm='))?.slice('--confirm='.length);
  if (given !== undefined) return given === ref;
  if (!process.stdin.isTTY) {
    console.error(`No terminal to confirm in. Run again with --confirm=${ref} to apply to this project.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Type the project ref (${ref}) to apply to it: `);
  rl.close();
  return answer.trim() === ref;
}

async function main() {
  const env = readEnvFile();
  const apply = process.argv.includes('--apply');
  const token = env.OPENKUASA_SUPABASE_TOKEN;
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const ref = url?.match(/^https:\/\/([^.]+)\.supabase\.co/)?.[1];
  if (!token || !ref) {
    console.error('Set OPENKUASA_SUPABASE_TOKEN and NEXT_PUBLIC_SUPABASE_URL in .env.local.');
    process.exit(1);
  }
  const shellUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (shellUrl && shellUrl !== url) {
    console.log(`Your shell has NEXT_PUBLIC_SUPABASE_URL=${shellUrl}; using the one in .env.local.`);
  }

  const query = client(ref, token);
  const [{ tracked }] = await query(
    "select to_regclass('supabase_migrations.schema_migrations') is not null as tracked",
  );
  const recorded = tracked ? await query('select version, name from supabase_migrations.schema_migrations') : [];
  const files = migrationFiles();
  const pending = pendingMigrations(files, recorded);

  console.log(`Project ${ref} (${url}): ${pending.length} migration(s) to apply.`);
  if (!tracked) console.log('It has no supabase_migrations.schema_migrations yet; --apply creates it.');
  for (const m of pending) console.log(`  ${m.version} ${m.name}`);
  if (pending.length === 0 || !apply) {
    if (pending.length > 0) console.log('\nNothing changed. Run with --apply to apply them.');
    return;
  }

  console.log('');
  if (!(await confirmed(ref))) {
    console.error('Not confirmed. Nothing changed.');
    process.exit(1);
  }
  if (!tracked) await query(TRACKING_TABLE);
  for (const m of pending) {
    const started = Date.now();
    try {
      await query(migrationSql(m, readFileSync(join(MIGRATIONS, m.file), 'utf8'), recordVersion(m, files)));
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
