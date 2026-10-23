'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { deleteFinanceAgentNoteAction } from '@/app/(app)/finance/agent-actions';
import { Button } from '@/components/ui/button';
import type { FinanceNoteView } from '@/screens/finance/agents-view';

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur' });
}

/**
 * The notes the agent left once approved, newest first: what it is about, the note, who approved
 * it and when, a link to the document's screen, and Delete for anyone who edits the workspace's data.
 */
export function AgentNotesList({ notes, canEdit }: { notes: FinanceNoteView[] | null; canEdit: boolean }) {
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (notes === null) {
    return <p className="grid min-h-16 place-items-center text-center text-sm text-muted-foreground">Couldn&apos;t load the notes — please refresh</p>;
  }
  if (notes.length === 0) {
    return (
      <p className="grid min-h-16 place-items-center text-center text-sm text-muted-foreground">
        No notes yet. Approving a suggestion adds its note here.
      </p>
    );
  }

  function remove(id: string) {
    setError(null);
    setBusyId(id);
    start(async () => {
      try {
        const res = await deleteFinanceAgentNoteAction(id);
        if (!res.ok) setError(res.error);
      } catch {
        setError('Something went wrong.');
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <div className="space-y-2">
      <ul className="divide-y rounded-md border">
        {notes.map((n) => (
          <li key={n.id} className="space-y-1 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{n.entityLabel}</span>
              <span className="text-xs text-muted-foreground">
                {n.approvedBy ? `Approved by ${n.approvedBy}` : 'Approved'} · {formatWhen(n.createdAt)}
              </span>
            </div>
            <p className="whitespace-pre-wrap">{n.body}</p>
            <div className="flex flex-wrap gap-2 pt-1">
              {n.href && (
                <Button asChild size="sm" variant="outline">
                  <Link href={n.href}>View</Link>
                </Button>
              )}
              {canEdit && (
                <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => remove(n.id)}>
                  {busyId === n.id ? 'Deleting…' : 'Delete'}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
