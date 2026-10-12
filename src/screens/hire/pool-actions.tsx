'use client';

import { useEffect, useId, useRef, useState, useSyncExternalStore, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AlertDialog, Dialog } from 'radix-ui';
import { MoreHorizontal, Plus, Search, X } from 'lucide-react';
import { listPoolPickerAction, moveToPipelineAction, setPoolStatusAction } from '@/app/(app)/hire/actions';
import { DELETION_NOTICE_ID, mayClose } from '@/lib/hire/delete-dialog-state';
import type { PickerPerson } from '@/lib/hire/lists';
import {
  PICKER_CAPPED, POOL_LABEL, POOL_MEANING, POOL_NOT_SENT, POOL_SEARCH_MAX, POOL_STATUSES, isInPool, type InPool,
} from '@/lib/hire/pool';
import {
  CHOOSE_A_JOB, NO_JOBS, PICKER_LOADING, REMOVE_BODY, addInput, addLabel, addName, addToPoolInput, addedLabel, boxSent,
  changeResult, followAddress, fromOutside, searchBox, jobOption, moveBody, moveInput, moveLabel, moveTitle, nextAddFocus, personLine, pickerFrom, pickerView, removeInput,
  pickerOpenAfter, removeLabel, removeTitle, searchHref, shortlistedNote, statusChangeInput, type PickerState, type PoolJob,
} from '@/lib/hire/pool-dialog-state';
import { cn } from '@/lib/utils';
import { DeleteDialog, announceDeletion, claimResult, useNewest } from '@/screens/hire/delete-dialog';
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

// The same sizes and looks as the other hiring controls (see application-actions.tsx and delete-dialog.tsx).
const TARGET = 'min-h-11 min-w-11';
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
const WAITING = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:active:translate-y-0';
const ALERT_CLASS = 'rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive';
const OVERLAY_CLASS = 'fixed inset-0 z-50 bg-black/40';
const CONTENT_CLASS =
  'fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-background p-5 shadow-lg outline-none max-h-[85vh] overflow-y-auto';
// The picker is a column: its list scrolls inside it, and the search field and Done stay in view.
const PICKER_CLASS =
  'fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-background p-5 shadow-lg outline-none';
const FIELD_CLASS = cn('h-11 w-full rounded-md border bg-background px-3 text-sm', FOCUS);
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
 * One pool change at a time. `error` is the capability's own sentence, or the
 * "not sent" one when the call did not come back. A second press while one is
 * being saved does nothing. A refusal also asks the server for the screen
 * again: what was refused is usually a change someone else already made.
 */
function usePoolChange() {
  const router = useRouter();
  const [pending, start] = useTransition();
  /** A refusal is a result too, with its number among the results said on this screen. */
  const [refusal, setRefusal] = useState<{ text: string; seq: number } | null>(null);
  // Shown only while it is the newest thing said on the screen: a later result elsewhere must not sit beside a stale refusal.
  const newest = useNewest(refusal?.seq ?? null);
  const refuse = (text: string) => setRefusal({ text, seq: claimResult() });
  /** True from the press until the answer: `pending` only turns true on the next render. */
  const inFlight = useRef(false);
  const send = (call: () => Promise<unknown>, onSaved: (message: string) => void, onSettled?: () => void) => {
    if (inFlight.current) return;
    inFlight.current = true;
    // Cleared first, so the same refusal twice in a row is announced twice.
    setRefusal(null);
    start(async () => {
      try {
        const result = changeResult(await call());
        if (result.ok) {
          onSaved(result.message);
        } else {
          refuse(result.error);
          router.refresh();
        }
      } catch {
        refuse(POOL_NOT_SENT);
      } finally {
        inFlight.current = false;
        onSettled?.();
      }
    });
  };
  return { pending, error: refusal && newest ? refusal.text : null, inFlight, send, clearError: () => setRefusal(null) };
}

/**
 * "Add to talent pool", for a board card's menu and the Applications panel:
 * adds this person as Available, and only if they are not in the pool already.
 * `onSaid` is given the sentence (and null just before a new attempt, so the
 * same sentence twice is announced twice).
 */
export function useAddToPool(candidateId: string, onSaid: (message: string | null) => void) {
  const change = usePoolChange();
  const add = () => {
    if (change.pending || change.inFlight.current) return;
    onSaid(null);
    change.send(() => setPoolStatusAction(addToPoolInput(candidateId)), onSaid);
  };
  return { add, adding: change.pending, error: change.error };
}

