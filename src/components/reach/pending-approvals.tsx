'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import type { AgentProposal } from '@/lib/agents/types';
import { applyProposalAction, rejectProposalAction } from '@/app/(app)/reach/actions';

type ActionResult = { ok: boolean; error?: string };

export function PendingApprovals({
  proposals,
  canEdit,
}: {
  proposals: AgentProposal[];
  canEdit: boolean;
}) {
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
        Pending approvals{proposals.length > 0 ? ` (${proposals.length})` : ''}
      </h3>
      {proposals.length === 0 ? (
        <p className="grid min-h-16 place-items-center text-center text-sm text-muted-foreground">
          No suggestions waiting — Jebat will add some after its next run.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {proposals.map((p) => (
            <li key={p.id} className="space-y-1.5 p-3 text-sm">
              <p className="font-medium">{p.title}</p>
              {p.rationale && <p className="text-muted-foreground">{p.rationale}</p>}
              {p.detail && <p className="text-muted-foreground">{p.detail}</p>}
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
                    Reject
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Ask an owner to review this.</p>
              )}
            </li>
          ))}
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
