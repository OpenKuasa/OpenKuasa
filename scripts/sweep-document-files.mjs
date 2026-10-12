#!/usr/bin/env node
/**
 * Finds and removes document files that no document carries (an upload that was never attached, or the files of an
 * employee or workspace that was deleted). Run on demand by an operator: nothing schedules it.
 *
 *   node scripts/sweep-document-files.mjs             dry run: lists, per workspace folder; changes nothing
 *   node scripts/sweep-document-files.mjs --remove    releases and removes
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment (it reads no env file).
 *
 * How it stays safe:
 * - Workspace folders come from the bucket's own top level, not from the `orgs` table, so the files of a workspace
 *   that no longer exists are found.
 * - The dry run only calls `hr_orphaned_document_files(p_org)`, which lists and changes nothing.
 * - `--remove` loops `hr_release_orphaned_document_files(p_org, p_limit)`, which re-checks each path under a lock,
 *   marks it released so no document can ever carry it, and returns it. ONLY the paths that call returns are
 *   removed, one at a time and only if they have the exact shape the app makes and sit in that workspace's folder.
 *   What the listing said is never what is removed.
 * - A round that removes nothing ends the workspace, and a workspace is limited to `maxRounds` rounds.
 *
 * The functions are exported over an injected client so they can be tested; the command line is the last block.
 */
import { pathToFileURL } from 'node:url';

export const BUCKET = 'hr-documents';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Exactly what the app makes (`documentPath`) and the database accepts. KEEP IN STEP with src/lib/people/document-files.ts. */
export const PATH_SHAPE = new RegExp(`^${UUID}/${UUID}/${UUID}\\.(pdf|jpg|png|webp|heic)$`);
const FOLDER_SHAPE = new RegExp(`^${UUID}$`);
const PAGE = 100;
const RELEASE_LIMIT = 500;
const MAX_ROUNDS = 100;

/** @param {string[]} argv */
export function parseArgs(argv) {
  let remove = false;
  for (const arg of argv) {
    if (arg === '--remove') remove = true;
    else if (arg === '--dry-run') remove = false;
    else throw new Error('Unknown option. Use --remove, or nothing for a dry run.');
  }
  return { remove };
}

/** The workspace folders at the top of the bucket (lower-case uuids only), read page by page. */
export async function listWorkspaceFolders(client) {
  const folders = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await client.storage.from(BUCKET).list('', { limit: PAGE, offset });
    if (error || !Array.isArray(data)) throw new Error('The bucket could not be listed.');
    for (const entry of data) if (typeof entry?.name === 'string' && FOLDER_SHAPE.test(entry.name)) folders.push(entry.name);
    if (data.length < PAGE) return folders;
  }
}

/** A name from a `setof text` reply: PostgREST sends strings, but one key of an object is accepted too. */
function nameOf(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    const values = Object.values(item);
    if (values.length === 1 && typeof values[0] === 'string') return values[0];
  }
  return '';
}

/**
 * @typedef {{ remove: boolean, log?: (line: string) => void, maxRounds?: number }} SweepOptions
 */

/**
 * One workspace's folder. Dry run: lists. Remove: releases, then removes what the release returned, until a call
 * returns nothing or removes nothing. Returns counts; an error is reported by its code only.
 */
export async function sweepWorkspace(client, org, /** @type {SweepOptions} */ { remove, log = console.log, maxRounds = MAX_ROUNDS }) {
  const result = { org, listed: null, removed: 0, failed: 0, skipped: 0, rounds: 0, error: null };

  if (!remove) {
    const { data, error } = await client.rpc('hr_orphaned_document_files', { p_org: org });
    if (error) {
      result.error = error.code ?? 'error';
      log(`${org}: could not be listed (code ${result.error})`);
      return result;
    }
    const names = (Array.isArray(data) ? data : []).map(nameOf).filter((name) => name !== '');
    result.listed = names.length;
    log(`${org}: ${names.length} file(s) with no document`);
    for (const name of names) log(`  ${name}`);
    return result;
  }

  for (let round = 0; round < maxRounds; round += 1) {
    const { data, error } = await client.rpc('hr_release_orphaned_document_files', { p_org: org, p_limit: RELEASE_LIMIT });
    if (error) {
      result.error = error.code ?? 'error';
      break;
    }
    const returned = Array.isArray(data) ? data.map(nameOf) : [];
    if (returned.length === 0) break;
    result.rounds += 1;
    let progress = 0;
    for (const path of returned) {
      // The remove runs with the service role: only a path of the exact shape, inside this workspace's folder.
      if (!PATH_SHAPE.test(path) || !path.startsWith(`${org}/`)) {
        result.skipped += 1;
        continue;
      }
      let removedOne = false;
      try {
        const { error: removeError } = await client.storage.from(BUCKET).remove([path]);
        removedOne = !removeError;
      } catch {
        removedOne = false;
      }
      if (removedOne) {
        result.removed += 1;
        progress += 1;
      } else {
        result.failed += 1;
      }
    }
    if (progress === 0) break;
  }
  if (result.error) log(`${org}: the release was refused (code ${result.error})`);
  log(`${org}: removed ${result.removed}, failed ${result.failed}, skipped ${result.skipped}`);
  return result;
}

/** Every workspace folder in the bucket, one after another. A refusal for one does not stop the rest. */
export async function runSweep(client, /** @type {SweepOptions} */ { remove, log = console.log, maxRounds }) {
  log(remove ? 'Removing document files that no document carries.' : 'Dry run: nothing is changed. Use --remove to remove.');
  const folders = await listWorkspaceFolders(client);
  const workspaces = [];
  for (const org of folders) workspaces.push(await sweepWorkspace(client, org, { remove, log, maxRounds }));
  if (folders.length === 0) log('The bucket has no workspace folders.');
  return { workspaces };
}

async function main() {
  const { remove } = parseArgs(process.argv.slice(2));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  await runSweep(client, { remove });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'The sweep failed.');
    process.exit(1);
  });
}
