import { describe, expect, it } from 'vitest';
import { LIVE_SCREENS, isSampleScreen } from '@/config/live-screens';
import { getProduct } from '@/config/nav';

const slugs = getProduct('people')!.sections.flatMap((section) => section.items.map((item) => item.slug));

describe('Lekiu live screens', () => {
  it('marks all 31 Lekiu screens as live, so none carries a work-in-progress banner', () => {
    expect(slugs).toHaveLength(31);
    for (const slug of slugs) {
      expect(LIVE_SCREENS.has(`people/${slug}`), slug).toBe(true);
      expect(isSampleScreen(`/people/${slug}`), slug).toBe(false);
    }
  });

  it('lists no Lekiu screen that is not in the navigation', () => {
    const listed = [...LIVE_SCREENS]
      .filter((key) => key.startsWith('people/'))
      .map((key) => key.slice('people/'.length));
    expect(listed.sort()).toEqual([...slugs].sort());
  });
});
