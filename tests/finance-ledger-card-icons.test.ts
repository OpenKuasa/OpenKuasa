import { readFileSync } from 'node:fs';
import * as lucide from 'lucide-react';
import { describe, expect, it } from 'vitest';

/**
 * A Bento card's icon draws only if its lucide name is a key in the map in animated-icon.tsx; otherwise the
 * card shows an empty tinted square. The map is not exported, so its keys are read from the source.
 */
const mapKeys = new Set([...readFileSync('src/components/ui/animated-icon.tsx', 'utf8').matchAll(/^\s+'(\w+)': /gm)].map((m) => m[1]));

/**
 * The icon expression of every <BentoCard> in a source, read to the end of its opening tag: braces are
 * counted, so a `>` inside a prop such as action={<Button>} does not end the tag early and hide an icon after it.
 * Only a prop at the tag's own level counts, not an icon={} of some element nested in another prop.
 */
function cardIcons(source: string): { cards: number; icons: string[] } {
  let cards = 0;
  const icons: string[] = [];
  for (const start of source.matchAll(/<BentoCard\b/g)) {
    cards += 1;
    let depth = 0;
    for (let i = start.index! + start[0].length; i < source.length; i += 1) {
      const c = source[i];
      if (c === '{') {
        if (depth === 0 && /\sicon=$/.test(source.slice(i - 6, i))) {
          let end = i;
          let inner = 0;
          do {
            if (source[end] === '{') inner += 1;
            if (source[end] === '}') inner -= 1;
            end += 1;
          } while (inner > 0);
          icons.push(source.slice(i + 1, end - 1));
        }
        depth += 1;
      } else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
    }
  }
  return { cards, icons };
}

// Cards and cards with an icon in each file. A count that falls means the check read fewer cards than exist.
const EXPECTED: Record<string, { cards: number; withIcon: number }> = {
  'components/finance/accounts-view': { cards: 4, withIcon: 2 },
  'components/finance/journals-view': { cards: 6, withIcon: 3 },
  'components/finance/reports-view': { cards: 12, withIcon: 8 },
  'screens/finance/sst-report': { cards: 13, withIcon: 6 },
  'components/finance/sst-figures-card': { cards: 1, withIcon: 1 },
  'components/finance/sst-periods-card': { cards: 1, withIcon: 1 },
  'components/finance/sst-settings-card': { cards: 1, withIcon: 1 },
  // Every product's Settings screen, and the Workspace card they all open with.
  'components/settings/workspace-card': { cards: 1, withIcon: 1 },
  'screens/finance/settings': { cards: 7, withIcon: 7 },
  'screens/people/settings': { cards: 3, withIcon: 3 },
  'screens/hire/settings': { cards: 1, withIcon: 1 },
  'screens/reach/ad-settings': { cards: 2, withIcon: 2 },
  'components/reach/ad-settings-form': { cards: 2, withIcon: 2 },
  'screens/crm/settings-view': { cards: 5, withIcon: 5 },
};

describe.each(Object.keys(EXPECTED))('the icons %s gives its cards', (file) => {
  const source = readFileSync(`src/${file}.tsx`, 'utf8');
  const { cards, icons } = cardIcons(source);
  // icon={X} and icon={cond ? A : B}
  const names = icons.flatMap((expr) => expr.match(/[A-Z]\w+/g) ?? []);

  it('reads every card of the file, and the ones with an icon', () => {
    expect(cards).toBe(source.match(/<BentoCard\b/g)!.length);
    expect({ cards, withIcon: icons.length }).toEqual(EXPECTED[file]);
  });
  it('are all in the animated icon map', () => {
    expect(names.length).toBeGreaterThan(0);
    // The map is keyed by the icon's displayName, which is not always its export name (Building2 is BuildingComplex).
    for (const name of names) {
      const icon = (lucide as unknown as Record<string, { displayName?: string } | undefined>)[name];
      expect(mapKeys.has(icon?.displayName ?? name), name).toBe(true);
    }
  });
});
