'use client';

import { Fragment, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertDialog } from 'radix-ui';
import { MoreHorizontal, Plus } from 'lucide-react';
import {
  cancelInterviewAction, clearInterviewFeedbackAction, getInterviewInvitationAction, reopenInterviewAction, setInterviewOutcomeAction,
} from '@/app/(app)/hire/actions';
import { DELETION_NOTICE_ID } from '@/lib/hire/delete-dialog-state';
import {
  CLEAR_BODY, KEEP_FEEDBACK, ROW_MENU_WORDS, clearLabel, clearTitle, isDestructive, modeOf, reopenRefusal, rowMenuWithFeedback,
  type FeedbackMode, type RowMenuItem,
} from '@/lib/hire/feedback-dialog-state';
import {
  KEEP_INTERVIEW, cancelBody, cancelLabel, cancelTitle, handoverAfter, handoverResult, interviewResult, inviteLead, inviteTitle,
  mayAskHandover, mayClose, menuName, noticeOf, openerId, outcomeInput, refusalWord, rowWaitingWord, sayOnNotice,
  type Handover, type HandoverState,
} from '@/lib/hire/interview-dialog-state';
import { INTERVIEW_SAVE_FAILED, INVITATION_NOT_MADE } from '@/lib/hire/interviews';
import type { InterviewRow } from '@/lib/hire/lists';
import { cn } from '@/lib/utils';
import { FormDialog } from '@/screens/hire/candidate-forms';
import { announceDeletion, claimResult, useNewest } from '@/screens/hire/delete-dialog';
import { FeedbackDialog } from '@/screens/hire/feedback-dialog';
import { InvitationStep, openInterview } from '@/screens/hire/interview-dialog';
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
  /**
   * Asks the server for the row's invitation and calendar file, made from the interview as it is stored now. It
   * shares the one-at-a-time lock with the changes, so a second press does nothing. A refusal is said at the row
   * (or on the notice line when the interview has gone) and the screen is fetched again, so a stale row is replaced.
   */
  const ask = (call: () => Promise<unknown>, onMade: (handover: Handover) => void, onSettled: (made: boolean) => void) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefusal(null);
    start(async () => {
      let made = false;
      try {
        const result = handoverResult(await call());
        if (result.ok) {
          made = true;
          onMade(result.handover);
        } else if (sayOnNotice(refusalWord(result.error, 'interview'))) {
          announceDeletion(result.error);
          focusNoticeSoon();
          router.refresh();
        } else {
          setRefusal({ text: result.error, seq: claimResult() });
          router.refresh();
        }
      } catch {
        setRefusal({ text: INVITATION_NOT_MADE, seq: claimResult() });
        router.refresh();
      } finally {
        inFlight.current = false;
        onSettled(made);
      }
    });
  };
  /** A refusal known without asking the server: said at the row like any other, and the newest thing said on the screen. */
  const refuse = (text: string) => setRefusal({ text, seq: claimResult() });
  return { pending, error: refusal && newest ? refusal.text : null, inFlight, send, ask, refuse, clearError: () => setRefusal(null) };
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
 *
 * "Invitation and calendar file" asks the server at the press: the text and
 * the file are made there from the interview as it is stored at that moment,
 * never from this row, which may be stale (a colleague rescheduled, the page
 * was restored by Back, a second tab). While it loads the row says so and the
 * menu stays shut.
 *
 * A scheduled interview can also be marked completed with its feedback in one step; a completed one takes feedback, or has it edited or cleared (feedback-dialog-state.ts says which).
 */
