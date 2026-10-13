'use client';

import { useState, useTransition } from 'react';
import { Download } from 'lucide-react';
import { documentLinkAction } from '@/app/(app)/people/document-actions';
import { Button } from '@/components/ui/button';
import { POPUP_BLOCKED, downloadStep } from '@/lib/people/documents-screens';

/**
 * Opens a document's file in a new tab through a link that lasts one minute. The tab is opened on the click itself
 * (a pop-up blocker lets that through) and pointed at the link when it arrives; if the link cannot be made the tab is
 * closed and the sentence shows here. The link is only ever a local value: it is not kept in state, logged or drawn.
 * The caller draws this only for a row whose `can_download` is true.
 */
export function DocumentDownload({ documentId, title }: { documentId: string; title: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    setError(null);
    const tab = window.open('about:blank', '_blank');
    if (!tab) {
      setError(POPUP_BLOCKED);
      return;
    }
    tab.opener = null;
    start(async () => {
      let step: ReturnType<typeof downloadStep>;
      try {
        step = downloadStep(await documentLinkAction({ document_id: documentId }));
      } catch {
        step = downloadStep(null);
      }
      if (step.action === 'open') {
        tab.location.href = step.url;
        return;
      }
      tab.close();
      setError(step.message);
    });
  };

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button type="button" variant="ghost" size="sm" disabled={pending} aria-label={`Download ${title}`} onClick={open}>
        <Download aria-hidden />
        {pending ? 'Opening…' : 'Download'}
      </Button>
      {error ? (
        <span role="alert" className="max-w-56 text-right text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
