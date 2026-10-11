'use client';

import { useState } from 'react';
import { Check, ChevronDown, Loader2, TriangleAlert } from 'lucide-react';
import {
  approvalDetail,
  approvalTitle,
  toolMeta,
  type ItemKind,
  type PendingApproval,
  type ToolStep,
} from '@/components/chat/tool-parts';
import type { ReceiptState } from '@/lib/people/receipts';
import { cn } from '@/lib/utils';

/** One lookup the assistant ran: what it was, and its result on request. */
export function ToolStepCard({
  step,
  as,
}: {
  step: ToolStep;
  /** The tool this step stands for, when it ran through another (a prepared change). */
  as?: string;
}) {
  const [open, setOpen] = useState(false);
  const { label, Icon, detail } = toolMeta(as ?? step.name);
  const about = detail?.(step.output) ?? null;
  const canExpand = !step.running && step.output != null;

  return (
    <div className="rounded-xl border bg-muted/40 text-xs">
      <button
        type="button"
        onClick={canExpand ? () => setOpen((v) => !v) : undefined}
        aria-expanded={canExpand ? open : undefined}
        disabled={!canExpand}
        className={cn(
          'flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          canExpand ? 'cursor-pointer transition-colors hover:bg-accent' : 'cursor-default',
        )}
      >
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-background text-muted-foreground">
          <Icon className="size-3.5" />
        </span>
        <span className="font-medium">{label}</span>
        {about ? <span className="min-w-0 truncate">{about}</span> : null}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {step.running
            ? 'Working…'
            : step.afterApproval
              ? 'Not done'
              : step.reason
                ? 'Not shown for approval'
                : step.denied
                  ? 'Not approved'
                  : 'Done'}
        </span>
        {step.running ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        ) : canExpand ? (
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        ) : (
          <Check className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </button>
      {step.afterApproval ? (
        <p className="border-t px-3 py-2 leading-relaxed text-muted-foreground">
          This was approved, but a last check stopped it. Nothing was changed.
        </p>
      ) : step.reason ? (
        <p className="border-t px-3 py-2 leading-relaxed text-muted-foreground">{step.reason}</p>
      ) : null}
      {canExpand && open ? (
        <pre className="max-h-48 overflow-auto border-t px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {JSON.stringify(step.output, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

/** A change waiting for a yes or no. Nothing is saved until it is approved. */
export function ApprovalCard({
  approval,
  named,
  proposal,
  receipt,
  onDecide,
}: {
  approval: PendingApproval;
  /** A change a specialist prepared: its wording was settled when it was prepared. */
  proposal?: { title: string; detail: string | null } | null;
  /** Looks up the name of a row the change mentions by id. */
  named?: (id: unknown, kind?: ItemKind) => string | null;
  /** What the claim's question carried (from `receiptStateFor`), for a claim's card. */
  receipt?: ReceiptState;
  onDecide: (approved: boolean) => void;
}) {
  const detail = proposal ? proposal.detail : approvalDetail(approval.toolName, approval.input, receipt, named);
  const title = proposal?.title ?? approvalTitle(approval.toolName, approval.input, named);
  return (
    <div
      role="group"
      aria-label="Change waiting for your approval"
      className="rounded-xl border bg-card p-3 text-sm text-card-foreground shadow-sm"
    >
      <p className="font-medium">{title}</p>
      {approval.note ? <p className="mt-1 break-words text-foreground">{approval.note}</p> : null}
      {detail ? (
        <p className="mt-1 flex items-center gap-1.5 text-muted-foreground">
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          {detail}
        </p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => onDecide(true)}
          className="h-11 cursor-pointer rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => onDecide(false)}
          className="h-11 cursor-pointer rounded-lg border bg-background px-4 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Reject
        </button>
      </div>
    </div>
  );
}
