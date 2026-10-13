'use client';

import { useState, useTransition } from 'react';
import { claimReceiptUrlAction } from '@/app/(app)/people/pay-actions';
import { Button } from '@/components/ui/button';

/**
 * A claim's receipt: "View receipt" when there is a file (asks the server for a
 * short-lived link and opens it), "Receipt on file" when a sample claim is only
 * ticked, and "No receipt" otherwise.
 */
export function ReceiptLink({ claimId, hasFile, ticked }: { claimId: string; hasFile: boolean; ticked: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!hasFile) {
    return <span className="text-sm text-muted-foreground">{ticked ? 'Receipt on file' : 'No receipt'}</span>;
  }

  const open = () => {
    setError(null);
    // Opened first, while the click still counts, so a pop-up blocker lets it through.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    start(async () => {
      let result: Awaited<ReturnType<typeof claimReceiptUrlAction>>;
      try {
        result = await claimReceiptUrlAction({ id: claimId });
      } catch {
        result = { ok: false, error: 'The receipt could not be opened. Please try again.' };
      }
      if (!result.ok) {
        tab?.close();
        setError(result.error);
        return;
      }
      if (tab) tab.location.href = result.data.url;
      else window.location.assign(result.data.url);
    });
  };

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={open} disabled={pending}>
        {pending ? 'Opening…' : 'View receipt'}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
