'use client';

import { createContext, useContext } from 'react';
import type { Viewer } from '@/lib/auth/viewer';

const ViewerContext = createContext<Viewer | null>(null);

export function ViewerProvider({
  viewer,
  children,
}: {
  viewer: Viewer;
  children: React.ReactNode;
}) {
  return (
    <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>
  );
}

/** The signed-in viewer, or null outside the app shell (a test, a public page). */
export function useOptionalViewer(): Viewer | null {
  return useContext(ViewerContext);
}

export function useViewer(): Viewer {
  const viewer = useContext(ViewerContext);
  if (!viewer) throw new Error('useViewer must be used inside ViewerProvider');
  return viewer;
}
