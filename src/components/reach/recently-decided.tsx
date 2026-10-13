'use client';

import { AlertTriangle, CheckCircle2, Clock, XCircle } from 'lucide-react';
import type { AgentProposal, ProposalStatus } from '@/lib/agents/types';

type Outcome = Exclude<ProposalStatus, 'pending'>;

const OUTCOME: Record<Outcome, { label: string; Icon: typeof CheckCircle2 }> = {
  approved: { label: 'Approved', Icon: CheckCircle2 },
  rejected: { label: 'Rejected', Icon: XCircle },
  failed: { label: 'Failed', Icon: AlertTriangle },
  expired: { label: 'Expired', Icon: Clock },
};

/** A collapsed trail of the last few decided proposals and their outcome. */
export function RecentlyDecided({ decided }: { decided: AgentProposal[] }) {
  if (decided.length === 0) return null;
  return (
    <details className="space-y-2">
      <summary className="cursor-pointer text-sm font-medium">
        Recently decided ({decided.length})
      </summary>
      <ul className="divide-y rounded-md border">
        {decided.map((p) => {
          const outcome = OUTCOME[p.status as Outcome] ?? OUTCOME.expired;
          const Icon = outcome.Icon;
          return (
            <li key={p.id} className="flex items-center justify-between gap-2 p-3 text-sm">
              <span className="min-w-0 truncate text-muted-foreground">{p.title}</span>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                <Icon className="size-3.5" aria-hidden="true" />
                {outcome.label}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
