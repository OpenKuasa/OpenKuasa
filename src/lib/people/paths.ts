import { PRODUCTS } from '@/config/nav';

/** Lekiu pages that show nothing about employees, so an employee change leaves them as they are. */
const NO_EMPLOYEE_DATA = new Set(['public-holidays', 'announcements', 'settings']);

/**
 * Every Lekiu page to load afresh after an employee or department changes.
 * Taken from the navigation, so a page added there is covered without a
 * second list to keep in step.
 */
export const PEOPLE_PATHS: string[] = (PRODUCTS.find((product) => product.key === 'people')?.sections ?? [])
  .flatMap((section) => section.items)
  .map((item) => item.slug)
  .filter((slug) => !NO_EMPLOYEE_DATA.has(slug))
  .map((slug) => `/people/${slug}`);
