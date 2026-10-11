'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { NavBadgeKey } from '@/config/nav';
import { type BadgeOverrides, type NavBadges, clearOverride, mergeBadges, setOverride } from '@/lib/nav-badges';

export type { NavBadges };

/** Live counts for nav-item badges, keyed by NavBadgeKey. The server provides the first values; a page can set one. */
const EMPTY: NavBadges = { pendingProposals: 0, unreadAnnouncements: 0 };

const NavBadgesContext = createContext<NavBadges>(EMPTY);
const NavBadgeSetter = createContext<{
  set: (name: NavBadgeKey, value: number) => void;
  clear: (name: NavBadgeKey) => void;
}>({ set: () => {}, clear: () => {} });

export function NavBadgesProvider({
  badges,
  children,
}: {
  badges: NavBadges;
  children: React.ReactNode;
}) {
  const [overrides, setOverrides] = useState<BadgeOverrides>({});
  const set = useCallback((name: NavBadgeKey, value: number) => setOverrides((o) => setOverride(o, name, value)), []);
  const clear = useCallback((name: NavBadgeKey) => setOverrides((o) => clearOverride(o, name)), []);
  const merged = useMemo(() => mergeBadges(badges, overrides), [badges, overrides]);
  const setter = useMemo(() => ({ set, clear }), [set, clear]);
  return (
    <NavBadgeSetter.Provider value={setter}>
      <NavBadgesContext.Provider value={merged}>{children}</NavBadgesContext.Provider>
    </NavBadgeSetter.Provider>
  );
}

export function useNavBadges(): NavBadges {
  return useContext(NavBadgesContext);
}

/**
 * Sets one nav badge from a page's layout (drawn after hydration) and puts it back to the server's value, 0 for a
 * count only a page sets, when that layout goes away (the person left the product).
 */
export function SetNavBadge({ name, value }: { name: NavBadgeKey; value: number }) {
  const { set, clear } = useContext(NavBadgeSetter);
  useEffect(() => {
    set(name, value);
  }, [set, name, value]);
  useEffect(() => () => clear(name), [clear, name]);
  return null;
}
