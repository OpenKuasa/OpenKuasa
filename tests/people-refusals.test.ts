import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEAVE_REFUSALS, OWN_REQUEST_REFUSAL, PAY_REFUSALS } from '@/lib/people/refusals';
import {
  LEAVE_REFUSALS as LEAVE_FROM_WRITE_PATH,
  OWN_REQUEST_REFUSAL as OWN_REQUEST_FROM_WRITE_PATH,
} from '@/lib/people/leave';
import { PAY_REFUSALS as PAY_FROM_WRITE_PATH } from '@/lib/people/pay-requests';

const text = (file: string) => readFileSync(resolve(file), 'utf8');

describe('the refusal sentences the approval buttons show', () => {
  it('come from a leaf module with no imports, so reading one does not load zod', () => {
    const leaf = text('src/lib/people/refusals.ts');
    expect(leaf).not.toMatch(/^import /m);
    expect(leaf).not.toMatch(/from ['"]zod['"]/);
  });

  it('are the same objects the write paths re-export', () => {
    expect(LEAVE_FROM_WRITE_PATH).toBe(LEAVE_REFUSALS);
    expect(PAY_FROM_WRITE_PATH).toBe(PAY_REFUSALS);
    // leave.ts re-exports OWN_REQUEST_REFUSAL (approvals-screen reads it from there); it must survive the
    // leaf move, even though leave.ts no longer binds it locally.
    expect(OWN_REQUEST_FROM_WRITE_PATH).toBe(OWN_REQUEST_REFUSAL);
  });

  it.each(['src/components/people/decide-buttons.tsx', 'src/components/people/team-decide-buttons.tsx'])(
    '%s takes the sentences from the leaf module, not the write path',
    (file) => {
      const source = text(file);
      expect(source).toContain("from '@/lib/people/refusals'");
      expect(source).not.toContain("from '@/lib/people/leave'");
      expect(source).not.toContain("from '@/lib/people/pay-requests'");
    },
  );

  // The decide buttons are `'use client'` components that call the server actions in leave-actions.ts and
  // pay-actions.ts, and those action files import zod. Reading a sentence from the leaf module (checked above)
  // is only half the guard: `'use server'` is what keeps the actions' zod on the server. Drop that directive and
  // the action file becomes an ordinary module, so its zod is bundled back into the DecideButtons chunk — the exact
  // regression this PR fixed. Unlike the tier logic (a function, tested by behaviour), this invariant is file-level
  // metadata with no value to call, so it is checked as source: the directive must be the file's first statement,
  // which is the only position where Next.js honours it.
  it.each(['src/app/(app)/people/leave-actions.ts', 'src/app/(app)/people/pay-actions.ts'])(
    "%s keeps 'use server' as its first statement, so its zod never reaches the client chunk",
    (file) => {
      const firstStatement = text(file)
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line !== '' && !line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*'));
      expect(firstStatement).toBe("'use server';");
    },
  );
});

describe('the sentences themselves', () => {
  it('answer deciding your own request with the shared sentence', () => {
    expect(LEAVE_REFUSALS.LEAVE_OWN_REQUEST).toBe(OWN_REQUEST_REFUSAL);
    expect(PAY_REFUSALS.PAY_OWN_REQUEST).toBe(OWN_REQUEST_REFUSAL);
  });

  it('answer every leave and pay code the screens can be refused with', () => {
    expect(LEAVE_REFUSALS.LEAVE_NOT_PENDING).toBeTruthy();
    expect(PAY_REFUSALS.PAY_NOT_PENDING).toBeTruthy();
  });
});
