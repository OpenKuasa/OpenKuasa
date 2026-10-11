'use client';

import { useEffect, useId, useRef, useState, useTransition, type FocusEvent, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { AlertDialog } from 'radix-ui';
import { ArrowLeft, MoreHorizontal, Star } from 'lucide-react';
import {
  closeApplicationAction,
  moveApplicationAction,
  rateApplicationAction,
  reopenApplicationAction,
} from '@/app/(app)/hire/actions';
import { REASON_LABEL, REJECT_REASONS, allowedMoves, type RejectReason } from '@/lib/hire/application-changes';
import { STAGE_LABEL, stageRank } from '@/lib/hire/applications-view';
import type { ApplicationState } from '@/lib/hire/lists';
import type { ApplicationStage } from '@/lib/hire/types';
import { cn } from '@/lib/utils';
import { EditCandidateDialog } from '@/screens/hire/candidate-forms';
import { deleteTargetFor } from '@/lib/hire/delete-dialog-state';
import type { DeletionKind } from '@/lib/hire/deletion';
import { DeleteDialog } from '@/screens/hire/delete-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * One application, as plain values from the server: its id, its candidate's id
 * (for the Edit candidate form, which fetches the rest itself when it opens),
 * the two names the controls say aloud, and where it stands. No storage path,
 * no contact details.
 */
export type ApplicationSubject = { id: string; candidateId: string; name: string; job: string } & ApplicationState;

type CloseOutcome = 'rejected' | 'withdrawn';
type ActionResult = { ok: true } | { ok: false; error: string };
/** Which change is being saved: `move:offer`, `close:rejected`, `reopen`, `rate:4`, `rate:clear`. */
type Busy = string;

/** What the person is told when the call itself fails (the same sentence the capability uses). */
const FAILED = 'That change could not be saved. Please try again.';
/** 44 pixels of hit area on every button. */
const TARGET = 'min-h-11 min-w-11';
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
/** A control that is waiting stays focusable and says so; its presses are ignored in the handlers. */
const WAITING = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:active:translate-y-0';
const ALERT_CLASS = 'rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive';
// The dialog look of the app's other confirm dialogs (see jobs-table.tsx).
const OVERLAY_CLASS = 'fixed inset-0 z-50 bg-black/40';
const CONTENT_CLASS =
  'fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-background p-5 shadow-lg outline-none max-h-[85vh] overflow-y-auto';

const OUTCOME_LABEL: Record<CloseOutcome, string> = { rejected: 'Rejected', withdrawn: 'Withdrawn' };
const CLOSE_VERB: Record<CloseOutcome, string> = { rejected: 'Reject', withdrawn: 'Mark withdrawn' };
const CLOSE_BUSY: Record<CloseOutcome, string> = { rejected: 'Rejecting…', withdrawn: 'Saving…' };
const RATINGS = [1, 2, 3, 4, 5] as const;

const ratingText = (rating: number | null) => (rating === null ? 'Not rated' : `Rated ${rating} out of 5`);
const moveLabel = (from: ApplicationStage, to: ApplicationStage) =>
  `${stageRank(to) < stageRank(from) ? 'Back' : 'Move'} to ${STAGE_LABEL[to]}`;
const closedText = (application: ApplicationSubject) =>
  application.rejectReason ? REASON_LABEL[application.rejectReason] : 'No reason given';
const focusLost = () => !document.activeElement || document.activeElement === document.body;

/**
 * One change at a time for one application. `busy` names the change being
 * saved; `error` is the capability's own sentence, or the generic one when the
 * call did not come back. A second press while one is being saved does nothing.
 *
 * A refusal also asks the server for the screen again: what was refused is
 * often a change someone else already made, and without the fresh row this
 * person would keep pressing a button that can only be refused. The sentence
 * stays, because a refresh keeps the state of a component that stays mounted.
 */
function useApplicationChange(application: ApplicationSubject) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busyKey, setBusyKey] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which outcome the confirm dialog is asking about, or null when it is closed. */
  const [confirming, setConfirming] = useState<CloseOutcome | null>(null);
  /** True from the press until the answer: `pending` only turns true on the next render. */
  const inFlight = useRef(false);
  /** True once a reject or a withdrawal was saved: on the board that card is about to go. */
  const closed = useRef(false);

  /** Shows the sentence and fetches the screen again. Never on success: the action revalidates that itself. */
  function refused(sentence: string) {
    setError(sentence);
    router.refresh();
  }

  function run(key: Busy, send: () => Promise<ActionResult>, onOk?: () => void) {
    // Both: `inFlight` covers the moment before `pending` turns true, `pending` the moment after `inFlight` clears.
    if (pending || inFlight.current) return;
    inFlight.current = true;
    // Cleared first, so the same refusal twice in a row is announced twice.
    setError(null);
    setBusyKey(key);
    start(async () => {
      try {
        const result = await send();
        if (result.ok) onOk?.();
        else refused(result.error);
      } catch {
        refused(FAILED);
      } finally {
        inFlight.current = false;
      }
    });
  }

  const { id } = application;
  return {
    pending,
    busy: pending ? busyKey : null,
    error,
    confirming,
    inFlight,
    closed,
    move: (stage: ApplicationStage) => run(`move:${stage}`, () => moveApplicationAction({ id, stage })),
    rate: (rating: number | null) => {
      // The rating it already has: nothing to save, so nothing is sent. Clearing is the Clear rating button.
      if (rating !== null && rating === application.rating) return;
      run(`rate:${rating ?? 'clear'}`, () => rateApplicationAction({ id, rating }));
    },
    reopen: () => run('reopen', () => reopenApplicationAction({ id })),
    /** The confirm button of the dialog. Success closes it; a refusal leaves it open with the reason chosen. */
    close: (outcome: CloseOutcome, reason: RejectReason | null) =>
      run(`close:${outcome}`, () => closeApplicationAction({ id, outcome, reason }), () => {
        closed.current = true;
        setConfirming(null);
      }),
    askToClose: (outcome: CloseOutcome) => {
      if (pending || inFlight.current) return;
      closed.current = false;
      setError(null);
      setConfirming(outcome);
    },
    /** Cancel and Escape: nothing is sent and nothing changes. Ignored while a change is being saved. */
    cancelClose: () => {
      if (pending || inFlight.current) return;
      setConfirming(null);
      setError(null);
    },
  };
}

