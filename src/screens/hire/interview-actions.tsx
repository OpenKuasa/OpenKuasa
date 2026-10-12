'use client';

import { Fragment, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertDialog } from 'radix-ui';
import { MoreHorizontal, Plus } from 'lucide-react';
import { cancelInterviewAction, reopenInterviewAction, setInterviewOutcomeAction } from '@/app/(app)/hire/actions';
import { DELETION_NOTICE_ID } from '@/lib/hire/delete-dialog-state';
import {
  KEEP_INTERVIEW, MENU_WORDS, NO_INVITATION, cancelBody, cancelLabel, cancelTitle, interviewResult, inviteLead, inviteSourceOfRow, inviteTitle,
  mayClose, mayHandOver, menuGroups, menuName, noticeOf, openerId, outcomeInput, refusalWord, rowMenu, sayOnNotice,
} from '@/lib/hire/interview-dialog-state';
import { invitationText, type InviteSource } from '@/lib/hire/interview-invite';
import { INTERVIEW_SAVE_FAILED, type InterviewMenuItem } from '@/lib/hire/interviews';
import type { InterviewRow } from '@/lib/hire/lists';
import { cn } from '@/lib/utils';
import { FormDialog } from '@/screens/hire/candidate-forms';
import { announceDeletion, claimResult, useNewest } from '@/screens/hire/delete-dialog';
import { InvitationStep, openInterview, useServerClock } from '@/screens/hire/interview-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// The same sizes and looks as the other hiring controls (see pool-actions.tsx and delete-dialog.tsx).
const TARGET = 'min-h-11 min-w-11';
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
const WAITING = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:active:translate-y-0';
const ALERT_CLASS = 'rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive';
const OVERLAY_CLASS = 'fixed inset-0 z-50 bg-black/40';
const CONTENT_CLASS =
  'fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-background p-5 shadow-lg outline-none max-h-[85vh] overflow-y-auto';
const HELP = 'text-xs text-muted-foreground';
const ITEM = 'min-h-11 px-2';

/** Puts focus on the screen's notice line once the row that held it has gone, if nothing else has taken it. */
function focusNoticeSoon() {
  const go = () => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    document.getElementById(DELETION_NOTICE_ID)?.focus();
  };
  window.setTimeout(go, 0);
  window.setTimeout(go, 300);
}

/**
 * The two buttons in the Interviews header. Each opens the screen's dialog
 * with the application picker; "Record a past interview" is the quieter one,
 * so the two paths are not mistaken for each other. Drawn only for someone
 * who may edit.
 */
export function InterviewHeaderButtons() {
  return (
    <>
      <Button
        id={openerId('header-past')}
        type="button"
        variant="outline"
        size="sm"
        className={TARGET}
        onClick={() => openInterview({ mode: 'past', application: null, focusId: openerId('header-past') })}
      >
        Record a past interview
      </Button>
      <Button
        id={openerId('header-schedule')}
        type="button"
        size="sm"
        className={TARGET}
        onClick={() => openInterview({ mode: 'schedule', application: null, focusId: openerId('header-schedule') })}
      >
        <Plus className="size-4" aria-hidden />
        Schedule interview
      </Button>
    </>
  );
}

/**
 * One change to one interview at a time, from its row. What it did goes to
 * the screen's notice line. `error` is the capability's own sentence, or the
 * generic one when the call did not come back; it is shown only while it is
 * the newest thing said on the screen. A second press while one is being saved
 * does nothing. A refusal also asks the server for the screen again: what was
 * refused is usually a change someone else already made.
 */
