#!/usr/bin/env node
/**
 * Applies `supabase/migrations` straight to a local Postgres, for the Docker
 * setup. (`db-migrate.mjs` is the hosted-Supabase tool and talks to the
 * Management API; this one talks to the database itself.)
 *
 *   node scripts/migrate-local.mjs
 *
 * Reads POSTGRES_PASSWORD (required) and POSTGRES_HOST, POSTGRES_PORT,
 * POSTGRES_DB (default db, 5432, postgres) from the environment.
 *
 * It uses the same bookkeeping as db-migrate.mjs: the same tracking table,
 * the same "which files are pending" rules, and each file runs in one
 * transaction together with its record. A file that fails is rolled back
 * whole and named, and the run stops there with exit code 1.
 *
 * A file that hits a lock conflict (55P03, `lock ... nowait` while another
 * Supabase service is reading the schema) is rolled back and sent again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  TRACKING_TABLE,
  migrationFiles,
  migrationSql,
  pendingMigrations,
  recordVersion,
} from './db-migrate.mjs';

const MIGRATIONS = fileURLToPath(new URL('../supabase/migrations', import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Postgres refused a lock it was told not to wait for. Worth another try. */
export function isLockConflict(error) {
  return error?.code === '55P03';
}

/** The URL of the database in the Docker network. */
export function connectionString(env) {
  const password = encodeURIComponent(env.POSTGRES_PASSWORD);
  const host = env.POSTGRES_HOST ?? 'db';
  const port = env.POSTGRES_PORT ?? 5432;
  const database = env.POSTGRES_DB ?? 'postgres';
  return `postgres://postgres:${password}@${host}:${port}/${database}`;
}

/**
 * Applies the pending migrations, oldest first. `client.query(sql)` resolves
 * to `{ rows }`. A lock conflict is retried up to `retries` times; any other
 * failure stops the run at once. Either way the failed file is rolled back.
 */
export async function applyPending({
  client,
  dir = MIGRATIONS,
  readSql = (file) => readFileSync(join(dir, file), 'utf8'),
  log = console.log,
  retries = 5,
  pauseMs = 1000,
}) {
  await client.query(TRACKING_TABLE);
  const { rows } = await client.query('select version, name from supabase_migrations.schema_migrations');
  const files = migrationFiles(dir);
  const pending = pendingMigrations(files, rows);

  let applied = 0;
  for (const m of pending) {
    const sql = migrationSql(m, readSql(m.file), recordVersion(m, files));
    for (let attempt = 0; ; attempt += 1) {
      try {
        await client.query(sql);
        break;
      } catch (error) {
        // The failed batch leaves the transaction open and aborted.
        await client.query('rollback').catch(() => {});
        if (isLockConflict(error) && attempt < retries) {
          log(`Retrying ${m.file}: ${error.message ?? 'lock conflict'}`);
          await sleep(pauseMs);
          continue;
        }
        throw new Error(`Migration ${m.file} failed: ${error?.message ?? error}`);
      }
    }
    applied += 1;
    log(`Applied ${m.file}`);
  }
  return { applied };
}

async function main() {
  if (!process.env.POSTGRES_PASSWORD) throw new Error('Set POSTGRES_PASSWORD.');
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: connectionString(process.env) });
  await client.connect();
  try {
    const { applied } = await applyPending({ client });
    console.log(applied === 0 ? 'Database is up to date.' : `Applied ${applied} migration(s).`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
