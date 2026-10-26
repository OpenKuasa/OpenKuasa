import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Inside a form, a select draws a hidden native <select> straight after its trigger. As the last child
 * of a `space-y-*` box it handed the trigger the space-y margin, so about 56 boxes across the app stood
 * 4–8px taller than their neighbours, and the journal line and the team invite rows sat out of line.
 * One rule in the global stylesheet takes that margin back off; measured in Chrome, the bottom-aligned
 * invite row lines up again and a select followed by help text keeps its spacing.
 */
describe('a select at the end of a spaced box', () => {
  it('gives no space-y margin to a trigger whose only follower is the hidden select', () => {
    const css = readFileSync(resolve('src/app/globals.css'), 'utf8');
    expect(css).toContain(
      "[data-slot='select-trigger']:has(+ select[aria-hidden='true']:last-child) {\n  margin-block-end: 0;\n}",
    );
  });

  it('keeps the rule outside any layer, so the space-y utilities cannot outrank it', () => {
    const css = readFileSync(resolve('src/app/globals.css'), 'utf8');
    const at = css.indexOf("[data-slot='select-trigger']:has(");
    // Every @layer block before the rule is closed by the time the rule starts.
    const before = css.slice(0, at);
    const opened = (before.match(/{/g) ?? []).length;
    const closed = (before.match(/}/g) ?? []).length;
    expect(opened).toBe(closed);
  });

  it('is what the select draws: a trigger tagged select-trigger', () => {
    const select = readFileSync(resolve('src/components/ui/select.tsx'), 'utf8');
    expect(select).toContain('data-slot="select-trigger"');
  });
});