export function InterviewRowMenu({ row }: { row: InterviewRow }) {
  const change = useInterviewChange();
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<'invitation' | 'cancel' | 'clear_feedback' | null>(null);
  /** The feedback form of this row: closed, or open to add, to edit, or to mark completed with feedback. */
  const [feedback, setFeedback] = useState<{ mode: FeedbackMode; row: InterviewRow } | null>(null);
  /** The row's invitation: not asked for, being fetched, or showing. */
  const [handover, setHandover] = useState<HandoverState>('idle');
  /** What the invitation panel shows, as the server made it. */
  const [invite, setInvite] = useState<Handover | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  /** An item that opens something was chosen: it opens once the menu has closed. */
  const then = useRef<RowMenuItem | null>(null);
  /** True while the cancellation is being saved: Escape and "Keep interview" then do nothing. */
  const busy = useRef(false);
  const triggerId = openerId('row', row.id);
  const groups = rowMenuWithFeedback(row);
  const waiting = change.pending || undefined;

  const choose = (item: RowMenuItem) => {
    if (item === 'reopen') {
      // A completed interview that has feedback cannot be scheduled again: said here, with what to do first, and nothing is sent.
      const blocked = reopenRefusal(row);
      if (blocked) change.refuse(blocked);
      else change.send(() => reopenInterviewAction({ id: row.id }));
      return;
    }
    if (item === 'completed' || item === 'no_show') {
      change.send(() => setInterviewOutcomeAction(outcomeInput(row.id, item)));
      return;
    }
    // Everything else opens something: the edit form, the invitation, a confirm, or the feedback form.
    then.current = item;
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
              // Focus goes back to this button while the server is asked; the panel takes it when the answer comes.
              // One request at a time: nothing is asked while one is loading or showing, or while a change is saved.
              if (!mayAskHandover(handover, change.pending || change.inFlight.current)) return;
              setHandover((state) => handoverAfter(state, 'ask'));
              change.ask(
                () => getInterviewInvitationAction({ id: row.id }),
                (made) => {
                  setInvite(made);
                  setPanel('invitation');
                },
                (made) => setHandover((state) => handoverAfter(state, made ? 'made' : 'refused')),
              );
              return;
            }
            event.preventDefault();
            change.clearError();
            // The row as it is now: the form sends its `updatedAt`, so a later change by someone else is refused, not replaced.
            if (next === 'edit') openInterview({ mode: 'change', row, focusId: triggerId });
            else if (next === 'cancel' || next === 'clear_feedback') setPanel(next);
            // The feedback form takes the row as it is now: an edit sends its feedback's saved time, so a later change by someone else is refused.
            // The row is held as it was when the form opened, however often the screen behind it is fetched again.
            else {
              const mode = modeOf(next);
              setFeedback(mode ? { mode, row } : null);
            }
          }}
        >
          {groups.map((group, index) => (
            <Fragment key={group[0]}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              {group.map((item) => (
                <DropdownMenuItem
                  key={item}
                  // The danger colour and its words: colour is never the only signal.
                  variant={isDestructive(item) ? 'destructive' : undefined}
                  className={ITEM}
                  onSelect={() => choose(item)}
                >
                  {ROW_MENU_WORDS[item]}
                </DropdownMenuItem>
              ))}
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Always in the page, so "Saving…" and "Getting the invitation…" are announced. It takes a line only while there is something to say. */}
      <p aria-live="polite" className={cn(HELP, !rowWaitingWord(change.pending, handover) && 'sr-only')}>
        {rowWaitingWord(change.pending, handover)}
      </p>
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

      {/* "Clear the feedback on the interview with Aina Rahman?" Focus starts on "Keep feedback". A click outside does not close it. */}
      <AlertDialog.Root
        open={panel === 'clear_feedback'}
        onOpenChange={(next) => {
          if (!next && mayClose(busy.current)) setPanel(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={OVERLAY_CLASS} />
          <AlertDialog.Content
            className={CONTENT_CLASS}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              trigger.current?.focus();
            }}
          >
            <AlertDialog.Title className="text-base font-semibold break-words">{clearTitle(row.name)}</AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm break-words text-muted-foreground">{CLEAR_BODY}</AlertDialog.Description>
            {change.error ? <p role="alert" className={cn(ALERT_CLASS, 'mt-3')}>{change.error}</p> : null}
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="outline" size="sm" className={cn(TARGET, WAITING)} aria-disabled={waiting}>
                  {KEEP_FEEDBACK}
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
                      () => clearInterviewFeedbackAction({ id: row.id }),
                      () => setPanel(null),
                      () => {
                        busy.current = false;
                      },
                    );
                  }}
                >
                  {clearLabel(change.pending)}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      {/* Add, edit, or "Mark completed and add feedback": one form, which gives focus back to this row's menu button. */}
      <FeedbackDialog
        target={feedback}
        onClose={() => setFeedback(null)}
        returnFocus={() => trigger.current?.focus()}
      />

      {/* "Invitation and calendar file": the invitation step on its own, showing what the server made, with no move button. */}
      <FormDialog
        open={panel === 'invitation'}
        title={inviteTitle('row')}
        description={inviteLead(row.name)}
        discardTitle=""
        dirty={false}
        pending={false}
        onClose={() => {
          setPanel(null);
          setHandover((state) => handoverAfter(state, 'closed'));
        }}
        returnFocus={() => trigger.current?.focus()}
      >
        {(requestClose) =>
          invite ? <InvitationStep text={invite.text} file={invite.file} moveFor={null} onDone={requestClose} /> : null
        }
      </FormDialog>
    </div>
  );
}
