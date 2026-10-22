'use client';

import { useEffect } from 'react';

export const UNSAVED_PROMPT = 'You have unsaved changes. Leave this page and lose them?';

/**
 * While `dirty`, warn before the changes are lost: the browser's own prompt on reload or close, and a confirm on any
 * click on a link to another page of the app (client-side navigation fires no unload event). A link opened in a new
 * tab, or one marked `data-unsaved-ok`, is let through.
 */
export function useUnsavedGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.('a[href]');
      if (!(link instanceof HTMLAnchorElement) || link.target === '_blank' || link.hasAttribute('download')) return;
      if (link.dataset.unsavedOk !== undefined) return;
      const to = new URL(link.href, window.location.href);
      if (to.origin !== window.location.origin) return;
      if (to.pathname === window.location.pathname && to.search === window.location.search) return;
      if (!window.confirm(UNSAVED_PROMPT)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);
}
