import { NotebookPen } from 'lucide-react';
import type { NoteCount } from '@/lib/finance/agent/notes';

/**
 * The small "agent note" marker on a document's row: how many notes the agent left on it, with
 * the newest as its tooltip. Nothing when the document has none (or the counts could not be read).
 */
export function AgentNoteMarker({ note }: { note: NoteCount | undefined }) {
  if (!note || note.count < 1) return null;
  const label = `${note.count} ${note.count === 1 ? 'note' : 'notes'} from the agent`;
  return (
    <span
      title={note.latest}
      aria-label={label}
      className="ml-2 inline-flex items-center gap-0.5 rounded-full bg-sky-500/15 px-1.5 py-0.5 align-middle text-[11px] font-semibold text-sky-700 dark:text-sky-400"
    >
      <NotebookPen className="size-3" aria-hidden="true" />
      {note.count}
    </span>
  );
}
