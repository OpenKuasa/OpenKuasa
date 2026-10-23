import { readFileSync } from 'node:fs';
import * as lucide from 'lucide-react';
import { describe, expect, it } from 'vitest';

/**
 * The rail draws every icon through AnimatedIcon, which draws nothing for a lucide name missing from
 * its map. The Account button went blank on prod that way (PR #353). The map is not exported, so its
 * keys are read from the source.
 */
const mapKeys = new Set(
  [...readFileSync('src/components/ui/animated-icon.tsx', 'utf8').matchAll(/^\s+'(\w+)': /gm)].map((m) => m[1]),
);

describe('product rail icons', () => {
  it('draws every icon the rail itself passes', () => {
    const source = readFileSync('src/components/app/product-rail.tsx', 'utf8');
    const icons = [...source.matchAll(/\bicon=\{(\w+)\}/g)].map((m) => m[1]);
    expect(icons.length).toBeGreaterThan(0);
    // The map is keyed by the icon's displayName, which is not always its export name.
    for (const icon of icons) {
      const name = (lucide as unknown as Record<string, { displayName?: string } | undefined>)[icon]?.displayName ?? icon;
      expect(mapKeys, `${icon} is not in the animated-icon map`).toContain(name);
    }
  });
});
