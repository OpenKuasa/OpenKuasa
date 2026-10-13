'use client';

import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertDialog } from 'radix-ui';
import { deleteApplicationAction, deleteCandidateAction, getDeletionSummaryAction } from '@/app/(app)/hire/actions';
import {
  DELETION_NOTICE_ID, LOADING, canConfirm, confirmLabel, dialogBody, focusIdAfter, mayClose, summaryFrom,
  type DeleteTarget, type SummaryState,
} from '@/lib/hire/delete-dialog-state';
import { DELETE_FAILED, confirmTitle } from '@/lib/hire/deletion';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

// The same sizes and looks as the other hiring controls (see application-actions.tsx).
const TARGET = 'min-h-11 min-w-11';
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
const WAITING = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:active:translate-y-0';
const ALERT_CLASS = 'rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive';
const OVERLAY_CLASS = 'fixed inset-0 z-50 bg-black/40';
const CONTENT_CLASS =
  'fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-background p-5 shadow-lg outline-none max-h-[85vh] overflow-y-auto';

// ─── the notice line ─────────────────────────────────────────────────────────
// The row or card that was acted on disappears with the deletion, and any message inside it would go too.
// So each screen has one line that stays, and the dialog writes its success sentence there.

let notice = '';
/** Results said on this screen are numbered: only the newest is shown, wherever it was said. */
let latest = 0;
let noticeSeq = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const tell = () => {
  for (const listener of listeners) listener();
};

/**
 * Puts a sentence on the screen's notice line, where it is read out: a deletion's, or a talent pool change's.
 * It becomes the newest result on the screen, so any older result line elsewhere on it empties.
 */
export function announceDeletion(message: string): void {
  latest += 1;
  noticeSeq = latest;
  notice = message;
  tell();
}

/**
 * A result said somewhere else on the screen (a card's own line, a row's refusal) takes over as the newest: the
 * notice line and every older result line empty. Answers the result's number, for `useNewest`.
 */
export function claimResult(): number {
  latest += 1;
  tell();
  return latest;
}

/** What the notice line shows now: its sentence while that is the newest result on the screen, else nothing. */
export const shownNotice = (): string => (noticeSeq === latest ? notice : '');

/** True while the result with this number is still the newest said on the screen. */
export function useNewest(seq: number | null): boolean {
  const now = useSyncExternalStore(subscribe, () => latest, () => 0);
  return seq !== null && seq === now;
}

/**
 * One polite live region, always in the page so a change to its text is
 * announced. Focusable by script only: focus lands here when the row that held
 * the opener has gone. Drawn once per screen, only for someone who may edit.
 */
export function DeletionNotice({ className }: { className?: string }) {
  const message = useSyncExternalStore(subscribe, shownNotice, () => '');
  // The sentence belongs to the screen it was said on: leaving the screen clears it.
  useEffect(() => () => {
    notice = '';
  }, []);
  return (
    <p
      id={DELETION_NOTICE_ID}
      tabIndex={-1}
      aria-live="polite"
      className={cn('rounded-sm text-sm text-muted-foreground', FOCUS, !message && 'sr-only', className)}
    >
      {message}
    </p>
  );
}

/** Puts focus on an element that outlives the deleted row, if nothing else has taken it. Tried twice: the screen is fetched again in between. */
function focusLater(id: string | null) {
  if (!id) return;
  const go = () => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    document.getElementById(id)?.focus();
  };
  window.setTimeout(go, 0);
  window.setTimeout(go, 300);
}

// ─── the dialog ──────────────────────────────────────────────────────────────

/**
 * The body and the two buttons. Mounted afresh each time the dialog opens, so
 * it always starts by asking what would go. The delete button cannot be used
 * until that answer is on screen, and never if it could not be read.
 */
