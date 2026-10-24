'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Trash2 } from 'lucide-react';
import { deletePeopleAgentNoteAction } from '@/app/(app)/people/agent-actions';
import { Button } from '@/components/ui/button';
import type { PeopleNoteView } from '@/screens/people/agents-view';

type DeleteResult = { ok: true } | { ok: false; error: string };

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur' });
}

/** Deletes one note: null when it went, else the sentence to show. Never throws. */
async function deleteNoteStep(action: (id: string) => Promise<DeleteResult>, id: string): Promise<string | null> {
  try {
    const res = await action(id);
    return res.ok ? null : res.error;
  } catch {
    return 'Something went wrong.';
  }
}

export type PeopleNotesListState = {
  /** The note whose Delete is being asked about. */
  confirmingId: string | null;
  pending: boolean;
  /** The refusal of the last delete, shown under its question. */
  error: string | null;
};

/**
 * The list itself, with no state of its own: what is being asked and what went wrong come in,
 * presses go out. {@link PeopleAgentNotesList} holds the state.
 */
export function PeopleAgentNotesListBody({
  notes,
  canEdit,
  state,
  onAsk,
  onConfirm,
  onCancel,
}: {
  notes: PeopleNoteView[] | null;
  canEdit: boolean;
  state: PeopleNotesListState;
  onAsk: (id: string) => void;
  onConfirm: (id: string) => void;
  onCancel: () => void;
}) {
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
  return (
    <ul className="divide-y rounded-md border">
      {notes.map((n) => {
        const asking = canEdit && state.confirmingId === n.id;
        return (
          <li key={n.id} className="space-y-1 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{n.entityLabel}</span>
              <span className="text-xs text-muted-foreground">
                {n.approvedBy ? `Approved by ${n.approvedBy}` : 'Approved'} · {formatWhen(n.createdAt)}
              </span>
            </div>
            <p className="whitespace-pre-wrap">{n.body}</p>
            {asking ? (
              <div
                role="group"
                aria-label={`Delete note on ${n.entityLabel}`}
                className="flex flex-wrap items-center gap-3 rounded-md bg-destructive/5 p-2"
                onKeyDown={(event) => {
                  if (event.key !== 'Escape' || state.pending) return;
                  event.stopPropagation();
                  onCancel();
                }}
              >
                <div className="min-w-48 flex-1 space-y-1">
                  <p>Delete this note? The record itself is not changed.</p>
                  {state.error ? (
                    <p role="alert" className="text-destructive">
                      {state.error}
                    </p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  aria-disabled={state.pending}
                  className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                  onClick={() => {
                    if (!state.pending) onConfirm(n.id);
                  }}
                >
                  <Trash2 className="size-4" />
                  {state.pending ? 'Deleting…' : 'Delete note'}
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={state.pending} onClick={onCancel} autoFocus>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2 pt-1">
                {n.href && (
                  <Button asChild size="sm" variant="outline">
                    <Link href={n.href} aria-label={`View ${n.entityLabel}`}>
                      View
                    </Link>
                  </Button>
                )}
                {canEdit && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete note on ${n.entityLabel}`}
                    disabled={state.pending}
                    onClick={() => onAsk(n.id)}
                  >
                    Delete
                  </Button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The notes the agent left once HR approved them, newest first: who or what it is about, the note,
 * who approved it and when, a link to the record's screen, and Delete (asked first). The page is
 * HR-only, so `canEdit` is true there.
 */
export function PeopleAgentNotesList({ notes, canEdit }: { notes: PeopleNoteView[] | null; canEdit: boolean }) {
  const [pending, start] = useTransition();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <PeopleAgentNotesListBody
      notes={notes}
      canEdit={canEdit}
      state={{ confirmingId, pending, error }}
      onAsk={(id) => {
        setError(null);
        setConfirmingId(id);
      }}
      onCancel={() => {
        setError(null);
        setConfirmingId(null);
      }}
      onConfirm={(id) => {
        setError(null);
        start(async () => {
          const refusal = await deleteNoteStep(deletePeopleAgentNoteAction, id);
          setError(refusal);
          // Gone: the refreshed list no longer has it. Refused: the question stays, with why.
          if (refusal === null) setConfirmingId(null);
        });
      }}
    />
  );
}
