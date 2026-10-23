'use client';

import { useEffect, useState } from 'react';
import { formatDay, klDay } from '@/lib/crm/deal-stats';
import type { RecordNote } from '@/lib/crm/notes';

/**
 * A deal's or contact's notes, newest first. A body is shown as plain text
 * with its line breaks kept: never as markup. Nothing is drawn without notes.
 */
export function RecordNotes({ notes }: { notes: RecordNote[] }) {
  if (notes.length === 0) return null;

  return (
    <section aria-label="Notes" className="mt-4 space-y-2 border-t pt-4">
      <h3 className="text-sm font-medium">Notes</h3>
      <ul className="space-y-2">
        {notes.map((note) => (
          <li key={note.id} className="rounded-md border bg-muted/30 px-3 py-2">
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <time dateTime={note.createdAt}>{formatDay(klDay(new Date(note.createdAt)))}</time>
              {note.fromAgent ? (
                <span className="rounded-full bg-muted px-1.5 py-px text-[0.7rem] font-medium text-muted-foreground">
                  from the agent
                </span>
              ) : null}
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{note.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Loads a record's notes when its pop-up opens and shows them. While they load,
 * and when they cannot be loaded, nothing is shown.
 */
export function LoadedRecordNotes({
  recordId,
  load,
}: {
  recordId: string;
  /** Hands back the record's notes, or null when they cannot be had. */
  load: (id: string) => Promise<RecordNote[] | null>;
}) {
  const [loaded, setLoaded] = useState<{ id: string; notes: RecordNote[] } | null>(null);

  useEffect(() => {
    let current = true;
    load(recordId)
      .then((notes) => {
        if (current && notes) setLoaded({ id: recordId, notes });
      })
      .catch(() => {
        // No notes section; the pop-up still works.
      });
    return () => {
      current = false;
    };
  }, [recordId, load]);

  return loaded?.id === recordId ? <RecordNotes notes={loaded.notes} /> : null;
}