function DeleteBody({
  target,
  onBusy,
  onDeleted,
}: {
  target: DeleteTarget;
  /** Told true at the press and false at the answer, so the dialog lets Escape and Cancel do nothing meanwhile. */
  onBusy: (busy: boolean) => void;
  onDeleted: (message: string) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [summary, setSummary] = useState<SummaryState>(LOADING);
  const [error, setError] = useState<string | null>(null);
  /** True from the press until the answer: `pending` only turns true on the next render. */
  const inFlight = useRef(false);
  const { kind, id } = target;
  const setBusy = (busy: boolean) => {
    inFlight.current = busy;
    onBusy(busy);
  };

  useEffect(() => {
    let live = true;
    getDeletionSummaryAction({ kind, id }).then(
      (result) => {
        if (live) setSummary(summaryFrom(result));
      },
      () => {
        if (live) setSummary(summaryFrom(null));
      },
    );
    return () => {
      live = false;
    };
  }, [kind, id]);

  function confirm() {
    if (!canConfirm(summary, pending || inFlight.current)) return;
    setBusy(true);
    // Cleared first, so the same refusal twice in a row is announced twice.
    setError(null);
    start(async () => {
      try {
        const result = kind === 'application' ? await deleteApplicationAction({ id }) : await deleteCandidateAction({ id });
        if (result.ok) {
          setBusy(false);
          onDeleted(result.data.message);
          return;
        }
        // A refusal is usually someone else's change: show the sentence and fetch the screen again.
        setError(result.error);
        router.refresh();
      } catch {
        setError(DELETE_FAILED);
        router.refresh();
      } finally {
        setBusy(false);
      }
    });
  }

  const unavailable = pending || !canConfirm(summary, false) || undefined;
  return (
    <>
      {/* A live region: "Checking…" and then the numbers are both read out. */}
      <AlertDialog.Description aria-live="polite" className="mt-1 text-sm break-words text-muted-foreground">
        {dialogBody(kind, summary)}
      </AlertDialog.Description>
      {error && (
        <p role="alert" className={cn(ALERT_CLASS, 'mt-3')}>
          {error}
        </p>
      )}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <AlertDialog.Cancel asChild>
          <Button type="button" variant="outline" size="sm" className={cn(TARGET, WAITING)} aria-disabled={pending || undefined}>
            Cancel
          </Button>
        </AlertDialog.Cancel>
        <AlertDialog.Action asChild>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className={cn(TARGET, WAITING)}
            aria-disabled={unavailable}
            onClick={(event) => {
              // Stay open while it is saved: a refusal is shown here, and only success closes the dialog.
              event.preventDefault();
              confirm();
            }}
          >
            {confirmLabel(kind, pending)}
          </Button>
        </AlertDialog.Action>
      </div>
    </>
  );
}

/**
 * "Delete Aina Rahman?" / "Delete Aina Rahman's application for Barista?".
 * Open while `target` is set. Focus starts on Cancel. Escape and Cancel change
 * nothing; a click outside does not close it; neither does anything while a
 * deletion is being saved. After a deletion the success sentence goes to the
 * screen's notice line and focus to `focusAfterId`, or to that line.
 */
export function DeleteDialog({
  target,
  onClose,
  returnFocus,
  focusAfterId,
}: {
  target: DeleteTarget | null;
  onClose: () => void;
  /** Gives focus back to what opened the dialog, when it closed without deleting. */
  returnFocus: () => void;
  /** An element that is still in the page after the deletion (a board column's heading). */
  focusAfterId?: string;
}) {
  const busy = useRef(false);
  const deleted = useRef(false);
  return (
    <AlertDialog.Root
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && mayClose(busy.current)) onClose();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={OVERLAY_CLASS} />
        <AlertDialog.Content
          className={CONTENT_CLASS}
          // There is no Radix trigger, so Radix has nothing to give focus back to: this does it.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const id = focusIdAfter(deleted.current, focusAfterId);
            deleted.current = false;
            if (!id) {
              returnFocus();
              return;
            }
            document.getElementById(id)?.focus();
            focusLater(id);
          }}
        >
          {target && (
            <>
              <AlertDialog.Title className="text-base font-semibold break-words">
                {confirmTitle(target.kind, target.name, target.job)}
              </AlertDialog.Title>
              <DeleteBody
                key={`${target.kind}:${target.id}`}
                target={target}
                onBusy={(value) => {
                  busy.current = value;
                }}
                onDeleted={(message) => {
                  deleted.current = true;
                  announceDeletion(message);
                  // The card may be taken out of the page before the dialog has finished closing.
                  focusLater(focusIdAfter(true, focusAfterId));
                  onClose();
                }}
              />
            </>
          )}
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
