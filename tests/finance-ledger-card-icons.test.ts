import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A Bento card's icon draws only if its lucide name is a key in the map in animated-icon.tsx; otherwise the
 * card shows an empty tinted square. The map is not exported, so its keys are read from the source.
 */
const mapKeys = new Set([...readFileSync('src/components/ui/animated-icon.tsx', 'utf8').matchAll(/^\s+'(\w+)': /gm)].map((m) => m[1]));

describe.each(['accounts-view', 'journals-view'])('the icons %s gives its cards', (file) => {
  const source = readFileSync(`src/components/finance/${file}.tsx`, 'utf8');
  // <BentoCard icon={X}> (the icons inline in menus and buttons are drawn as they are)
  // and icon={cond ? A : B}
  const names = [...source.matchAll(/<BentoCard\b[^>]*?\bicon=\{([^}]+)\}/g)].flatMap(([, expr]) => expr.match(/[A-Z]\w+/g) ?? []);

  it('are all in the animated icon map', () => {
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(mapKeys.has(name), name).toBe(true);
  });
});
