import { describe, expect, it } from 'vitest';
import { LIVE_SCREENS, isSampleScreen } from '@/config/live-screens';
import { getProduct } from '@/config/nav';

const slugs = getProduct('people')!.sections.flatMap((section) => section.items.map((item) => item.slug));
const own = slugs.filter((slug) => slug !== 'calendar');

describe('Lekiu live screens', () => {
  it('marks all 28 Lekiu screens as live, so none carries a work-in-progress banner', () => {
    expect(own).toHaveLength(28);
    for (const slug of own) {
      expect(LIVE_SCREENS.has(`people/${slug}`), slug).toBe(true);
      expect(isSampleScreen(`/people/${slug}`), slug).toBe(false);
    }
  });

  it('lists no Lekiu screen that is not in the navigation', () => {
    const listed = [...LIVE_SCREENS]
      .filter((key) => key.startsWith('people/'))
      .map((key) => key.slice('people/'.length));
    expect(listed.sort()).toEqual([...own].sort());
  });

  it('leaves the Calendar under /people as the shared sample screen', () => {
    expect(isSampleScreen('/people/calendar')).toBe(true);
  });
});
