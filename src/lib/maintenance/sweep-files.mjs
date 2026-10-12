/**
 * The sweep of files nothing points at, in the two buckets that can hold one:
 *
 *   hr-documents  a document file no document carries (an upload never attached, the files of an employee or
 *                 workspace since deleted);
 *   org-logos     a logo file that is no workspace's logo (an upload never set, a replaced or removed logo whose
 *                 removal failed, the logo of a workspace since deleted).
 *
 * Plain JavaScript with no imports, so two callers can run the very same code: the operator's script
 * (`scripts/sweep-document-files.mjs`, which Node runs as it is) and the app's route
 * (`POST /api/maintenance/sweep-files`). Every function takes the service client it should use.
 *
 * How the document sweep stays safe:
 * - Workspace folders come from the bucket's own top level, not from the `orgs` table, so the files of a workspace
 *   that no longer exists are found.
 * - A dry run only calls `hr_orphaned_document_files(p_org)`, which lists and changes nothing.
 * - Removing loops `hr_release_orphaned_document_files(p_org, p_limit)`, which re-checks each path under a lock,
 *   marks it released so no document can ever carry it, and returns it. ONLY the paths that call returns are
 *   removed, one at a time and only if they have the exact shape the app makes and sit in that workspace's folder.
 * - A round that removes nothing ends the workspace, and a workspace is limited to `maxRounds` rounds.
 *
 * How the logo sweep stays safe:
 * - `org_orphaned_logo_files()` lists a name only when its file is over a day old and no workspace's logo.
 * - Each listed name is asked about AGAIN, alone, just before it is removed (`org_logo_file_is_orphaned(p_name)`),
 *   and removed only on a plain `true`: a file that became a logo since the listing is kept.
 * - Nothing can make it a logo between that answer and the removal: `set_org_logo` refuses a file uploaded more
 *   than an hour ago (unless it already is the logo, and then the second answer was `false`), and a listed file is
 *   over a day old. No other statement writes `orgs.logo_path`. So the window needs no lock.
 * - Only a name of the exact shape the app makes is ever handed to the service role's `remove`, one at a time.
 *
 * Nothing here logs a path unless a dry run is asked for `verbose`. An error is reported by its code only.
 */

export const DOCUMENT_BUCKET = 'hr-documents';
export const LOGO_BUCKET = 'org-logos';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Exactly what the app makes (`documentPath`) and the database accepts. KEEP IN STEP with src/lib/people/document-files.ts. */
export const DOCUMENT_PATH_SHAPE = new RegExp(`^${UUID}/${UUID}/${UUID}\\.(pdf|jpg|png|webp|heic)$`);
/** Exactly what the app makes (`logoPath`) and the database accepts. KEEP IN STEP with src/lib/account/logo-url.ts. */
export const LOGO_PATH_SHAPE = new RegExp(`^${UUID}/${UUID}\\.(png|jpg|webp)$`);
const FOLDER_SHAPE = new RegExp(`^${UUID}$`);
const PAGE = 100;
const RELEASE_LIMIT = 500;
const LOGO_BATCH = 500;
const LIST_PAGE = 1000;
const MAX_ROUNDS = 100;
/** The most removals one call of {@link sweepAllFiles} (so one request to the route) will attempt. */
export const SWEEP_CALL_LIMIT = 500;
/** How long {@link sweepAllFiles} keeps starting on new workspace folders. */
export const SWEEP_TIME_LIMIT_MS = 20_000;

/**
 * @typedef {{ left: number }} Budget  How many more removals may be attempted. Shared between sweeps; none = no bound.
 * @typedef {{ remove: boolean, verbose?: boolean, log?: (line: string) => void, maxRounds?: number, budget?: Budget }} SweepOptions
 */

