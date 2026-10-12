#!/usr/bin/env node
/**
 * Finds and removes files nothing points at, in two buckets: document files that no document carries (an upload
 * that was never attached, or the files of an employee or workspace that was deleted), and logo files that are no
 * workspace's logo (an upload never set, a replaced or removed logo whose removal failed, a deleted workspace's
 * logo; each only once it is a day old). Run on demand by an operator: nothing schedules it.
 *
 *   node scripts/sweep-document-files.mjs             dry run: counts (per workspace folder for documents); changes nothing
 *   node scripts/sweep-document-files.mjs --verbose    dry run that also prints each path (ids only, but they reach shell logs)
 *   node scripts/sweep-document-files.mjs --remove     removes (counts only)
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment (it reads no env file).
 *
 * Without a shell, the same sweep (removing, at most 500 files a call, counts only in the reply) is:
 *   curl -X POST https://<the app>/api/maintenance/sweep-files -H "Authorization: Bearer $CRON_SECRET"
 * (the credential `/api/agents/run` takes; add the call to the same external cron, once a day is plenty).
 *
 * The sweep itself, and how it stays safe, is in src/lib/maintenance/sweep-files.mjs, which the route runs too.
 * Two things to know when running it by hand:
 * - Document files that cannot be removed (the storage call fails) are handed back first on the next run, 500 at a
 *   time, so a workspace with 500 or more of them stops there: deal with those by hand before the files after them
 *   are reached.
 * - A logo file is listed only after a day, so an upload made a minute ago and not yet set is never touched.
 *
 * The functions are exported so they can be tested; the command line is the last block.
 */
import { pathToFileURL } from 'node:url';
import {
  DOCUMENT_BUCKET,
  DOCUMENT_PATH_SHAPE,
  listWorkspaceFolders,
  runSweep,
  sweepLogoFiles,
  sweepWorkspace,
} from '../src/lib/maintenance/sweep-files.mjs';

export const BUCKET = DOCUMENT_BUCKET;
export const PATH_SHAPE = DOCUMENT_PATH_SHAPE;
export { listWorkspaceFolders, runSweep, sweepLogoFiles, sweepWorkspace };

/** @param {string[]} argv */
export function parseArgs(argv) {
  let remove = false;
  let verbose = false;
  for (const arg of argv) {
    if (arg === '--remove') remove = true;
    else if (arg === '--dry-run') remove = false;
    else if (arg === '--verbose') verbose = true;
    else throw new Error('Unknown option. Use --remove, or nothing for a dry run.');
  }
  return verbose ? { remove, verbose } : { remove };
}

async function main() {
  const { remove, verbose } = parseArgs(process.argv.slice(2));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const report = await runSweep(client, { remove, verbose });
  console.log(remove ? 'Removing logo files that are no workspace\'s logo.' : 'Logo files that are no workspace\'s logo (a day old or more).');
  const logos = await sweepLogoFiles(client, { remove, verbose });
  const failed = report.workspaces.reduce((n, w) => n + w.failed, 0) + logos.failed;
  if (remove) console.log(`Done. ${failed} file(s) could not be removed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'The sweep failed.');
    process.exit(1);
  });
}
