import Link from 'next/link';
import type { CrmConnections } from '@/lib/crm/connections';
import { cn } from '@/lib/utils';

const LINK = 'font-medium text-primary underline-offset-4 hover:underline';

export function plural(count: number | null, one: string, many: string) {
  if (count === null) return `Some ${many}`;
  return `${count.toLocaleString('en-MY')} ${count === 1 ? one : many}`;
}

/** A line of the screen that only reports something and says where to change it. */
export function StatusRow({
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
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border bg-background/50 px-3 py-2">
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

/** The AI key, email sending, the landing-page chatbot and automations, each with its state and where to set it. */
export function ConnectionRows({ connections }: { connections: CrmConnections }) {
  const { hasAiKey, emailSender, pagesWithChat, automationsOn } = connections;
  return (
    <ul className="space-y-1">
      <StatusRow
        label="AI key (OpenRouter)"
        value={hasAiKey ? 'Set' : 'Not set'}
        on={hasAiKey}
        href="/account/ai"
        linkLabel={hasAiKey ? 'Manage' : 'Add a key'}
      />
      <StatusRow
        label="Email sending (Resend)"
        value={emailSender ? `From ${emailSender}` : 'Not set'}
        on={emailSender !== null}
        href="/crm/broadcast"
        linkLabel={emailSender ? 'Manage' : 'Set up'}
      />
      <StatusRow
        label="Chatbot on landing pages"
        value={
          pagesWithChat === null
            ? 'Unknown'
            : pagesWithChat === 0
              ? 'Off'
              : `On for ${plural(pagesWithChat, 'page', 'pages')}`
        }
        on={(pagesWithChat ?? 0) > 0}
        href="/crm/chatbot"
        linkLabel="Open"
      />
      <StatusRow
        label="Automations"
        value={automationsOn === null ? 'Unknown' : automationsOn === 0 ? 'None on' : `${automationsOn} on`}
        on={(automationsOn ?? 0) > 0}
        href="/crm/automations"
        linkLabel="Open"
      />
    </ul>
  );
}