/** The workspace folders at the top of the document bucket (lower-case uuids only), read page by page. */
export async function listWorkspaceFolders(client) {
  const folders = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await client.storage.from(DOCUMENT_BUCKET).list('', { limit: PAGE, offset });
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

/** Removes one path from a bucket. True only when storage reports no error; never throws. */
async function removeOne(client, bucket, path) {
  try {
    const { error } = await client.storage.from(bucket).remove([path]);
    return !error;
  } catch {
    return false;
  }
}

/**
 * One workspace's document folder. Dry run: lists. Remove: releases, then removes what the release returned, until
 * a call returns nothing or removes nothing, or the budget is spent (a release is then asked for no more than is
 * left, so nothing is released that this call will not try to remove). Returns counts; an error is reported by its
 * code only.
 */
export async function sweepWorkspace(client, org, /** @type {SweepOptions} */ { remove, verbose = false, log = console.log, maxRounds = MAX_ROUNDS, budget }) {
  const result = { org, listed: null, removed: 0, failed: 0, skipped: 0, rounds: 0, error: null };

  if (!remove) {
    const names = [];
    for (let from = 0; ; from += LIST_PAGE) {
      const { data, error } = await client.rpc('hr_orphaned_document_files', { p_org: org }).range(from, from + LIST_PAGE - 1);
      if (error) {
        result.error = error.code ?? 'error';
        log(`${org}: could not be listed (code ${result.error})`);
        return result;
      }
      const page = (Array.isArray(data) ? data : []).map(nameOf).filter((name) => name !== '');
      names.push(...page);
      if (page.length < LIST_PAGE) break;
    }
    result.listed = names.length;
    log(`${org}: ${names.length} file(s) with no document`);
    if (verbose) for (const name of names) log(`  ${name}`);
    return result;
  }

  // A path whose removal failed is not tried again in this run (the release call returns it every round).
  const failedPaths = new Set();
  for (let round = 0; round < maxRounds; round += 1) {
    if (budget && budget.left <= 0) break;
    const limit = budget ? Math.min(RELEASE_LIMIT, budget.left) : RELEASE_LIMIT;
    const { data, error } = await client.rpc('hr_release_orphaned_document_files', { p_org: org, p_limit: limit });
    if (error) {
      result.error = error.code ?? 'error';
      break;
    }
    const returned = Array.isArray(data) ? data.map(nameOf) : [];
    if (returned.length === 0) break;
    result.rounds += 1;
    let attempted = 0;
    for (const path of returned) {
      if (failedPaths.has(path)) continue;
      // The remove runs with the service role: only a path of the exact shape, inside this workspace's folder.
      if (!DOCUMENT_PATH_SHAPE.test(path) || !path.startsWith(`${org}/`)) {
        result.skipped += 1;
        continue;
      }
      if (budget && budget.left <= 0) break;
      attempted += 1;
      if (budget) budget.left -= 1;
      if (await removeOne(client, DOCUMENT_BUCKET, path)) {
        result.removed += 1;
      } else {
        failedPaths.add(path);
        result.failed += 1;
      }
    }
    // Only paths already failed (or refused by shape) came back: nothing new to try.
    if (attempted === 0) break;
  }
  if (result.error) log(`${org}: the release was refused (code ${result.error})`);
  log(`${org}: removed ${result.removed}, failed ${result.failed}, skipped ${result.skipped}`);
  return result;
}

/** Every workspace folder in the document bucket, one after another. A refusal for one does not stop the rest. */
export async function runSweep(client, /** @type {SweepOptions & { now?: () => number, deadline?: number }} */ { remove, verbose, log = console.log, maxRounds, budget, now = Date.now, deadline }) {
  log(remove ? 'Removing document files that no document carries.' : 'Dry run: nothing is changed. Use --verbose to print the paths, --remove to remove.');
  const folders = await listWorkspaceFolders(client);
  const workspaces = [];
  let stoppedEarly = false;
  for (const org of folders) {
    if (remove && budget && budget.left <= 0) break;
    // One call per folder whatever the budget: past the deadline no new folder is started.
    if (deadline !== undefined && now() >= deadline) {
      stoppedEarly = true;
      break;
    }
    workspaces.push(await sweepWorkspace(client, org, { remove, verbose, log, maxRounds, budget }));
  }
  if (folders.length === 0) log('The bucket has no workspace folders.');
  return { workspaces, stoppedEarly };
}

/**
 * The logo bucket. Dry run: lists and counts (the paths too with `verbose`). Remove: takes the listing a batch at a
 * time, oldest first; each name of the right shape is asked about again and removed only if the database still
 * says it is no workspace's logo. A name set aside (wrong shape, kept, or failed) is tried once: the next batch
 * starts after those, so the files listed behind them are reached. Returns counts; an error by its code only.
 */
export async function sweepLogoFiles(client, /** @type {SweepOptions} */ { remove, verbose = false, log = console.log, maxRounds = MAX_ROUNDS, budget }) {
  const result = { listed: null, removed: 0, failed: 0, skipped: 0, kept: 0, rounds: 0, error: null };

  if (!remove) {
    const names = [];
    for (let from = 0; ; from += LIST_PAGE) {
      const { data, error } = await client.rpc('org_orphaned_logo_files').range(from, from + LIST_PAGE - 1);
      if (error) {
        result.error = error.code ?? 'error';
        log(`logos: could not be listed (code ${result.error})`);
        return result;
      }
      const page = (Array.isArray(data) ? data : []).map(nameOf).filter((name) => name !== '');
      names.push(...page);
      if (page.length < LIST_PAGE) break;
    }
    result.listed = names.length;
    log(`logos: ${names.length} logo file(s) that are no workspace's logo`);
    if (verbose) for (const name of names) log(`  ${name}`);
    return result;
  }

  // Names this run will not touch again. They stay in the listing, so each batch starts after them.
  let aside = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    if (budget && budget.left <= 0) break;
    const take = budget ? Math.min(LOGO_BATCH, budget.left) : LOGO_BATCH;
    const { data, error } = await client.rpc('org_orphaned_logo_files').range(aside, aside + take - 1);
    if (error) {
      result.error = error.code ?? 'error';
      break;
    }
    const listed = Array.isArray(data) ? data.map(nameOf) : [];
    if (listed.length === 0) break;
    result.rounds += 1;
    for (const name of listed) {
      // The remove runs with the service role: only a name of the exact shape is asked about or removed.
      if (!LOGO_PATH_SHAPE.test(name)) {
        result.skipped += 1;
        aside += 1;
        continue;
      }
      if (budget && budget.left <= 0) break;
      if (budget) budget.left -= 1;
      // Asked again, alone, at the last moment: only a plain `true` lets the file go.
      let still = null;
      try {
        const answer = await client.rpc('org_logo_file_is_orphaned', { p_name: name });
        still = answer.error ? null : answer.data;
      } catch {
        still = null;
      }
      if (still === false) {
        result.kept += 1;
        aside += 1;
      } else if (still !== true) {
        result.failed += 1;
        aside += 1;
      } else if (await removeOne(client, LOGO_BUCKET, name)) {
        result.removed += 1;
      } else {
        result.failed += 1;
        aside += 1;
      }
    }
    if (listed.length < take) break;
  }
  if (result.error) log(`logos: could not be listed (code ${result.error})`);
  log(`logos: removed ${result.removed}, failed ${result.failed}, skipped ${result.skipped}, kept ${result.kept}`);
  return result;
}

