import { execSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

function gitGrep(pattern: string): string {
  try {
    return execSync(`git grep -n "${pattern}" -- src`, { encoding: 'utf8' }).trim();
  } catch (error) {
    // git grep exits 1 when nothing matches
    if ((error as { status?: number }).status === 1) return '';
    throw error;
  }
}

describe('docs links', () => {
  test('no link still points at the old placeholder page', () => {
    expect(gitGrep("'/account/docs'")).toBe('');
  });
});
