'use client';

import { type DependencyList, useEffect, useRef } from 'react';

type AnimeModule = typeof import('animejs');

/**
 * Runs an animejs setup after lazy-loading the library, so animejs stays out of
 * the initial landing-page bundle (it was the bulk of ~1.6s of up-front script
 * evaluation). The setup receives the anime module and may return a cleanup —
 * e.g. `() => scope.revert()`. Safe if the component unmounts before the dynamic
 * import resolves. Animations start a beat after hydration, off the critical path.
 */
export function useAnimeEffect(
  setup: (anime: AnimeModule) => (() => void) | void,
  deps: DependencyList = [],
) {
  // Re-run only when `deps` change, but always call the latest setup closure, so
  // it reads current props without re-importing animejs on every render. The ref
  // is updated in an effect, not during render; effects run in the order they are
  // declared, so it is current before the import below can resolve.
  const setupRef = useRef(setup);
  useEffect(() => {
    setupRef.current = setup;
  });

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | void;
    void import('animejs').then((anime) => {
      if (!cancelled) cleanup = setupRef.current(anime);
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
    // The caller's deps, by design: the setup closure is read from the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