function useInterviewChange() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [refusal, setRefusal] = useState<{ text: string; seq: number } | null>(null);
  const newest = useNewest(refusal?.seq ?? null);
  /** True from the press until the answer: `pending` only turns true on the next render. */
  const inFlight = useRef(false);
  /** `onClose` closes whatever dialog asked: after a save, and when the interview turned out to be gone. */
  const send = (call: () => Promise<unknown>, onClose?: () => void, onSettled?: () => void) => {
    if (inFlight.current) return;
    inFlight.current = true;
    // Cleared first, so the same refusal twice in a row is announced twice.
    setRefusal(null);
    start(async () => {
      try {
        const result = interviewResult(await call());
        if (result.ok) {
          announceDeletion(noticeOf(result.change));
          onClose?.();
        } else if (sayOnNotice(refusalWord(result.error, 'interview'))) {
          // The interview has gone (with its application), and this row goes with the refresh: the notice line outlives
          // it. A confirm that was open for it closes, so it does not sit there with nothing to confirm.
          announceDeletion(result.error);
          onClose?.();
          focusNoticeSoon();
          router.refresh();
        } else {
          setRefusal({ text: result.error, seq: claimResult() });
          router.refresh();
        }
      } catch {
        // The answer was lost: the fresh row shows whether the change in fact happened.
        setRefusal({ text: INTERVIEW_SAVE_FAILED, seq: claimResult() });
        router.refresh();
      } finally {
        inFlight.current = false;
        onSettled?.();
      }
    });
  };
  /** Something that was asked for cannot be done, and nothing was sent: said at the row, and the row is fetched again. */
  const refuse = (text: string) => {
    setRefusal({ text, seq: claimResult() });
    router.refresh();
  };
  return { pending, error: refusal && newest ? refusal.text : null, inFlight, send, refuse, clearError: () => setRefusal(null) };
}

/**
 * The menu of a row of the Interviews table. For a scheduled interview:
 * "Reschedule or edit" (left out when its application is no longer active),
 * "Invitation and calendar file", then "Mark completed" and "Mark no-show",
 * then, last and alone, "Cancel interview". For a cancelled, completed or
 * no-show one: "Mark as scheduled again". Only drawn for someone who may
 * edit; every action checks again.
 *
 * The two outcomes and "scheduled again" act at once: each is undone in one
 * tap. Cancelling asks first. The row stays in the list after every change
 * here, so focus goes back to this button.
 */
