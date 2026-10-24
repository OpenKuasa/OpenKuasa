'use client';

import { useEffect } from 'react';
import { captureInstallPrompt } from '@/lib/pwa/install';

/** Registers the service worker (production only) and keeps the browser's install prompt for the install links. */
export function PwaSetup() {
  useEffect(() => {
    const stop = captureInstallPrompt();
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
        // Not installable on this visit; the site works the same without it.
      });
    }
    return stop;
  }, []);
  return null;
}
