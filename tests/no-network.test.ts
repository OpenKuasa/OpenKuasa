import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// tests/setup/no-network.ts runs before every test file. A refused call also
// fails the file that made it, so the refusal itself is not exercised here:
// these cases check that the guard is in place and who it lets through.

const TESTS = join(process.cwd(), 'tests');
const read = (file: string) => readFileSync(join(TESTS, file), 'utf8');

test('fetch is the guarded one in a unit test file', () => {
  expect(globalThis.fetch.name).toBe('guardedFetch');
});

test('a call to this machine is passed on to the real fetch', async () => {
  // Nothing listens on the discard port: the real fetch fails to connect, which is not the guard's refusal.
  const failure = await fetch('http://127.0.0.1:9/').then(
    () => null,
    (error: Error) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(failure?.message).not.toContain('[no-network]');
});

test('vitest loads the guard, and the live set-up file is what marks a file as live', () => {
  expect(readFileSync(join(process.cwd(), 'vitest.config.mts'), 'utf8')).toContain(
    "setupFiles: ['./tests/setup/no-network.ts']",
  );
  const flag = "Symbol.for('openkuasa.tests.live')";
  expect(read('setup/no-network.ts')).toContain(flag);
  expect(read('setup/supabase.ts')).toContain(`[${flag}] = true`);
});

test('every test that makes a real client is one the guard lets through', () => {
  // The helpers that hand out real clients. A file using one without being
  // named `.rls.`/`.live.` or importing ./setup/supabase would be refused the
  // network at its first call; this says so before it runs.
  const makesRealClient = /from '\.\/helpers\/(live-workspaces|public-writer)'/;
  const unmarked = readdirSync(TESTS)
    .filter((file) => /\.test\.tsx?$/.test(file) && !/\.(rls|live)\.test\.tsx?$/.test(file))
    .filter((file) => {
      const text = read(file);
      const usesHelper = text
        .split('\n')
        .some((line) => makesRealClient.test(line) && !line.startsWith('import type') && /\b(liveClient|anonClient|ownerClient|demoClient|liveServer|publicWriter)\b/.test(line));
      return usesHelper && !text.includes("from './setup/supabase'");
    });
  expect(unmarked).toEqual([]);
});
