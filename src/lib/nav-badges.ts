import type { NavBadgeKey } from '@/config/nav';

export type NavBadges = Record<NavBadgeKey, number>;
/** Counts a page has set from the browser, over what the server provided. */
export type BadgeOverrides = Partial<Record<NavBadgeKey, number>>;

/** The server's counts, with any a page has set over them. A key not overridden keeps the server's value. */
export function mergeBadges(server: NavBadges, overrides: BadgeOverrides): NavBadges {
  return { ...server, ...overrides };
}

/** Sets one count (a negative or non-finite value becomes 0). Returns the same object when nothing changes. */
export function setOverride(overrides: BadgeOverrides, name: NavBadgeKey, value: number): BadgeOverrides {
  const next = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return overrides[name] === next ? overrides : { ...overrides, [name]: next };
}

/** Drops one override (the page that set it is gone), so the server's value shows again: 0 for a count only a page sets. */
export function clearOverride(overrides: BadgeOverrides, name: NavBadgeKey): BadgeOverrides {
  if (!(name in overrides)) return overrides;
  const rest = { ...overrides };
  delete rest[name];
  return rest;
}
