'use client';

import { createContext, useContext } from 'react';
import type { NavBadgeKey } from '@/config/nav';

/** Live counts for nav-item badges, keyed by NavBadgeKey. Computed server-side per request. */
export type NavBadges = Record<NavBadgeKey, number>;

const EMPTY: NavBadges = { pendingProposals: 0 };

const NavBadgesContext = createContext<NavBadges>(EMPTY);

export function NavBadgesProvider({
  badges,
  children,
}: {
  badges: NavBadges;
  children: React.ReactNode;
}) {
  return <NavBadgesContext.Provider value={badges}>{children}</NavBadgesContext.Provider>;
}

export function useNavBadges(): NavBadges {
  return useContext(NavBadgesContext);
}
