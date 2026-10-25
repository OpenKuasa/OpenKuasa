import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { liveScreenPaths } from '@/lib/docs/rules';
import { DOC_SECTIONS } from '@/lib/docs/sections';
import { isDeniedClick, isLocalBase } from '../scripts/docs-shots-lib.mjs';

const DIR = join('content', 'docs', 'shots');
const sections = new Set<string>(DOC_SECTIONS.map((s) => s.key));

type Shot = { file: string; path: string; as: string; clip?: string; steps?: { click?: string; wait?: number }[] };

describe('docs screenshot config', () => {
  test('every shot names a known section, a live screen, demo or preview, and no saving click', () => {
    const live = liveScreenPaths();
    for (const name of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
      const shots = JSON.parse(readFileSync(join(DIR, name), 'utf8')) as Shot[];
      for (const s of shots) {
        const where = `${name}: ${s.file}`;
        expect(sections.has(s.file.split('/')[0]), `${where} section`).toBe(true);
        expect(s.file, `${where} png`).toMatch(/^[a-z-]+\/[a-z0-9-]+\.png$/);
        expect(live.has(s.path), `${where} path ${s.path}`).toBe(true);
        expect(['demo', 'preview'], `${where} as`).toContain(s.as);
        for (const step of s.steps ?? []) {
          if (step.click !== undefined) expect(isDeniedClick(step.click), `${where} click ${step.click}`).toBe(false);
        }
      }
    }
  });

  test('refuses any base URL that is not local', () => {
    expect(isLocalBase('https://openkuasa.com')).toBe(false);
    expect(isLocalBase('https://www.openkuasa.com')).toBe(false);
    expect(isLocalBase('http://localhost.evil.com')).toBe(false);
    expect(isLocalBase('not a url')).toBe(false);
    expect(isLocalBase('http://localhost:3175')).toBe(true);
    expect(isLocalBase('http://127.0.0.1:3175')).toBe(true);
  });

  test('deny-list catches saving words, not safe ones', () => {
    for (const n of ['Save', 'save changes', 'Submit', 'Send', 'Approve', 'Delete', 'Remove', 'Post', 'Confirm', 'Pay']) {
      expect(isDeniedClick(n), n).toBe(true);
    }
    for (const n of ['New leave', 'Open', 'Cancel']) expect(isDeniedClick(n), n).toBe(false);
  });
});
