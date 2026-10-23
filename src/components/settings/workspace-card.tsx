import Link from 'next/link';
import { Users } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import type { WorkspaceOverview } from '@/lib/account/workspace-overview';
import { cn } from '@/lib/utils';

// 44 pixels tall, so each link is easy to tap on a phone.
const LINK = 'inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline';

export function plural(count: number | null, one: string, many: string) {
  if (count === null) return `Some ${many}`;
  return `${count.toLocaleString('en-MY')} ${count === 1 ? one : many}`;
}

/** A line of a settings screen that only reports something and says where to change it. */
export function SettingsRow({
  label,
  value,
  href,
  linkLabel,
  on,
}: {
  label: string;
  value: string;
  href: string;
  linkLabel: string;
  /** Draws the value as a state pill: green when on, grey when not. */
  on?: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 rounded-lg border bg-background/50 px-3 py-0.5">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {on === undefined ? <p className="truncate text-xs text-muted-foreground">{value}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {on === undefined ? null : (
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-medium',
              on ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground',
            )}
          >
            {value}
          </span>
        )}
        <Link href={href} className={cn(LINK, 'text-xs')}>
          {linkLabel}
        </Link>
      </div>
    </li>
  );
}

/**
 * The first card of every product's Settings: the company and the team, with links to Account, the one
 * place they are changed. `overview` is null when it could not be read; the card says so.
 */
export function WorkspaceCard({ overview, className }: { overview: WorkspaceOverview | null; className?: string }) {
  return (
    <BentoCard
      title="Workspace"
      subtitle="Set in your account, used across every product"
      // The card's icon chip only draws icons from the animated set.
      icon={Users}
      className={className ?? 'col-span-2 md:col-span-6'}
    >
      {overview ? (
        <ul className="space-y-1">
          <SettingsRow
            label={overview.companyName}
            value={overview.registrationNo ? `Reg. no ${overview.registrationNo}` : 'No registration number yet'}
            href="/account/company"
            linkLabel={overview.canEdit === false ? 'View company' : 'Edit company'}
          />
          <SettingsRow
            label="Team"
            value={plural(overview.members, 'person has', 'people have') + ' access to this workspace'}
            href="/account/team"
            linkLabel={overview.canEdit === false ? 'View team' : 'Manage team'}
          />
        </ul>
      ) : (
        <p className="grid min-h-16 place-items-center text-sm text-muted-foreground">Couldn&apos;t load</p>
      )}
    </BentoCard>
  );
}
