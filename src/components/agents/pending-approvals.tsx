'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { ChangeList } from '@/components/chat/tool-cards';
import { Button } from '@/components/ui/button';
import { changeRows } from '@/lib/chat/change-rows';
import type { ItemKind, KnownNames } from '@/lib/chat/change-titles';
import type { AgentProposal } from '@/lib/agents/types';
import { applyProposalAction, rejectProposalAction } from '@/app/(app)/agents/actions';

type ActionResult = { ok: boolean; error?: string };

/**
 * A suggestion shown as a record link plus one line saying what approving does, built on the server.
 * `why` names the check that raised it; with a view the model's own rationale is not shown.
 */
export type SuggestionView = { href: string | null; effect: string; why: string | null };

export function PendingApprovals({
  proposals,
  names,
  canEdit,
  heading = 'Pending approvals',
  emptyText = 'No suggestions waiting — Jebat will add some after its next run.',
  rejectLabel = 'Reject',
  views,
}: {
  proposals: AgentProposal[];
  /** Names of the rows the suggestions point at, by `kind:id`, read on the server. */
  names?: KnownNames;
  canEdit: boolean;
  heading?: string;
  emptyText?: string;
  rejectLabel?: string;
  /** By proposal id: when given, the title links to its record and the effect line replaces the change list. */
  views?: Record<string, SuggestionView>;
}) {
  const find = (id: unknown, kind?: ItemKind) => (kind && typeof id === 'string' ? (names?.[`${kind}:${id}`] ?? null) : null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function run(id: string, p: Promise<ActionResult>) {
    setError(null);
    setBusyId(id);
    start(async () => {
      try {
        const res = await p;
        if (!res.ok) setError(res.error ?? 'Something went wrong.');
      } catch {
        setError('Something went wrong.');
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">
        {heading}{proposals.length > 0 ? ` (${proposals.length})` : ''}
      </h3>
      {proposals.length === 0 ? (
        <p className="grid min-h-16 place-items-center text-center text-sm text-muted-foreground">
          {emptyText}
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {proposals.map((p) => {
            const view = views?.[p.id];
            return (
              <li key={p.id} className="space-y-1.5 p-3 text-sm">
                {view?.href ? (
                  <p className="font-medium">
                    <Link href={view.href} className="text-primary underline-offset-4 hover:underline">
                      {p.title}
                    </Link>
                  </p>
                ) : (
                  <p className="font-medium">{p.title}</p>
                )}
                {view ? (
                  view.why && <p className="text-muted-foreground">Why it came up: {view.why}</p>
                ) : (
                  p.rationale && <p className="text-muted-foreground">{p.rationale}</p>
                )}
                {p.detail && <p className="text-muted-foreground">{p.detail}</p>}
                {view ? (
                  <p>{view.effect}</p>
                ) : (
                  /* Every value the change carries, from the stored proposal itself. */
                  <ChangeList rows={changeRows(p.action, p.input, find)} />
                )}
                {canEdit ? (
                  <div className="flex gap-2 pt-1">
                    <Button
                      type="button"
                      size="sm"
                      disabled={pending}
                      onClick={() => run(p.id, applyProposalAction({ id: p.id }))}
                    >
                      {busyId === p.id ? 'Working…' : 'Approve'}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => run(p.id, rejectProposalAction({ id: p.id }))}
                    >
                      {rejectLabel}
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Ask an owner to review this.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