export function InterviewRowMenu({
  row, workspace, serverNow,
}: {
  row: InterviewRow;
  workspace: string | null;
  /** The instant the server drew the screen with: whether an invitation can still be handed over is told from it. */
  serverNow?: string;
}) {
  const change = useInterviewChange();
  const clock = useServerClock(serverNow);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<'invitation' | 'cancel' | null>(null);
  /** What the invitation panel shows: made when the item is chosen, from the row as it then is. */
  const [invite, setInvite] = useState<{ text: string; source: InviteSource } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  /** An item that opens something was chosen: it opens once the menu has closed. */
  const then = useRef<'edit' | 'invitation' | 'cancel' | null>(null);
  /** True while the cancellation is being saved: Escape and "Keep interview" then do nothing. */
  const busy = useRef(false);
  const triggerId = openerId('row', row.id);
  const groups = menuGroups(rowMenu(row));
  const waiting = change.pending || undefined;

  const choose = (item: InterviewMenuItem) => {
    if (item === 'edit' || item === 'invitation' || item === 'cancel') {
      then.current = item;
      return;
    }
    if (item === 'reopen') {
      change.send(() => reopenInterviewAction({ id: row.id }));
      return;
    }
    change.send(() => setInterviewOutcomeAction(outcomeInput(row.id, item)));
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          // While a change is being saved the menu stays shut: one change at a time.
          if (next && (change.pending || change.inFlight.current)) return;
          setOpen(next);
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            ref={trigger}
            id={triggerId}
            type="button"
            aria-label={menuName(row.name)}
            aria-disabled={waiting}
            className={cn('grid shrink-0 place-items-center rounded-md hover:bg-muted', TARGET, FOCUS, WAITING, 'aria-disabled:hover:bg-transparent')}
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-64"
          onCloseAutoFocus={(event) => {
            const next = then.current;
            if (!next) return;
            // The dialog takes focus now, and gives it back to this button when it closes.
            then.current = null;
            if (next === 'invitation') {
              // Made now, with the clock as it is now, and never from the notes. Nothing is handed over for a start
              // that has passed or cannot be read: the row says so, focus stays on this button, and nothing opens.
              const source = inviteSourceOfRow(row, workspace);
              const now = clock();
              const text: string | null = mayHandOver(source.scheduled_at, source.duration_minutes, now)
                ? invitationText(source, false, now)
                : null;
              if (!text) {
                change.refuse(NO_INVITATION);
                return;
              }
              setInvite({ text, source });
            }
            event.preventDefault();
            change.clearError();
            // The row as it is now: the form sends its `updatedAt`, so a later change by someone else is refused, not replaced.
            if (next === 'edit') openInterview({ mode: 'change', row, focusId: triggerId });
            else setPanel(next);
          }}
        >
          {groups.map((group, index) => (
            <Fragment key={group[0]}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              {group.map((item) => (
                <DropdownMenuItem
                  key={item}
                  // The danger colour and its words: colour is never the only signal.
                  variant={item === 'cancel' ? 'destructive' : undefined}
                  className={ITEM}
                  onSelect={() => choose(item)}
                >
                  {MENU_WORDS[item]}
                </DropdownMenuItem>
              ))}
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Always in the page, so "Saving…" is announced. It takes a line only while there is something to say. */}
      <p aria-live="polite" className={cn(HELP, !change.pending && 'sr-only')}>{change.pending ? 'Saving…' : ''}</p>
      {/* While the cancel confirm is open the refusal is shown inside it. */}
      {change.error && panel === null ? (
        <p role="alert" className={cn(ALERT_CLASS, 'max-w-xs text-left whitespace-normal')}>{change.error}</p>
      ) : null}

      {/* "Cancel the interview with Aina Rahman?" Focus starts on "Keep interview", so Enter on a freshly opened dialog cancels nothing. A click outside does not close it. */}
      <AlertDialog.Root
        open={panel === 'cancel'}
        onOpenChange={(next) => {
          if (!next && mayClose(busy.current)) setPanel(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={OVERLAY_CLASS} />
          <AlertDialog.Content
            className={CONTENT_CLASS}
            // There is no Radix trigger, so Radix has nothing to give focus back to: this does it.
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              trigger.current?.focus();
            }}
          >
            <AlertDialog.Title className="text-base font-semibold break-words">{cancelTitle(row.name)}</AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm break-words text-muted-foreground">{cancelBody(row)}</AlertDialog.Description>
            {change.error ? <p role="alert" className={cn(ALERT_CLASS, 'mt-3')}>{change.error}</p> : null}
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="outline" size="sm" className={cn(TARGET, WAITING)} aria-disabled={waiting}>
                  {KEEP_INTERVIEW}
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className={cn(TARGET, WAITING)}
                  aria-disabled={waiting}
                  onClick={(event) => {
                    // Stay open while it is saved: a refusal is shown here, and only success closes the dialog.
                    event.preventDefault();
                    if (change.pending || change.inFlight.current) return;
                    busy.current = true;
                    change.send(
                      () => cancelInterviewAction({ id: row.id }),
                      () => setPanel(null),
                      () => {
                        busy.current = false;
                      },
                    );
                  }}
                >
                  {cancelLabel(change.pending)}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      {/* "Invitation and calendar file": the invitation step on its own, made from the row, with no move button. */}
      <FormDialog
        open={panel === 'invitation'}
        title={inviteTitle('row')}
        description={inviteLead(row.name)}
        discardTitle=""
        dirty={false}
        pending={false}
        onClose={() => setPanel(null)}
        returnFocus={() => trigger.current?.focus()}
      >
        {(requestClose) =>
          invite ? (
            <InvitationStep text={invite.text} source={invite.source} moveFor={null} onDone={requestClose} clock={clock} />
          ) : null
        }
      </FormDialog>
    </div>
  );
}
