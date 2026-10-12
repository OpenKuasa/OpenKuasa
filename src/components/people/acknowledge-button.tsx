'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { acknowledgeDocumentAction } from '@/app/(app)/people/document-actions';
import { acknowledgeLetterAction } from '@/app/(app)/people/letter-actions';
import { Button } from '@/components/ui/button';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { ACK_BUTTON, ACK_NOTE } from '@/lib/people/documents-screens';

/**
 * "I have read this" on a document or a letter that asks for it, with the line that says what it records. The
 * employee is the signed-in person: the action takes the id of the item and nothing about who is acknowledging.
 * A refusal shows beside the button. When it is recorded the route is refreshed, which re-reads the list and the
 * navigation count. The caller draws this only for a row whose `can_acknowledge` is true (never in the sample
 * company).
 */
export function AcknowledgeButton({ id, kind }: { id: string; kind: 'document' | 'letter' }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const acknowledge = () => {
    setError(null);
    start(async () => {
      try {
        const result =
          kind === 'document'
            ? await acknowledgeDocumentAction({ document_id: id })
            : await acknowledgeLetterAction({ letter_id: id });
        if (result.ok) router.refresh();
        else setError(result.error);
      } catch {
        setError(WRITE_FAILED);
      }
    });
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <Button type="button" size="sm" disabled={pending} onClick={acknowledge}>
        {pending ? 'Recording…' : ACK_BUTTON}
      </Button>
      <p className="max-w-56 text-xs text-muted-foreground">{ACK_NOTE}</p>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