type Change = ReturnType<typeof useApplicationChange>;

/** The reason radios and the two buttons. Mounted afresh each time the dialog opens, so it starts at "No reason". */
function CloseForm({ outcome, change }: { outcome: CloseOutcome; change: Change }) {
  const [reason, setReason] = useState<RejectReason | null>(null);
  const name = useId();
  const { pending } = change;
  const options: { value: RejectReason | null; label: string }[] = [
    { value: null, label: 'No reason' },
    ...REJECT_REASONS.map((value) => ({ value, label: REASON_LABEL[value] })),
  ];

  return (
    <>
      <fieldset className="mt-4">
        <legend className="text-sm font-medium">Reason (optional)</legend>
        <div className="mt-1 flex flex-col">
          {options.map((option) => (
            <label
              key={option.value ?? 'none'}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1 text-sm has-[:focus-visible]:bg-muted"
            >
              <input
                type="radio"
                name={name}
                className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                checked={reason === option.value}
                aria-disabled={pending || undefined}
                onChange={() => {
                  if (!pending) setReason(option.value);
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
      {change.error && (
        <p role="alert" className={cn(ALERT_CLASS, 'mt-3')}>
          {change.error}
        </p>
      )}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <AlertDialog.Cancel asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(TARGET, WAITING)}
            aria-disabled={pending || undefined}
          >
            Cancel
          </Button>
        </AlertDialog.Cancel>
        <AlertDialog.Action asChild>
          <Button
            type="button"
            variant={outcome === 'rejected' ? 'destructive' : 'default'}
            size="sm"
            className={cn(TARGET, WAITING)}
            aria-disabled={pending || undefined}
            onClick={(event) => {
              // Stay open while it is saved: a refusal is shown here, and only success closes the dialog.
              event.preventDefault();
              change.close(outcome, reason);
            }}
          >
            {pending ? CLOSE_BUSY[outcome] : CLOSE_VERB[outcome]}
          </Button>
        </AlertDialog.Action>
      </div>
    </>
  );
}

/**
 * "Reject Aina?" / "Mark Aina as withdrawn?". Focus starts on Cancel. Escape
 * and Cancel change nothing; a click outside does not close it.
 */
function CloseDialog({
  application,
  change,
  returnFocus,
}: {
  application: ApplicationSubject;
  change: Change;
  /** Gives focus back to the page when the dialog has closed. */
  returnFocus: () => void;
}) {
  const { confirming } = change;
  return (
    <AlertDialog.Root
      open={confirming !== null}
      onOpenChange={(open) => {
        if (!open) change.cancelClose();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={OVERLAY_CLASS} />
        <AlertDialog.Content
          className={CONTENT_CLASS}
          // There is no Radix trigger, so Radix has nothing to give focus back to: this does it.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus();
          }}
        >
          <AlertDialog.Title className="text-base font-semibold break-words">
            {confirming === 'withdrawn' ? `Mark ${application.name} as withdrawn?` : `Reject ${application.name}?`}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-1 text-sm break-words text-muted-foreground">
            {confirming === 'withdrawn'
              ? `Their application for ${application.job} will be marked as withdrawn. You can reopen it later.`
              : `Their application for ${application.job} will be marked as rejected. You can reopen it later.`}
          </AlertDialog.Description>
          {confirming && <CloseForm outcome={confirming} change={change} />}
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/**
 * After a change the button that was pressed may be gone (a move replaces the
 * move buttons; a rejection replaces them with Reopen). When that leaves focus
 * nowhere, it is put on `home`, so the keyboard stays with this application.
 * Focus that the person has moved elsewhere is never taken.
 */
function useKeepFocus(change: Change, application: ApplicationSubject, home: RefObject<HTMLElement | null>) {
  /** True once this application's controls were used, until focus is seen to be somewhere else on purpose. */
  const acted = useRef(false);
  const { pending, confirming } = change;
  useEffect(() => {
    if (pending) {
      acted.current = true;
      return;
    }
    if (!acted.current || confirming !== null) return;
    if (focusLost()) home.current?.focus();
  }, [pending, confirming, application.stage, application.outcome, application.rating, home]);
  /** For the controls' wrapper: focus that went somewhere else on purpose is not brought back. */
  return (event: FocusEvent<HTMLElement>) => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) acted.current = false;
  };
}

/**
 * The controls for one application, drawn in the Applications list's details
 * panel: its stage and the moves that will be accepted, reject and withdraw
 * behind a confirm, reopen when closed, and a rating. Nothing for a viewer.
 */
export function ApplicationActions({ application, canEdit }: { application: ApplicationSubject; canEdit: boolean }) {
  const change = useApplicationChange(application);
  const group = useRef<HTMLDivElement>(null);
  /** The button that opened the confirm dialog: focus goes back to it when the dialog closes. */
  const opener = useRef<HTMLElement | null>(null);
  /** The Edit candidate form: whether it is open, and what it said when it was saved. */
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState<string | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  /** Which deletion the confirm dialog is asking about, and the button that opened it. */
  const [deleting, setDeleting] = useState<DeletionKind | null>(null);
  const deleteOpener = useRef<HTMLElement | null>(null);
  const focusLeft = useKeepFocus(change, application, group);
  if (!canEdit) return null;

  const { pending, busy } = change;
  const { stage, outcome, rating } = application;
  const waiting = pending || undefined;
  const rateBusy = busy?.startsWith('rate:') ?? false;

  return (
    <div
      ref={group}
      role="group"
      aria-label={`Change ${application.name}’s application for ${application.job}`}
      // Focusable by script only: where focus lands when the pressed button has gone.
      tabIndex={-1}
      onBlur={focusLeft}
      className={cn('flex max-w-prose flex-col gap-3 rounded-md', FOCUS)}
    >
      <div className="flex flex-col gap-2">
        {/*
          Where it stands, in one element for both states and always in the page: a move, a rejection,
          a withdrawal or a reopen changes its text, so a screen reader hears the new state once.
        */}
        <p aria-live="polite" aria-atomic="true" className="text-sm">
          {outcome === 'active' ? (
            <>
              Stage: <span className="font-semibold">{STAGE_LABEL[stage]}</span>
            </>
          ) : (
            <>
              <span className="font-semibold">{OUTCOME_LABEL[outcome]}</span>
              {' · '}
              {closedText(application)}
            </>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {outcome === 'active' ? (
            allowedMoves(stage, outcome).map((to) => {
              const back = stageRank(to) < stageRank(stage);
              return (
                <Button
                  key={to}
                  type="button"
                  variant={back ? 'ghost' : 'outline'}
                  size="sm"
                  className={cn(TARGET, WAITING, back && 'text-muted-foreground')}
                  aria-disabled={waiting}
                  onClick={() => change.move(to)}
                >
                  {back && <ArrowLeft aria-hidden />}
                  {busy === `move:${to}` ? 'Moving…' : moveLabel(stage, to)}
                </Button>
              );
            })
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(TARGET, WAITING)}
              aria-disabled={waiting}
              onClick={() => change.reopen()}
            >
              {busy === 'reopen' ? 'Saving…' : 'Reopen'}
            </Button>
          )}
        </div>
      </div>
      {/* Apart from the moves, under a rule of their own: ending an application is not a stage. */}
      {outcome === 'active' && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(TARGET, WAITING)}
            aria-disabled={waiting}
            onClick={(event) => {
              opener.current = event.currentTarget;
              change.askToClose('withdrawn');
            }}
          >
            Mark withdrawn
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className={cn(TARGET, WAITING)}
            aria-disabled={waiting}
            onClick={(event) => {
              opener.current = event.currentTarget;
              change.askToClose('rejected');
            }}
          >
            Reject
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3">
        {/* The rating in words: the stars are not the only signal. Always in the page, so a change is announced. */}
        <p aria-live="polite" className="min-w-24 text-sm">
          {rateBusy && busy !== 'rate:clear' ? 'Saving…' : ratingText(rating)}
        </p>
        <div role="group" aria-label="Rating" className="flex">
          {RATINGS.map((n) => (
            <button
              key={n}
              type="button"
              aria-label={`Rate ${n} out of 5`}
              aria-pressed={rating === n}
              aria-disabled={waiting}
              onClick={() => change.rate(n)}
              className={cn('grid place-items-center rounded-md hover:bg-muted', TARGET, FOCUS, WAITING, 'aria-disabled:hover:bg-transparent')}
            >
              <Star
                aria-hidden
                className={cn('size-5', rating !== null && n <= rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground')}
              />
            </button>
          ))}
        </div>
        {rating !== null && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(TARGET, WAITING)}
            aria-disabled={waiting}
            onClick={() => change.rate(null)}
          >
            {busy === 'rate:clear' ? 'Saving…' : 'Clear rating'}
          </Button>
        )}
      </div>

      {/* The person, not the application: their name and details, behind a form that fetches them when it opens. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3">
        <Button
          ref={editButton}
          type="button"
          variant="outline"
          size="sm"
          className={cn(TARGET, WAITING)}
          aria-disabled={waiting}
          onClick={() => {
            if (pending) return;
            // Cleared first, so the same sentence twice in a row is announced twice.
            setEdited(null);
            setEditing(true);
          }}
        >
          Edit candidate
        </Button>
        {/* Always in the page, so "Changes saved." is announced when it appears. */}
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {edited}
        </p>
      </div>

      {/* Removing for good: last, under a rule of its own, and there whatever the outcome. */}
      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        {(['application', 'candidate'] as const).map((kind) => (
          <Button
            key={kind}
            type="button"
            variant="outline"
            size="sm"
            className={cn(TARGET, WAITING, 'text-destructive hover:text-destructive')}
            aria-disabled={waiting}
            onClick={(event) => {
              if (pending) return;
              deleteOpener.current = event.currentTarget;
              setDeleting(kind);
            }}
          >
            {kind === 'application' ? 'Delete application' : 'Delete candidate'}
          </Button>
        ))}
      </div>

      {/* While the confirm dialog is open the refusal is shown inside it. */}
      {change.error && change.confirming === null && (
        <p role="alert" className={ALERT_CLASS}>
          {change.error}
        </p>
      )}

      <CloseDialog
        application={application}
        change={change}
        returnFocus={() => (opener.current?.isConnected ? opener.current : group.current)?.focus()}
      />
      <EditCandidateDialog
        candidate={{ id: application.candidateId, name: application.name }}
        open={editing}
        onClose={() => setEditing(false)}
        onSaved={setEdited}
        returnFocus={() => (editButton.current ?? group.current)?.focus()}
      />
      <DeleteDialog
        target={deleting ? deleteTargetFor(deleting, application) : null}
        onClose={() => setDeleting(null)}
        returnFocus={() => (deleteOpener.current?.isConnected ? deleteOpener.current : group.current)?.focus()}
      />
    </div>
  );
}

/**
 * A moved card is drawn again in another column, as a new menu. This carries
 * "the person was on this application's menu button" across, so focus can be
 * put back there. Only ever read just after a change, and only when focus was lost.
 */
const handoff = { id: null as string | null, at: 0 };
const HANDOFF_MS = 10_000;

const busyWord = (busy: Busy | null) =>
  busy === null ? '' : busy.startsWith('move:') ? 'Moving…' : busy === 'close:rejected' ? 'Rejecting…' : 'Saving…';

/**
 * The same choices as a menu, for a card on the Candidates board. The menu
 * button, then (on a line of their own in the card) what is being saved and
 * any refusal. Nothing for a viewer.
 *
 * A card that is rejected or withdrawn leaves the board, and its menu button
 * with it. Focus then goes to the heading of the column it was in
 * (`columnHeadingId`), so the keyboard is not dropped on the page body.
 */
export function ApplicationMenu({
  application,
  canEdit,
  columnHeadingId,
}: {
  application: ApplicationSubject;
  canEdit: boolean;
  /** The id of the heading of the board column this card is drawn in. */
  columnHeadingId?: string;
}) {
  const change = useApplicationChange(application);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  /** Reject or withdraw was chosen: the confirm dialog opens once the menu has closed. */
  const thenAsk = useRef<CloseOutcome | null>(null);
  /** Edit candidate was chosen: its form opens once the menu has closed. */
  const thenEdit = useRef(false);
  const [editing, setEditing] = useState(false);
  /** What the Edit candidate form said when it was saved. */
  const [edited, setEdited] = useState<string | null>(null);
  /** A deletion was chosen: its confirm dialog opens once the menu has closed. */
  const thenDelete = useRef<DeletionKind | null>(null);
  const [deleting, setDeleting] = useState<DeletionKind | null>(null);
  useKeepFocus(change, application, trigger);
  const { id } = application;
  const { pending } = change;

  useEffect(() => {
    // A card that has just arrived in a new column takes focus back, if nothing else has it.
    if (handoff.id === id && Date.now() - handoff.at < HANDOFF_MS && focusLost()) trigger.current?.focus();
    if (handoff.id === id) handoff.id = null;
  }, [id]);
  useEffect(() => {
    // The change has been answered and this card is still here: nothing to carry across.
    if (!pending && handoff.id === id) handoff.id = null;
  }, [pending, id]);

  if (!canEdit) return null;

  const { stage, outcome, rating } = application;
  /** Marks this menu button as where focus belongs, then sends the change once the menu has closed onto it. */
  const choose = (send: () => void) => () => {
    handoff.id = id;
    handoff.at = Date.now();
    send();
  };
  const item = 'min-h-11 px-2';

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          // While a change is being saved the menu stays shut: one change at a time.
          if (next && (pending || change.inFlight.current)) return;
          setOpen(next);
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            ref={trigger}
            type="button"
            aria-label={`Actions for ${application.name}`}
            aria-disabled={pending || undefined}
            className={cn('grid shrink-0 place-items-center rounded-md hover:bg-muted', TARGET, FOCUS, WAITING, 'aria-disabled:hover:bg-transparent')}
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-60"
          onCloseAutoFocus={(event) => {
            if (thenEdit.current) {
              // The form takes focus now, and gives it back to the menu button when it closes.
              thenEdit.current = false;
              event.preventDefault();
              setEdited(null);
              setEditing(true);
              return;
            }
            const remove = thenDelete.current;
            if (remove) {
              // The dialog takes focus now, and gives it back to the menu button if it is cancelled.
              thenDelete.current = null;
              event.preventDefault();
              setDeleting(remove);
              return;
            }
            const ask = thenAsk.current;
            if (!ask) return;
            // The dialog takes focus now, and gives it back to the menu button when it closes.
            thenAsk.current = null;
            event.preventDefault();
            change.askToClose(ask);
          }}
        >
          {outcome === 'active' ? (
            <>
              <DropdownMenuLabel>Stage: {STAGE_LABEL[stage]}</DropdownMenuLabel>
              {allowedMoves(stage, outcome).map((to) => (
                <DropdownMenuItem key={to} className={item} onSelect={choose(() => change.move(to))}>
                  {stageRank(to) < stageRank(stage) && <ArrowLeft aria-hidden />}
                  {moveLabel(stage, to)}
                </DropdownMenuItem>
              ))}
            </>
          ) : (
            <>
              <DropdownMenuLabel>
                {OUTCOME_LABEL[outcome]} · {closedText(application)}
              </DropdownMenuLabel>
              <DropdownMenuItem className={item} onSelect={choose(() => change.reopen())}>
                Reopen
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Rating: {ratingText(rating)}</DropdownMenuLabel>
          {/* Radio items: the current rating is the checked one, in words as well as by its tick. */}
          <DropdownMenuRadioGroup
            value={rating === null ? '' : String(rating)}
            onValueChange={(value) => {
              // Choosing the rating it already has sends nothing, so there is no focus to hand on either.
              if (Number(value) === rating) return;
              choose(() => change.rate(Number(value)))();
            }}
          >
            {RATINGS.map((n) => (
              <DropdownMenuRadioItem key={n} value={String(n)} className={item}>
                Rate {n} out of 5
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {rating !== null && (
            <DropdownMenuItem className={item} onSelect={choose(() => change.rate(null))}>
              Clear rating
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {/* The person, not the application. Nothing is sent by choosing it: the form asks for the details when it opens. */}
          <DropdownMenuItem
            className={item}
            onSelect={() => {
              thenEdit.current = true;
            }}
          >
            Edit candidate
          </DropdownMenuItem>
          {outcome === 'active' && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className={item}
                onSelect={() => {
                  thenAsk.current = 'withdrawn';
                }}
              >
                Mark withdrawn
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                className={item}
                onSelect={() => {
                  thenAsk.current = 'rejected';
                }}
              >
                Reject
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            className={item}
            onSelect={() => {
              thenDelete.current = 'application';
            }}
          >
            Delete application
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            className={item}
            onSelect={() => {
              thenDelete.current = 'candidate';
            }}
          >
            Delete candidate
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Always in the page, so its text is announced when it changes. It takes a line of the card only while there is something to say. */}
      <p aria-live="polite" className={cn('basis-full text-xs text-muted-foreground', !change.busy && !edited && 'sr-only')}>
        {busyWord(change.busy) || edited}
      </p>
      {change.error && change.confirming === null && (
        <p role="alert" className={cn(ALERT_CLASS, 'basis-full')}>
          {change.error}
        </p>
      )}

      <CloseDialog
        application={application}
        change={change}
        returnFocus={() => {
          // Saved: the card is going (or has gone), so its button is no place to leave focus.
          const heading = change.closed.current && columnHeadingId ? document.getElementById(columnHeadingId) : null;
          (heading ?? trigger.current)?.focus();
        }}
      />
      <EditCandidateDialog
        candidate={{ id: application.candidateId, name: application.name }}
        open={editing}
        onClose={() => setEditing(false)}
        onSaved={setEdited}
        returnFocus={() => trigger.current?.focus()}
      />
      <DeleteDialog
        target={deleting ? deleteTargetFor(deleting, application) : null}
        onClose={() => setDeleting(null)}
        returnFocus={() => trigger.current?.focus()}
        focusAfterId={columnHeadingId}
      />
    </>
  );
}
