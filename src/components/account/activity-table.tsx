import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { UserAvatar } from '@/components/account/user-avatar';
import type { ActivityEntry } from '@/lib/account/activity';

const WHEN = new Intl.DateTimeFormat('en-MY', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Kuala_Lumpur',
});

const CATEGORY_BADGES: Record<
  string,
  { label: string; variant: 'secondary' | 'outline' | 'destructive' }
> = {
  auth: { label: 'Sign-in', variant: 'secondary' },
  team: { label: 'Team', variant: 'secondary' },
  data: { label: 'Data', variant: 'outline' },
  security: { label: 'Security', variant: 'destructive' },
  billing: { label: 'Billing', variant: 'outline' },
  mcp: { label: 'AI tool', variant: 'secondary' },
};

export function ActivityTable({ entries }: { entries: ActivityEntry[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Who</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Target</TableHead>
          <TableHead>Category</TableHead>
          <TableHead className="pr-4 text-right">When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((e) => {
          const badge = CATEGORY_BADGES[e.category] ?? {
            label: e.category,
            variant: 'outline' as const,
          };
          return (
            <TableRow key={e.id}>
              <TableCell className="pl-4">
                <div className="flex items-center gap-2.5">
                  <UserAvatar
                    initials={e.actorInitials}
                    className="size-7"
                    fallbackClassName="text-[0.65rem]"
                  />
                  <span className="font-medium">{e.actorName}</span>
                </div>
              </TableCell>
              <TableCell className="max-w-xs truncate">{e.action}</TableCell>
              <TableCell className="max-w-56 truncate text-muted-foreground">
                {e.target ?? '-'}
              </TableCell>
              <TableCell>
                <Badge variant={badge.variant}>{badge.label}</Badge>
              </TableCell>
              <TableCell className="pr-4 text-right text-muted-foreground tabular-nums">
                <time dateTime={e.createdAt}>
                  {WHEN.format(new Date(e.createdAt))}
                </time>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
