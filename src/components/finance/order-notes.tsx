/**
 * Advice about the purchase orders behind the bills being paid, one sentence each, shown as a status and never
 * as a refusal. The container is always drawn, so a reader announces a note when it appears.
 */
export function OrderNotes({ notes }: { notes: string[] }) {
  return (
    <div role="status" className="space-y-1">
      {notes.map((note) => (
        <p key={note} className="text-xs text-amber-600">
          {note}
        </p>
      ))}
    </div>
  );
}
