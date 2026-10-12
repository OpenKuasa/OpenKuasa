'use client';

import { Printer } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { Button } from '@/components/ui/button';
import type { LetterRow } from '@/lib/people/documents';
import { letterView } from '@/lib/people/letters-screens';
import { AcknowledgeLetterButton } from './letter-ack-button';

/**
 * Print styles. Hidden with `display: none`: every direct child of <body> except the dialog's content (the app shell
 * with its rail, nav, topbar and assistant button, and the overlay), and inside the dialog the elements marked
 * `data-letter-noprint` (the draft note and the button row). The letter (`article[data-letter-print]`) stays.
 */
const PRINT_CSS = `
@media print {
  /* The dialog's content is a direct child of <body> (Radix portal). Everything else directly under <body> is the
     app (rail, sidebar, topbar, main, assistant button) or the dialog's overlay: removed from the layout so no
     blank pages are printed. */
  body > *:not([data-letter-dialog]) { display: none !important; }
  html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
  [data-letter-dialog] {
    position: static !important; transform: none !important;
    width: 100% !important; max-width: none !important; max-height: none !important; overflow: visible !important;
    border: 0 !important; box-shadow: none !important; padding: 0 !important; background: #fff !important; color: #000 !important;
  }
  /* Inside the dialog: the buttons and the draft note. */
  [data-letter-noprint] { display: none !important; }
}
`;

/**
 * The printable letter: workspace name, the date, the employee's name, the title and the body as plain text with its
 * line breaks kept (it is never put in as HTML). A draft (owners and admins only) is marked as one. Opens from a
 * "View" button; "Print" calls the browser's print. A member's component: it names no owner-only action.
 */
export function LetterViewDialog({ letter, workspaceName }: { letter: LetterRow; workspaceName: string }) {
  const view = letterView(letter, workspaceName);
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label={`View ${letter.title}`}>
          View
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" data-letter-noprint />
        <Dialog.Content
          data-letter-dialog
          className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg outline-none"
        >
          <style>{PRINT_CSS}</style>
          <Dialog.Title className="sr-only">{view.title}</Dialog.Title>
          <Dialog.Description className="sr-only">
            A letter from {view.workspace} to {view.employee_name}.
          </Dialog.Description>
          {view.draft_note ? (
            <p className="mb-3 rounded-md bg-amber-500/15 px-3 py-2 text-sm font-medium text-amber-600" data-letter-noprint>
              {view.draft_note}
            </p>
          ) : null}
          <article data-letter-print className="space-y-4 bg-white p-6 text-black">
            {view.draft ? <p className="text-xs font-semibold uppercase tracking-wide">Draft</p> : null}
            <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-black/20 pb-3">
              <p className="text-base font-semibold">{view.workspace}</p>
              <p className="text-sm">{view.date_line}</p>
            </header>
            <p className="text-sm">
              <span className="font-semibold">To:</span> {view.employee_name}
            </p>
            <h2 className="text-lg font-semibold">{view.title}</h2>
            <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{view.body}</div>
          </article>
          <div className="mt-4 flex flex-wrap items-start justify-between gap-3" data-letter-noprint>
            <div>{view.can_acknowledge ? <AcknowledgeLetterButton letterId={letter.id} /> : null}</div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => window.print()}>
                <Printer aria-hidden />
                Print
              </Button>
              <Dialog.Close asChild>
                <Button type="button" variant="ghost" size="sm">
                  Close
                </Button>
              </Dialog.Close>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
