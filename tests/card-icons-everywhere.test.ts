import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as lucide from 'lucide-react';
import { describe, expect, it } from 'vitest';

/**
 * A Bento card's icon draws only if its lucide displayName is a key in the map in animated-icon.tsx; otherwise the
 * card shows an empty tinted square (this shipped blank on several screens). This checks every <BentoCard icon={X}>
 * in src whose X is a lucide icon, so a new card with an unmapped icon fails here. Icons passed through a variable
 * are not seen; finance-ledger-card-icons.test.ts checks those per file.
 */
const mapKeys = new Set(
  [...readFileSync('src/components/ui/animated-icon.tsx', 'utf8').matchAll(/^\s+'(\w+)': /gm)].map((m) => m[1]),
);
const icons = lucide as unknown as Record<string, { displayName?: string } | undefined>;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

describe('every card icon in src', () => {
  it('is in the animated icon map', () => {
    const missing: string[] = [];
    let seen = 0;
    for (const file of tsxFiles('src')) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('<BentoCard')) continue;
      for (const card of source.matchAll(/<BentoCard\b[\s\S]*?\sicon=\{([^}]*)\}/g)) {
        for (const name of card[1].match(/[A-Z]\w+/g) ?? []) {
          // Every lucide icon has a displayName; a local variable such as `Icon` (also a lucide export) does not.
          const key = icons[name]?.displayName;
          if (!key) continue;
          seen += 1;
          if (!mapKeys.has(key)) missing.push(`${name} (${key}) in ${file}`);
        }
      }
    }
    expect(seen).toBeGreaterThan(50);
    expect(missing).toEqual([]);
  });

  it('includes the goal status icons, which are passed through a variable', () => {
    for (const name of ['Target', 'AlertTriangle', 'CircleCheck']) {
      expect(mapKeys.has(icons[name]?.displayName ?? name), name).toBe(true);
    }
  });
});
