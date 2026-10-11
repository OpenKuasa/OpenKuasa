'use client';

import { useState } from 'react';
import { Check, ChevronDown, Loader2, TriangleAlert } from 'lucide-react';
import { PRODUCTS, getProduct } from '@/config/nav';
import { liveStepStatus, toolMeta } from '@/components/chat/tool-parts';
import type { AgentStep, Delegation } from '@/lib/chat/delegation';
import { cn } from '@/lib/utils';

/** How a step reads in the list: a lookup by what it looked up, a change as prepared. */
function stepLabel(step: AgentStep, isChange: boolean): string {
  const { label } = toolMeta(step.tool);
  if (!isChange) return label;
  return step.done ? `Prepared: ${label.toLowerCase()}` : `Preparing: ${label.toLowerCase()}`;
}

/** What the specialist is doing right now, in a few words. */
function liveStatus(work: Delegation, changes: Set<string>): string {
  const current = work.steps.find((step) => !step.done);
  if (current) {
    return changes.has(current.tool)
      ? 'Preparing a change…'
      : liveStepStatus(current.tool);
  }
  return work.steps.length === 0 ? 'Thinking…' : 'Writing up what it found…';
}

/**
 * A specialist at work for Tuah. Collapsed, it shows who is working, what
 * they are doing this moment, and a pip per step so progress is visible at a
 * glance. Opened, it lists every step and what was reported back.
 */
export function SpecialistCard({
  agent,
  work,
  failed = false,
}: {
  /** The specialist's name, shown from the moment Tuah starts handing over. */
  agent: string;
  /** The specialist's work so far; absent for the moment before it starts. */
  work: Delegation | null;
  /** The request itself failed, whatever the last progress said. */
  failed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Before any work comes back, the product is found by the specialist's name.
  const product =
    getProduct(work?.product) ?? PRODUCTS.find((p) => p.name === agent);
  const Icon = product?.icon;
  const name = work?.agent ?? agent;
  const status = failed ? 'failed' : (work?.status ?? 'working');
  const working = status === 'working';
  const steps = work?.steps ?? [];
  const changes = new Set((work?.proposals ?? []).map((p) => p.action));
  // A change being prepared is not in `proposals` until it is done.
  const isChange = (step: AgentStep) => changes.has(step.tool) || toolMeta(step.tool).isFallback;

  const summary =
    status === 'failed'
      ? 'Could not finish'
      : working
        ? work
          ? liveStatus(work, new Set(steps.filter(isChange).map((s) => s.tool)))
          : 'Getting the task…'
        : steps.length === 0
          ? 'Done'
          : `Done · ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`;

  return (
    <div className="overflow-hidden rounded-xl border bg-muted/40 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${name}: ${summary}. ${open ? 'Hide' : 'Show'} steps`}
        className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span
          data-product={product?.key}
          className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground"
          aria-hidden
        >
          {Icon ? <Icon className="size-4" /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold leading-tight">{name}</span>
          <span
            className="block truncate leading-tight text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            {summary}
          </span>
        </span>

        {steps.length > 0 ? (
          <span className="flex shrink-0 items-center gap-1" aria-hidden>
            {steps.slice(-6).map((step, i) => (
              <span
                key={i}
                className={cn(
                  'size-1.5 rounded-full transition-colors duration-200',
                  step.done
                    ? 'bg-primary'
                    : 'animate-pulse bg-muted-foreground/60 motion-reduce:animate-none',
                )}
              />
            ))}
          </span>
        ) : null}

        {status === 'failed' ? (
          <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
        ) : working ? (
          <Loader2
            className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
            aria-hidden
          />
        ) : (
          <Check className="size-4 shrink-0 text-primary" aria-hidden />
        )}
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>

      {/* A thin moving bar while work is under way, so a closed card still shows life. */}
      {working ? (
        <div className="h-0.5 w-full overflow-hidden bg-border" aria-hidden>
          <div className="h-full w-1/3 animate-[specialist-slide_1.4s_ease-in-out_infinite] bg-primary motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40" />
        </div>
      ) : null}

      {open ? (
        <div className="space-y-3 border-t px-3 py-3">
          {steps.length > 0 ? (
            <ol className="space-y-2" aria-label={`What ${name} did`}>
              {steps.map((step, i) => {
                const { Icon: StepIcon } = toolMeta(step.tool);
                return (
                  <li key={i} className="flex items-center gap-2">
                    <span className="grid size-5 shrink-0 place-items-center rounded-md bg-background text-muted-foreground">
                      <StepIcon className="size-3" />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{stepLabel(step, isChange(step))}</span>
                    {step.done ? (
                      <Check className="size-3.5 shrink-0 text-primary" aria-label="Done" />
                    ) : (
                      <Loader2
                        className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
                        aria-label="In progress"
                      />
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-muted-foreground">
              {working ? 'No lookups yet.' : 'Answered without looking anything up.'}
            </p>
          )}
          {work?.answer.trim() ? (
            <div>
              <p className="mb-1 font-medium text-muted-foreground">Reported to Tuah</p>
              <p className="whitespace-pre-wrap leading-relaxed">{work.answer.trim()}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
