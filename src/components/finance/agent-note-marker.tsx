import { NotebookPen } from 'lucide-react';
import type { NoteCount } from '@/lib/finance/agent/notes';

/** What a screen reader hears for the marker: the count and the newest note. */
export function agentNoteText(note: NoteCount): string {
  return `${note.count} agent ${note.count === 1 ? 'note' : 'notes'}: ${note.latest}`;
}

/**
 * The small "agent note" marker on a document's row: how many notes the agent left on it, with
 * the newest as its tooltip (and read out in full by a screen reader). Nothing when the document
 * has none (or the counts could not be read).
 */
export function AgentNoteMarker({ note }: { note: NoteCount | undefined }) {
  if (!note || note.count < 1) return null;
  return (
    <span
      title={note.latest}
      className="ml-2 inline-flex items-center gap-0.5 rounded-full bg-sky-500/15 px-1.5 py-0.5 align-middle text-[11px] font-semibold text-sky-700 dark:text-sky-400"
    >
      <NotebookPen className="size-3" aria-hidden="true" />
      <span aria-hidden="true">{note.count}</span>
      <span className="sr-only">{agentNoteText(note)}</span>
    </span>
  );
}
