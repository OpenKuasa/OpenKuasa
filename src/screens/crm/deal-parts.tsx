'use client';

import {
  useRef,
  useState,
  useTransition,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';
import Link from 'next/link';
import {
  ArrowRightLeft,
  Check,
  CircleX,
  FileText,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MAX_TAG_LENGTH } from '@/lib/crm/contacts';
import { formatDay, formatRM } from '@/lib/crm/deal-stats';
import {
  MAX_DEAL_TITLE_LENGTH,
  MAX_LOST_REASON_LENGTH,
  lostReasonProblem,
  type CrmDeal,
  type CrmDealContactChoice,
} from '@/lib/crm/deals';
import type { CrmDealActions, CrmFormAction } from '@/lib/crm/form-state';
import type { DealInvoiceChoice } from '@/lib/crm/invoice-links';
import type { CrmPipelineStage } from '@/lib/crm/pipelines';
import { cn } from '@/lib/utils';
import { SELECT_CLASS, useCrmForm } from './crm-form';

/** What a dragged card carries. Not text, so it cannot be dropped into a field. */
export const DEAL_DRAG_TYPE = 'application/x-deal-card';

const initials = (name: string) =>
  name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2);

/** The card above the board: adds a deal, or edits the one picked from its menu. */
export function DealFormCard({
  action,
  editing,
  stages,
  contacts,
  invoices,
  newDealContactId,
  onSaved,
  onClose,
  firstFieldRef,
}: {
  action: CrmFormAction;
  /** The deal being edited; null to add a new one. */
  editing: CrmDeal | null;
  /** The contact a new deal starts with, as when it is made from a contact's row. */
  newDealContactId?: string | null;
  /** Bendahara's invoices, to link to the deal being edited. Absent: the picker is not shown. */
  invoices?: DealInvoiceChoice[];
  /** The stages of the pipeline the deal is in, or is being added to. */
  stages: CrmPipelineStage[];
  contacts: CrmDealContactChoice[];
  /** Called after a save has gone through. */
  onSaved: () => void;
  /** Cancel when editing, Close when adding. */
  onClose: () => void;
  /** Whatever should take focus when the card opens. */
  firstFieldRef: RefObject<HTMLElement | null>;
}) {
  const { formAction, pending, error, values } = useCrmForm(action, onSaved);
  const v = values ?? editing?.form ?? (newDealContactId ? { contactId: newDealContactId } : {});

  // The contact of a deal being edited is always offered, even when it is
  // beyond the contacts that were loaded.
  const choices =
    editing?.form?.contactId && !contacts.some((c) => c.id === editing.form?.contactId)
      ? [{ id: editing.form.contactId, label: editing.form.contactLabel }, ...contacts]
      : contacts;

  // An invoice belongs to one deal, so those linked elsewhere are not offered.
  const linkable =
    editing && invoices
      ? invoices.filter((invoice) => invoice.dealId === null || invoice.dealId === editing.id)
      : null;

  const title = editing ? 'Edit deal' : 'New deal';
  const subtitle = editing ? `Changing ${editing.title}` : 'Add a deal to this pipeline';
  // The card's icon chip only draws icons from the animated set.
  const icon = editing ? FileText : Plus;

  if (choices.length === 0) {
    return (
      <BentoCard title={title} subtitle={subtitle} icon={icon} className="col-span-2 md:col-span-12">
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm">
            A deal belongs to a contact, and this workspace has none yet.{' '}
            <Link
              ref={firstFieldRef as RefObject<HTMLAnchorElement | null>}
              href="/crm/contacts"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Add a contact first
            </Link>
            .
          </p>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </BentoCard>
    );
  }

  return (
    <BentoCard title={title} subtitle={subtitle} icon={icon} className="col-span-2 md:col-span-12">
      <form action={formAction} className="grid gap-3 md:grid-cols-12">
        {editing ? <input type="hidden" name="dealId" value={editing.id} /> : null}
        <div className="space-y-1.5 md:col-span-4">
          <Label htmlFor="deal-title">Title</Label>
          <Input
            ref={firstFieldRef as RefObject<HTMLInputElement | null>}
            id="deal-title"
            name="title"
            placeholder="POS rollout for 4 outlets"
            defaultValue={v.title}
            maxLength={MAX_DEAL_TITLE_LENGTH}
            required
          />
        </div>
        <div className="space-y-1.5 md:col-span-5">
          <Label htmlFor="deal-contact">Contact</Label>
          <select
            // React resets a form after its action and does not put a select
            // back on a new default, so each value gets a select of its own.
            key={v.contactId ?? ''}
            id="deal-contact"
            name="contactId"
            defaultValue={v.contactId ?? ''}
            required
            className={SELECT_CLASS}
          >
            <option value="">Choose a contact</option>
            {choices.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor="deal-stage">Stage</Label>
          <select
            key={v.stageId ?? ''}
            id="deal-stage"
            name="stageId"
            defaultValue={v.stageId || stages[0]?.id}
            className={SELECT_CLASS}
          >
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor="deal-value">Value (RM)</Label>
          <Input
            id="deal-value"
            name="value"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="18000"
            defaultValue={v.value || '0'}
          />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor="deal-tag">Tag</Label>
          <Input
            id="deal-tag"
            name="tag"
            placeholder="Inbound"
            defaultValue={v.tag}
            maxLength={MAX_TAG_LENGTH}
          />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor="deal-close-date">Expected close date</Label>
          <Input
            id="deal-close-date"
            name="expectedCloseDate"
            type="date"
            defaultValue={v.expectedCloseDate}
          />
        </div>
        {editing && linkable ? (
          <fieldset className="space-y-1.5 md:col-span-12">
            <legend className="text-sm font-medium">Invoices</legend>
            {/* Tells the save that the picker was shown, so unticking everything clears the links. */}
            <input type="hidden" name="invoiceLinks" value="1" />
            {linkable.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No invoices to link. Invoices are created in Bendahara.
              </p>
            ) : (
              <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
                {linkable.map((invoice) => (
                  <li key={invoice.id}>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="invoiceIds"
                        value={invoice.id}
                        defaultChecked={invoice.dealId === editing.id}
                        className="size-4 accent-primary"
                      />
                      <span className="min-w-0 truncate">{invoice.label}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        ) : null}
        <div className="flex flex-wrap items-end gap-3 md:col-span-12">
          <Button type="submit" className="w-full md:w-auto" disabled={pending}>
            {editing ? <Check className="size-4" /> : <Plus className="size-4" />}
            {pending ? 'Saving…' : editing ? 'Save changes' : 'Save deal'}
          </Button>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            {editing ? 'Cancel' : 'Close'}
          </Button>
          {error ? (
            <p role="alert" className="pb-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </form>
    </BentoCard>
  );
}

/** One deal on the board. `menu` is its "⋯" button, for people who can edit. */
export function DealCard({
  deal,
  menu,
  children,
  className,
  dragProps,
}: {
  deal: CrmDeal;
  menu?: ReactNode;
  /** Shown under the card's details: progress, or what went wrong. */
  children?: ReactNode;
  className?: string;
  /** Makes the card something that can be dragged, for people who can edit. */
  dragProps?: HTMLAttributes<HTMLDivElement>;
}) {
  return (
    <div
      {...dragProps}
      className={cn(
        'space-y-2 rounded-xl border bg-card p-3 shadow-sm transition-colors hover:border-primary/40',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold leading-tight">
          {deal.company}
        </p>
        {deal.status === 'lost' ? (
          <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
            Lost
          </span>
        ) : null}
        {deal.tag ? (
          <span className="max-w-24 shrink-0 truncate rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
            {deal.tag}
          </span>
        ) : null}
        {menu ? <div className="-mr-1 -mt-1 shrink-0">{menu}</div> : null}
      </div>
      <p className="truncate text-xs text-muted-foreground">{deal.title}</p>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold tabular-nums">{formatRM(deal.value)}</span>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
            {initials(deal.owner)}
          </span>
          <span className="truncate text-xs text-muted-foreground">{deal.owner}</span>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Last touch · {deal.lastTouch}
        {deal.expectedClose ? ` · Closes ${formatDay(deal.expectedClose)}` : ''}
      </p>
      {deal.status === 'lost' && deal.lostReason ? (
        <p className="text-[11px] text-muted-foreground">Reason · {deal.lostReason}</p>
      ) : null}
      {deal.billing ? (
        <p className="text-[11px] text-muted-foreground">
          Invoiced · {formatRM(deal.billing.billed)}
          {deal.billing.outstanding > 0 ? ` · ${formatRM(deal.billing.outstanding)} owed` : ''}
        </p>
      ) : null}
      {children}
    </div>
  );
}

/** The "⋯" menu on a deal's card. */
function DealCardMenu({
  deal,
  moveTo,
  onEdit,
  onMove,
  onMarkLost,
  onReopen,
  onDelete,
  onClosed,
}: {
  deal: CrmDeal;
  /** The other stages of the deal's pipeline. */
  moveTo: CrmPipelineStage[];
  onEdit: () => void;
  onMove: (stage: CrmPipelineStage) => void;
  onMarkLost: () => void;
  onReopen: () => void;
  onDelete: () => void;
  /**
   * Called once the menu has gone, when focus is free to move. Returns true
   * when it moved focus to what the choice opened.
   */
  onClosed: () => boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${deal.title}`}
        className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-44"
        // Focus goes to what the choice opened; otherwise back to this button.
        onCloseAutoFocus={(event) => {
          if (onClosed()) event.preventDefault();
        }}
      >
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil />
          Edit
        </DropdownMenuItem>
        {moveTo.length > 0 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ArrowRightLeft />
              Move to
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="w-40">
                {moveTo.map((stage) => (
                  <DropdownMenuItem key={stage.id} onSelect={() => onMove(stage)}>
                    <span className={`size-2 shrink-0 rounded-full ${stage.dot}`} aria-hidden />
                    {stage.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        ) : null}
        {deal.status === 'lost' ? (
          <DropdownMenuItem onSelect={onReopen}>
            <RotateCcw />
            Reopen
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={onMarkLost}>
            <CircleX />
            Mark as lost
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A deal's card for people who can edit: the card, its menu, and the two
 * changes the menu makes straight away (Move to and Reopen).
 */
export function EditableDealCard({
  deal,
  stages,
  actions,
  onEdit,
  onMarkLost,
  onDelete,
  onMenuClosed,
  drag,
}: {
  deal: CrmDeal;
  /** Every stage of the deal's pipeline. */
  stages: CrmPipelineStage[];
  actions: CrmDealActions;
  onEdit: () => void;
  onMarkLost: () => void;
  onDelete: () => void;
  onMenuClosed: () => boolean;
  /** Dragging the card to another stage, which the board looks after. */
  drag: {
    /** True while a drop of this card is on its way to the server. */
    moving: boolean;
    /** Why the last drop of this card did not go through. */
    error?: string;
    /** True while this card is the one being dragged. */
    active: boolean;
    onStart: () => void;
    onEnd: () => void;
    /** Called when the menu starts a change of its own, so an old drop error goes. */
    onOtherChange: () => void;
  };
}) {
  const move = useCrmForm(actions.move);
  const reopen = useCrmForm(actions.reopen);
  const [, startTransition] = useTransition();
  const busy = move.pending || reopen.pending || drag.moving;
  const error = move.error ?? reopen.error ?? drag.error;

  // A drag reports the card, not what was pressed, so the press is noted
  // first: one that began on the menu button is not the start of a drag.
  const pressedControl = useRef(false);

  // These have no form on the page, so one is put together for the action.
  // The menu button stays enabled meanwhile, so focus can return to it.
  const send = (formAction: (formData: FormData) => void, fields: Record<string, string>) => {
    if (busy) return;
    drag.onOtherChange();
    const formData = new FormData();
    formData.set('dealId', deal.id);
    for (const [key, value] of Object.entries(fields)) formData.set(key, value);
    startTransition(() => formAction(formData));
  };

  return (
    <DealCard
      deal={deal}
      className={cn(!busy && 'cursor-grab active:cursor-grabbing', drag.active && 'opacity-50')}
      dragProps={{
        // Not while a move is already on its way.
        draggable: !busy,
        onPointerDownCapture: (event) => {
          pressedControl.current =
            event.target instanceof Element &&
            event.target.closest('button, a, input, [role="menu"]') !== null;
        },
        onDragStart: (event) => {
          if (busy || pressedControl.current) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData(DEAL_DRAG_TYPE, deal.id);
          drag.onStart();
        },
        onDragEnd: drag.onEnd,
      }}
      menu={
        <DealCardMenu
          deal={deal}
          moveTo={stages.filter((stage) => stage.id !== deal.stageId)}
          onEdit={onEdit}
          onMove={(stage) => send(move.formAction, { stageId: stage.id })}
          onMarkLost={onMarkLost}
          onReopen={() => send(reopen.formAction, {})}
          onDelete={onDelete}
          onClosed={onMenuClosed}
        />
      }
    >
      {busy ? (
        <p role="status" className="text-[11px] font-medium text-muted-foreground">
          {reopen.pending ? 'Reopening…' : 'Moving…'}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </DealCard>
  );
}

/** Takes a deal's place on the board while asking whether to really delete it. */
export function DeleteDealConfirm({
  deal,
  action,
  onClose,
  focusRef,
}: {
  deal: CrmDeal;
  action: CrmFormAction;
  onClose: () => void;
  /** Takes focus once the menu that opened this has closed. */
  focusRef: RefObject<HTMLElement | null>;
}) {
  const { formAction, pending, error } = useCrmForm(action, onClose);

  return (
    <form
      action={formAction}
      className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3"
    >
      <input type="hidden" name="dealId" value={deal.id} />
      <p className="text-sm">
        Delete <span className="font-medium">{deal.title}</span>? Its activities and notes are
        deleted too. This cannot be undone.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="destructive" size="sm" disabled={pending}>
          <Trash2 className="size-4" />
          {pending ? 'Deleting…' : 'Delete deal'}
        </Button>
        <Button
          ref={focusRef as RefObject<HTMLButtonElement | null>}
          type="button"
          variant="outline"
          size="sm"
          onClick={onClose}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Takes a deal's place on the board while asking why it was lost. */
export function LostDealConfirm({
  deal,
  action,
  onClose,
  focusRef,
  requireReason = false,
}: {
  deal: CrmDeal;
  action: CrmFormAction;
  onClose: () => void;
  /** Takes focus once the menu that opened this has closed. */
  focusRef: RefObject<HTMLElement | null>;
  /** The workspace's rule that a deal marked lost needs a reason (Kasturi > Settings). */
  requireReason?: boolean;
}) {
  const { formAction, pending, error: sentError, values } = useCrmForm(action, onClose);
  // Said before sending: a reason of only spaces passes `required`, and the database would refuse it.
  const [blankError, setBlankError] = useState<string | null>(null);
  const error = blankError ?? sentError;
  const reasonId = `lost-reason-${deal.id}`;

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        const reason = new FormData(event.currentTarget).get('lostReason');
        const problem = lostReasonProblem(typeof reason === 'string' ? reason : '', requireReason);
        setBlankError(problem);
        if (problem) event.preventDefault();
      }}
      className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3"
    >
      <input type="hidden" name="dealId" value={deal.id} />
      <p className="text-sm">
        Mark <span className="font-medium">{deal.title}</span> as lost? It leaves the open deals
        and counts against the win rate. You can reopen it later.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={reasonId}>{requireReason ? 'Reason' : 'Reason (optional)'}</Label>
        <Input
          ref={focusRef as RefObject<HTMLInputElement | null>}
          id={reasonId}
          name="lostReason"
          placeholder="Chose another vendor"
          defaultValue={values?.lostReason}
          maxLength={MAX_LOST_REASON_LENGTH}
          required={requireReason}
          aria-invalid={blankError ? true : undefined}
          onChange={() => setBlankError(null)}
          className="bg-background"
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="destructive" size="sm" disabled={pending}>
          <CircleX className="size-4" />
          {pending ? 'Saving…' : 'Mark as lost'}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
