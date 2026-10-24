'use client';

import Link from 'next/link';
import { useNavBadges } from '@/components/app/nav-badges-context';
import type { NavBadgeKey } from '@/config/nav';

/**
 * The live body of a product Overview's "AI agents" card: how many suggestions are waiting for a decision, and a
 * link to the product's AI Agents screen. The count is the same one the nav badge shows.
 */
export function AgentsOverview({ badge, href }: { badge: NavBadgeKey; href: string }) {
  const waiting = useNavBadges()[badge];
  return (
    <div className="flex h-full flex-col justify-between gap-3">
      <div>
        <p className="text-5xl font-semibold tabular-nums">{waiting}</p>
        <p className="text-sm text-muted-foreground">
          {waiting === 1 ? 'suggestion waiting for you' : 'suggestions waiting for you'}
        </p>
      </div>
      <Link href={href} className="text-sm font-medium text-primary hover:underline">
        Open AI Agents →
      </Link>
    </div>
  );
}