/**
 * Both sweeps, removing, bounded: at most `limit` removals are attempted in all (a failed one counts). Stray logos
 * go first but may take only half of the limit (rounded up), and the document folders get everything the logos did
 * not use, so neither can starve the other. No new workspace folder is started once `timeLimitMs` (20 seconds) has
 * passed on the clock `now`; `documents.stoppedEarly` says so. For a caller with no shell (the route). Answers numbers only: no path, no
 * workspace. What went wrong is handed to `onCode(where, code)` as a code, and the other sweep still runs.
 *
 * @param {unknown} client
 * @param {{ limit?: number, onCode?: (where: string, code: string) => void, now?: () => number, timeLimitMs?: number }} [options]
 */
export async function sweepAllFiles(client, { limit = SWEEP_CALL_LIMIT, onCode = () => {}, now = Date.now, timeLimitMs = SWEEP_TIME_LIMIT_MS } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > SWEEP_CALL_LIMIT) throw new Error('The limit must be a whole number from 1 to 500.');
  const deadline = now() + timeLimitMs;
  const logoBudget = { left: Math.ceil(limit / 2) };
  const budget = { left: limit };
  const quiet = () => {};

  const logos = { removed: 0, failed: 0, skipped: 0, kept: 0, errors: 0 };
  try {
    const swept = await sweepLogoFiles(client, { remove: true, log: quiet, budget: logoBudget });
    Object.assign(logos, { removed: swept.removed, failed: swept.failed, skipped: swept.skipped, kept: swept.kept });
    if (swept.error) {
      logos.errors = 1;
      onCode('logos', swept.error);
    }
  } catch {
    logos.errors = 1;
    onCode('logos', 'failed');
  }
  // What the logos spent is spent, whatever they left; the documents get the rest.
  budget.left -= Math.ceil(limit / 2) - logoBudget.left;

  const documents = { workspaces: 0, removed: 0, failed: 0, skipped: 0, errors: 0, stoppedEarly: false };
  try {
    const { workspaces, stoppedEarly } = await runSweep(client, { remove: true, log: quiet, budget, now, deadline });
    documents.workspaces = workspaces.length;
    documents.stoppedEarly = stoppedEarly;
    for (const workspace of workspaces) {
      documents.removed += workspace.removed;
      documents.failed += workspace.failed;
      documents.skipped += workspace.skipped;
      if (workspace.error) {
        documents.errors += 1;
        onCode('documents', workspace.error);
      }
    }
  } catch {
    documents.errors += 1;
    onCode('documents', 'failed');
  }

  return { limit, attempted: limit - budget.left, logos, documents };
}