// ─── the search box and the line under the table ─────────────────────────────
// The box is above the table and the line that answers it is below: they share "the server is answering" here.

let searching = false;
const searchListeners = new Set<() => void>();
const subscribeSearching = (listener: () => void) => {
  searchListeners.add(listener);
  return () => {
    searchListeners.delete(listener);
  };
};
function setSearching(next: boolean) {
  if (searching === next) return;
  searching = next;
  for (const listener of searchListeners) listener();
}

/**
 * The pool table's search. It puts `?q=` in the page's address and the server
 * draws the page again, over the whole pool. A plain GET form, so Enter works
 * with scripting off; with it on, it also searches 300 ms after the last
 * keystroke, replaces the address (no extra step for Back) and does not scroll.
 */
export function PoolSearch({ search }: { search: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const fieldId = useId();
  /** The text in the box, and the searches the box itself has put in the address. */
  const [box, setBox] = useState(() => searchBox(search));
  /** The search the page was last drawn with, and how many times the address was changed from outside the box. */
  const [seen, setSeen] = useState(search);
  const [resets, setResets] = useState(0);
  const [pending, start] = useTransition();
  const field = useRef<HTMLInputElement>(null);
  const timer = useRef<number | null>(null);
  const value = box.text;

  // The address has changed. If the box asked for it, the text stays exactly as typed: the field is never drawn
  // afresh, so focus and the caret stay where they are. If it came from outside (a nav link, Back, Forward), the text
  // follows it. Decided in followAddress; set while drawing, so no stale text is ever painted.
  if (seen !== search) {
    setSeen(search);
    if (fromOutside(box.sent, search)) setResets((n) => n + 1);
    setBox(followAddress(box, search));
  }

  useEffect(() => {
    setSearching(pending);
  }, [pending]);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setSearching(false);
  }, []);
  useEffect(() => {
    // The address was changed from outside: a search still waiting on its 300 ms was for text the box no longer shows.
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, [resets]);

  const setValue = (text: string) => setBox((now) => ({ text, sent: now.sent }));
  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const go = (text: string) => {
    stop();
    // Noted before it is sent, so the page drawn with this search is known to be the box's own doing.
    setBox((now) => boxSent(now, text));
    start(() => {
      router.replace(searchHref(pathname, text), { scroll: false });
    });
  };

  return (
    <form
      role="search"
      action={pathname}
      method="get"
      className="relative w-full sm:max-w-xs"
      onSubmit={(event) => {
        event.preventDefault();
        go(value);
      }}
    >
      <label htmlFor={fieldId} className="sr-only">Search the talent pool</label>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        ref={field}
        id={fieldId}
        type="search"
        name="q"
        value={value}
        maxLength={POOL_SEARCH_MAX}
        autoComplete="off"
        placeholder="Search by name, skill or location…"
        onChange={(event) => {
          const next = event.target.value;
          setValue(next);
          stop();
          timer.current = window.setTimeout(() => go(next), 300);
        }}
        // The browser's own clear cross is hidden: the link beside it is the one with a name and a 44-pixel target.
        className={cn('h-11 w-full rounded-md border bg-background pl-8 text-sm [&::-webkit-search-cancel-button]:hidden', value ? 'pr-11' : 'pr-3', FOCUS)}
      />
      {value ? (
        // A link to the page with no query, so it works before scripting has run and with it off. With scripting on
        // the press is taken over: the box empties at once, the address is replaced and focus stays in the box.
        <a
          href={pathname}
          aria-label="Clear search"
          className={cn('absolute right-0 top-0 grid place-items-center rounded-md text-muted-foreground hover:text-foreground', TARGET, FOCUS)}
          onClick={(event) => {
            // A press that asks for a new tab or window is the browser's to handle.
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            setValue('');
            go('');
            field.current?.focus();
          }}
        >
          <X className="size-4" aria-hidden />
        </a>
      ) : null}
    </form>
  );
}

/**
 * The line under the pool table: how many are shown or match, or that nobody
 * matches. One polite live region, always in the page, so the count is read out
 * when it arrives; while the server is answering it reads "Searching…".
 */
export function PoolFooter({ line, className }: { line: string; className?: string }) {
  const busy = useSyncExternalStore(subscribeSearching, () => searching, () => false);
  return (
    <p aria-live="polite" data-pool-footer="" className={cn('text-sm text-muted-foreground', className)}>
      {busy ? 'Searching…' : line}
    </p>
  );
}

