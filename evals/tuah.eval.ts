/**
 * Tuah's accuracy check. Run with `pnpm eval:tuah`.
 *
 * Every case is run several times (`EVAL_RUNS`, default 3), because a model
 * that is right two times in three is not right. The run prints a table of
 * how often each case passed and what failed, writes the same to
 * `evals/reports/`, and fails if any case passes less often than
 * `EVAL_MIN_PASS` (default 1, meaning every run).
 *
 * Runs go one after another and turns are spaced out, so a provider's
 * calls-per-minute limit is not what gets measured. A run the provider still
 * refuses is tried again, then reported as "not scored" rather than as a
 * wrong answer, and the check fails: an unfinished check is not a pass.
 *
 * It calls real models and writes to a real workspace, so it is not part of
 * `pnpm test`. It needs the app's `.env.local` and an account to run as (see
 * `evalAccount` in `tuah/harness.ts`). `EVAL_ONLY=add-deal,malay` runs a few.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { config } from 'dotenv';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { CASES } from './tuah/cases';
import {
  cleanUp,
  evalAccount,
  isProviderFailure,
  openWorkspace,
  type Check,
  type Workspace,
} from './tuah/harness';

config({ path: '.env.local' });

const RUNS = Math.max(1, Number(process.env.EVAL_RUNS ?? 3));
const MIN_PASS = Number(process.env.EVAL_MIN_PASS ?? 1);
const only = (process.env.EVAL_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const cases = only.length > 0 ? CASES.filter((c) => only.includes(c.id)) : CASES;

const account = evalAccount();
const ready =
  !!account &&
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
  !!process.env.OPENROUTER_API_KEY;

type Run = { pass: boolean; failed: Check[]; error?: string; unscored?: true };
type Result = { id: string; about: string; runs: Run[] };
const RETRIES = 2;
// A provider that is out of in-flight budget asks for two minutes.
const RETRY_WAIT_MS = 125_000;
const results: Result[] = [];
let workspace: Workspace;

beforeAll(async () => {
  if (!ready) return;
  workspace = await openWorkspace(account!);
  await cleanUp(workspace);
});

afterAll(async () => {
  if (!ready) return;
  await cleanUp(workspace);
  // Local: the default ends every session of the account, a browser's included.
  await workspace.client.auth.signOut({ scope: 'local' });

  const lines = results.map((r) => {
    const scored = r.runs.filter((run) => !run.unscored);
    const passed = scored.filter((run) => run.pass).length;
    const verdict = scored.length < r.runs.length ? 'OPEN' : passed === scored.length ? 'PASS' : 'FAIL';
    return `${verdict}  ${passed}/${scored.length}  ${r.id.padEnd(28)} ${r.about}`;
  });
  const all = results.flatMap((r) => r.runs);
  const scored = all.filter((run) => !run.unscored);
  const passed = scored.filter((run) => run.pass).length;
  const unscored = all.length - scored.length;
  const failures = results.flatMap((r) =>
    r.runs.flatMap((run, i) =>
      run.pass
        ? []
        : [
            `\n${r.id}, run ${i + 1}${run.unscored ? ' (not scored)' : ''}:`,
            ...(run.error ? [`  error: ${run.error}`] : []),
            ...run.failed.map(
              (c) => `  not: ${c.what}${c.detail ? `\n       ${c.detail.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`,
            ),
          ],
    ),
  );
  const report = [
    `Tuah accuracy: ${passed}/${scored.length} runs passed (${cases.length} cases x ${RUNS})`,
    ...(unscored > 0
      ? [`${unscored} runs not scored: the model provider refused the calls (rate limit or credits).`]
      : []),
    '',
    ...lines,
    ...failures,
  ].join('\n');
  console.log(`\n${report}\n`);
  mkdirSync('evals/reports', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(`evals/reports/tuah-${stamp}.txt`, `${report}\n`);
  writeFileSync(`evals/reports/tuah-${stamp}.json`, JSON.stringify({ runs: RUNS, results }, null, 2));
});

const run = ready ? test : test.skip;
if (!ready) {
  console.warn(
    'Tuah accuracy check skipped: it needs .env.local (Supabase and OPENROUTER_API_KEY) and an eval account.',
  );
}

for (const c of cases) {
  run(`${c.id}: ${c.about}`, async () => {
    const runs: Run[] = [];
    for (let n = 0; n < RUNS; n += 1) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const checks = await c.run(workspace);
          const failed = checks.filter((check) => !check.pass);
          runs.push({ pass: failed.length === 0, failed });
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!isProviderFailure(error)) {
            runs.push({ pass: false, failed: [], error: message });
            break;
          }
          if (attempt === RETRIES) {
            runs.push({ pass: false, failed: [], error: message, unscored: true });
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
        }
      }
    }
    results.push({ id: c.id, about: c.about, runs });
    const scored = runs.filter((r) => !r.unscored);
    expect(scored.length, `${c.id}: ${runs.length - scored.length} runs could not be scored`).toBe(runs.length);
    const rate = scored.filter((r) => r.pass).length / scored.length;
    expect(rate, `${c.id} passed ${Math.round(rate * 100)}% of runs`).toBeGreaterThanOrEqual(MIN_PASS);
  });
}
