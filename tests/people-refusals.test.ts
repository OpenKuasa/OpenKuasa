import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEAVE_REFUSALS, OWN_REQUEST_REFUSAL, PAY_REFUSALS } from '@/lib/people/refusals';
import { LEAVE_REFUSALS as LEAVE_FROM_WRITE_PATH } from '@/lib/people/leave';
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
