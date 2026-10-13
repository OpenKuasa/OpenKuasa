'use client';

import { useCallback, useRef, useState } from 'react';
import type { ReceiptLink } from '@/lib/finance/receipt-inbox';
import type { FinResult } from '@/lib/finance/result';
import { downloadReceipt } from './receipt-upload';

/**
 * One receipt download at a time, with its own state. It deliberately does not
 * run in a React transition: a transition's pending state is shared with every
 * other action on the page, so a slow transfer would hold a refused save in
 * "Saving…" until the file arrived.
 */
export function useReceiptDownload(linkOf: (input: unknown) => Promise<FinResult<ReceiptLink>>) {
  /** The name of the file being fetched, as text, or null. */
  const [busyWith, setBusyWith] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  const start = useCallback(
    async (id: string, fileName: string) => {
      if (running.current) {
        setError('A download is still running. Wait for it to finish, then try again.');
        return;
      }
      running.current = true;
      setError(null);
      setBusyWith(fileName);
      try {
        const result = await downloadReceipt(linkOf, id);
        if (!result.ok) setError(result.error);
      } finally {
        running.current = false;
        setBusyWith(null);
      }
    },
    [linkOf],
  );

  return { busyWith, error, start };
}