// ─── Add to Pool: the picker ─────────────────────────────────────────────────

/**
 * The picker's body. Mounted afresh each time the picker opens, so it always
 * starts by asking who can be added. One add at a time; the dialog stays open,
 * so several people can be added in a row.
 */
function PickerBody({
  onBusy,
}: {
  /** Told true at the press and false at the answer, so the dialog lets Escape, Done and a click outside do nothing meanwhile. */
  onBusy: (busy: boolean) => void;
}) {
  const [state, setState] = useState<PickerState>(PICKER_LOADING);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<InPool>('available');
  const [query, setQuery] = useState('');
  const [added, setAdded] = useState<Record<string, InPool>>({});
  const [refused, setRefused] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState<string | null>(null);
  /** What the last add did, said inside the dialog: the screen's notice line is behind it and is not read out meanwhile. */
  const [lastSaid, setLastSaid] = useState('');
  const [, start] = useTransition();
  const inFlight = useRef(false);
  const searchField = useRef<HTMLInputElement>(null);
  const statusId = useId();
  const meaningId = useId();
  const searchId = useId();
  const rowId = useId();

  useEffect(() => {
    // Focus starts in the search field (the dialog itself is told not to pick the first control).
    searchField.current?.focus();
  }, []);
  useEffect(() => {
    let live = true;
    listPoolPickerAction().then(
      (result) => {
        if (live) setState(pickerFrom(result));
      },
      () => {
        if (live) setState(pickerFrom(null));
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  const without = (map: Record<string, string>, id: string) => Object.fromEntries(Object.entries(map).filter(([key]) => key !== id));

  function add(person: PickerPerson, rows: PickerPerson[]) {
    if (inFlight.current) return;
    inFlight.current = true;
    onBusy(true);
    setAdding(person.id);
    setRefused((map) => without(map, person.id));
    // Cleared first, so the same sentence twice in a row is announced twice.
    setLastSaid('');
    const as = status;
    start(async () => {
      try {
        const result = changeResult(await setPoolStatusAction(addInput(person.id, as)));
        if (result.ok) {
          const now = { ...added, [person.id]: as };
          setAdded(now);
          announceDeletion(result.message);
          setLastSaid(result.message);
          const next = nextAddFocus(rows, now, person.id);
          window.setTimeout(() => (next ? document.getElementById(`${rowId}-${next}`) : searchField.current)?.focus(), 0);
        } else {
          setRefused((map) => ({ ...map, [person.id]: result.error }));
        }
      } catch {
        setRefused((map) => ({ ...map, [person.id]: POOL_NOT_SENT }));
      } finally {
        inFlight.current = false;
        onBusy(false);
        setAdding(null);
      }
    });
  }

  const view = state.state === 'ready' ? pickerView(state.people, query) : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={statusId} className="text-sm font-medium">Add as</label>
        <select
          id={statusId}
          value={status}
          aria-describedby={meaningId}
          className={FIELD_CLASS}
          onChange={(event) => {
            if (isInPool(event.target.value)) setStatus(event.target.value);
          }}
        >
          {POOL_STATUSES.map((option) => (
            <option key={option} value={option}>{POOL_LABEL[option]}</option>
          ))}
        </select>
        <p id={meaningId} className={HELP}>{POOL_MEANING[status]}</p>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={searchId} className="text-sm font-medium">Search people</label>
        <input
          ref={searchField}
          id={searchId}
          type="search"
          value={query}
          autoComplete="off"
          placeholder="Name, headline or skill"
          className={FIELD_CLASS}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {state.state === 'ready' && state.capped ? <p className={HELP}>{PICKER_CAPPED}</p> : null}
      <div className="min-h-24 flex-1 overflow-y-auto rounded-md border">
        {state.state === 'loading' ? (
          <p role="status" className="p-3 text-sm text-muted-foreground">Loading people…</p>
        ) : null}
        {state.state === 'failed' ? (
          <div className="flex flex-col items-start gap-2 p-3">
            <p role="alert" className={ALERT_CLASS}>{state.error}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={TARGET}
              onClick={() => {
                setState(PICKER_LOADING);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </div>
        ) : null}
        {view?.empty ? <p className="p-3 text-sm text-muted-foreground">{view.empty}</p> : null}
        {view && view.rows.length > 0 ? (
          <ul className="divide-y">
            {view.rows.map((person) => {
              const about = personLine(person);
              return (
                <li key={person.id} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{person.name}</p>
                    {about ? <p className={cn('truncate', HELP)}>{about}</p> : null}
                    {person.skills.length > 0 ? <p className={cn('truncate', HELP)}>{person.skills.slice(0, 3).join(', ')}</p> : null}
                    {refused[person.id] ? <p role="alert" className="mt-1 text-xs text-destructive">{refused[person.id]}</p> : null}
                  </div>
                  {added[person.id] ? (
                    <p className="shrink-0 text-xs font-medium text-muted-foreground">{addedLabel(added[person.id])}</p>
                  ) : (
                    <Button
                      id={`${rowId}-${person.id}`}
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={addName(person.name)}
                      aria-disabled={adding !== null || undefined}
                      className={cn('shrink-0', TARGET, WAITING)}
                      onClick={() => add(person, view.rows)}
                    >
                      {addLabel(adding === person.id)}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      {/* For a screen reader only: the row already shows "Added as …", and the notice line shows the sentence once the dialog closes. */}
      <p aria-live="polite" className="sr-only">{lastSaid}</p>
      {/* Always in the page, so "Showing 50 of 312…" is read out when it changes. */}
      <p aria-live="polite" className={cn(HELP, !view?.line && 'sr-only')}>{view?.line ?? ''}</p>
      <div className="flex justify-end">
        <Dialog.Close asChild>
          {/* While an add is being saved it stays focusable and says it is waiting; the dialog ignores the press. */}
          <Button type="button" size="sm" className={cn(TARGET, WAITING)} aria-disabled={adding !== null || undefined}>Done</Button>
        </Dialog.Close>
      </div>
    </div>
  );
}

/**
 * The "Add to Pool" button in the Talent Pool's header, and its picker: the
 * people on file who are not in the pool yet. Drawn only for someone who may
 * edit; the list is asked for when the picker opens, never with the page.
 */
export function AddToPool() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  /** True while an add is being saved: Escape, Done and a click outside then do nothing, so a refusal is not lost. */
  const busy = useRef(false);
  return (
    <>
      <Button ref={button} type="button" size="sm" className={TARGET} onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden />
        Add to Pool
      </Button>
      <Dialog.Root open={open} onOpenChange={(next) => setOpen(pickerOpenAfter(next, busy.current))}>
        <Dialog.Portal>
          <Dialog.Overlay className={OVERLAY_CLASS} />
          <Dialog.Content
            className={PICKER_CLASS}
            // The body puts focus in its search field.
            onOpenAutoFocus={(event) => event.preventDefault()}
            // There is no Radix trigger, so Radix has nothing to give focus back to: this does it.
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              button.current?.focus();
            }}
          >
            <Dialog.Title className="text-base font-semibold">Add to talent pool</Dialog.Title>
            <Dialog.Description className="mb-3 text-sm text-muted-foreground">
              People on file who are not in the pool yet.
            </Dialog.Description>
            {open ? (
              <PickerBody
                onBusy={(value) => {
                  busy.current = value;
                }}
              />
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

// ─── a pool row: Move to pipeline, and the menu ──────────────────────────────

type RowCandidate = { id: string; name: string; poolStatus: InPool; label: string };

/** The Move to pipeline dialog's body. Mounted afresh each time it opens: no job is chosen and nothing is said. */
function MoveBody({
  candidate,
  jobs,
  onBusy,
  onMoved,
}: {
  candidate: RowCandidate;
  jobs: PoolJob[];
  onBusy: (busy: boolean) => void;
  onMoved: (message: string) => void;
}) {
  const change = usePoolChange();
  const [jobId, setJobId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const selectId = useId();
  const problemId = useId();

  function confirm() {
    if (change.pending || change.inFlight.current) return;
    const input = moveInput(candidate.id, jobId, jobs);
    if (!input) {
      setProblem(CHOOSE_A_JOB);
      document.getElementById(selectId)?.focus();
      return;
    }
    setProblem(null);
    onBusy(true);
    change.send(() => moveToPipelineAction(input), onMoved, () => onBusy(false));
  }

  if (jobs.length === 0) {
    return (
      <>
        <Dialog.Description className="mt-1 text-sm text-muted-foreground">{NO_JOBS}</Dialog.Description>
        <div className="mt-5 flex justify-end">
          <Dialog.Close asChild>
            <Button type="button" variant="outline" size="sm" className={TARGET}>Close</Button>
          </Dialog.Close>
        </div>
      </>
    );
  }
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        confirm();
      }}
    >
      <Dialog.Description className="mt-1 text-sm break-words text-muted-foreground">{moveBody(candidate.name)}</Dialog.Description>
      <div className="mt-4 flex flex-col gap-1">
        <label htmlFor={selectId} className="text-sm font-medium">
          Job <span aria-hidden className="text-destructive">*</span>
        </label>
        <select
          id={selectId}
          required
          value={jobId}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? problemId : undefined}
          className={FIELD_CLASS}
          onChange={(event) => {
            setJobId(event.target.value);
            setProblem(null);
          }}
        >
          <option value="">Choose a job</option>
          {jobs.map((job) => (
            <option key={job.id} value={job.id}>{jobOption(job)}</option>
          ))}
        </select>
        {problem ? <p id={problemId} className="text-xs text-destructive">{problem}</p> : null}
      </div>
      {change.error ? <p role="alert" className={cn(ALERT_CLASS, 'mt-3')}>{change.error}</p> : null}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <Dialog.Close asChild>
          <Button type="button" variant="outline" size="sm" className={cn(TARGET, WAITING)} aria-disabled={change.pending || undefined}>
            Cancel
          </Button>
        </Dialog.Close>
        <Button type="submit" size="sm" className={cn(TARGET, WAITING)} aria-disabled={change.pending || undefined}>
          {moveLabel(change.pending)}
        </Button>
      </div>
    </form>
  );
}

/** The "Remove from pool" confirm's body. Mounted afresh each time it opens. */
function RemoveBody({
  candidate,
  onBusy,
  onRemoved,
}: {
  candidate: RowCandidate;
  onBusy: (busy: boolean) => void;
  onRemoved: (message: string) => void;
}) {
  const change = usePoolChange();
  return (
    <>
      <AlertDialog.Description className="mt-1 text-sm break-words text-muted-foreground">{REMOVE_BODY}</AlertDialog.Description>
      {change.error ? <p role="alert" className={cn(ALERT_CLASS, 'mt-3')}>{change.error}</p> : null}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <AlertDialog.Cancel asChild>
          <Button type="button" variant="outline" size="sm" className={cn(TARGET, WAITING)} aria-disabled={change.pending || undefined}>
            Cancel
          </Button>
        </AlertDialog.Cancel>
        <AlertDialog.Action asChild>
          {/* Not the danger colour: nothing is deleted, and it can be undone from Add to Pool. */}
          <Button
            type="button"
            size="sm"
            className={cn(TARGET, WAITING)}
            aria-disabled={change.pending || undefined}
            onClick={(event) => {
              // Stay open while it is saved: a refusal is shown here, and only success closes the dialog.
              event.preventDefault();
              if (change.pending || change.inFlight.current) return;
              onBusy(true);
              change.send(() => setPoolStatusAction(removeInput(candidate.id)), onRemoved, () => onBusy(false));
            }}
          >
            {removeLabel(change.pending)}
          </Button>
        </AlertDialog.Action>
      </div>
    </>
  );
}

/**
 * The two controls of a Talent Pool row: "Move to pipeline", and a menu with
 * the stored pool status (three radio items, each with what it means),
 * "Remove from pool", and last, under a rule of its own, 3c's "Delete
 * candidate". Only drawn for someone who may edit; every action checks again.
 *
 * What a change did is written to the screen's notice line (the row may have
 * moved or gone). After a removal the row has gone, so focus goes to that line.
 */
export function PoolRowControls({ candidate, jobs }: { candidate: RowCandidate; jobs: PoolJob[] }) {
  const change = usePoolChange();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'move' | 'remove' | 'delete' | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const moveButton = useRef<HTMLButtonElement>(null);
  /** Remove or Delete was chosen: its dialog opens once the menu has closed. */
  const then = useRef<'remove' | 'delete' | null>(null);
  /** True while a dialog's own change is being saved: Escape and Cancel then do nothing. */
  const busy = useRef(false);
  const removed = useRef(false);
  const { id, name, poolStatus } = candidate;
  const note = shortlistedNote(candidate.label);
  const waiting = change.pending || undefined;
  const closeDialog = () => {
    if (mayClose(busy.current)) setDialog(null);
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center justify-end gap-2">
        <Button
          ref={moveButton}
          type="button"
          variant="outline"
          size="sm"
          className={cn(TARGET, WAITING)}
          aria-disabled={waiting}
          onClick={() => {
            if (change.pending || change.inFlight.current) return;
            change.clearError();
            setDialog('move');
          }}
        >
          Move to pipeline
        </Button>
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
              type="button"
              aria-label={`Actions for ${name}`}
              aria-disabled={waiting}
              className={cn('grid shrink-0 place-items-center rounded-md hover:bg-muted', TARGET, FOCUS, WAITING, 'aria-disabled:hover:bg-transparent')}
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-72"
            onCloseAutoFocus={(event) => {
              const next = then.current;
              if (!next) return;
              // The dialog takes focus now, and gives it back to the menu button if it is cancelled.
              then.current = null;
              event.preventDefault();
              change.clearError();
              setDialog(next);
            }}
          >
            <DropdownMenuLabel>Pool status</DropdownMenuLabel>
            {/* Radio items: the stored status is the checked one, in words as well as by its mark. */}
            <DropdownMenuRadioGroup
              value={poolStatus}
              onValueChange={(chosen) => {
                // Choosing the status they already have sends nothing.
                const input = statusChangeInput(id, poolStatus, chosen);
                if (input) change.send(() => setPoolStatusAction(input), announceDeletion);
              }}
            >
              {POOL_STATUSES.map((status) => (
                <DropdownMenuRadioItem key={status} value={status} className={cn(ITEM, 'items-start py-2')}>
                  <span className="flex flex-col text-left">
                    <span>{POOL_LABEL[status]}</span>
                    <span className={HELP}>{POOL_MEANING[status]}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {note ? <p className={cn('px-2 py-1.5', HELP)}>{note}</p> : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className={ITEM}
              onSelect={() => {
                then.current = 'remove';
              }}
            >
              Remove from pool
            </DropdownMenuItem>
            {/* Removing for good: last, under a rule of its own (slice 3c). */}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              className={ITEM}
              onSelect={() => {
                then.current = 'delete';
              }}
            >
              Delete candidate
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/* Always in the page, so "Saving…" is announced. It takes a line only while there is something to say. */}
      <p aria-live="polite" className={cn(HELP, !change.pending && 'sr-only')}>{change.pending ? 'Saving…' : ''}</p>
      {change.error && dialog === null ? (
        <p role="alert" className={cn(ALERT_CLASS, 'max-w-xs text-left whitespace-normal')}>{change.error}</p>
      ) : null}

      <Dialog.Root open={dialog === 'move'} onOpenChange={(next) => { if (!next) closeDialog(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className={OVERLAY_CLASS} />
          <Dialog.Content
            className={CONTENT_CLASS}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              moveButton.current?.focus();
            }}
          >
            <Dialog.Title className="text-base font-semibold break-words">{moveTitle(name)}</Dialog.Title>
            {dialog === 'move' ? (
              <MoveBody
                candidate={candidate}
                jobs={jobs}
                onBusy={(value) => {
                  busy.current = value;
                }}
                onMoved={(message) => {
                  busy.current = false;
                  announceDeletion(message);
                  setDialog(null);
                }}
              />
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <AlertDialog.Root open={dialog === 'remove'} onOpenChange={(next) => { if (!next) closeDialog(); }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={OVERLAY_CLASS} />
          <AlertDialog.Content
            className={CONTENT_CLASS}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (removed.current) {
                // The row has gone (or is going): the line that says so is where focus belongs.
                removed.current = false;
                document.getElementById(DELETION_NOTICE_ID)?.focus();
                focusNoticeSoon();
                return;
              }
              trigger.current?.focus();
            }}
          >
            <AlertDialog.Title className="text-base font-semibold break-words">{removeTitle(name)}</AlertDialog.Title>
            {dialog === 'remove' ? (
              <RemoveBody
                candidate={candidate}
                onBusy={(value) => {
                  busy.current = value;
                }}
                onRemoved={(message) => {
                  busy.current = false;
                  removed.current = true;
                  announceDeletion(message);
                  // The row may be taken out of the page before the dialog has finished closing.
                  focusNoticeSoon();
                  setDialog(null);
                }}
              />
            ) : null}
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <DeleteDialog
        target={dialog === 'delete' ? { kind: 'candidate', id, name, job: null } : null}
        onClose={() => setDialog(null)}
        returnFocus={() => trigger.current?.focus()}
      />
    </div>
  );
}
