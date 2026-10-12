'use client';

import { useSyncExternalStore } from 'react';
import { localIsoDate } from '@/lib/finance/bill-math';

/** Check again every minute, so a tab left open over midnight moves to the new day. */
function subscribe(onChange: () => void): () => void {
  const timer = setInterval(onChange, 60_000);
  return () => clearInterval(timer);
}

/**
 * The date a screen works its periods out from. While the page is rendered on
 * the server, and for the first render in the browser, it is the server's date,
 * so the two agree; after that it is the person's own local date, which is the
 * date their forms put on a new row. `follow` false keeps the given date (the
 * sample data's fixed day).
 */
export function useLocalToday(serverToday: string, follow = true): string {
  const local = useSyncExternalStore(
    subscribe,
    () => localIsoDate(new Date()),
    () => serverToday,
  );
  return follow ? local : serverToday;
}
