'use client';

import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ApplicationDetails, SafeLink } from '@/lib/hire/lists';
import { cn } from '@/lib/utils';
import { LiveDot } from '@/components/ui/live-dot';
import { Badge } from '@/components/ui/badge';
import { TableCell, TableRow } from '@/components/ui/table';

/** 44 pixels of hit area on every button and link. */
const TARGET = 'min-h-11 min-w-11';
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** One application, as plain data from the server. */
export type ApplicationRowData = {
  id: string;
  name: string;
  job: string;
  source: string;
  status: string;
  /** The classes for the status pill, chosen on the server. */
  statusClass: string;
  live: boolean;
  applied: string;
  details: ApplicationDetails | null;
};

/** A link is drawn only from a SafeLink, never from a raw string. */
function DetailLink({ label, link }: { label: string; link: SafeLink }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd>
        <a
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          // A long host wraps inside the panel instead of widening the table.
          className={cn('inline-flex max-w-full items-center rounded-md break-all text-primary underline underline-offset-2', TARGET, FOCUS)}
        >
          {link.host}
        </a>
      </dd>
    </div>
  );
}

/** The table row of an application and, under it, the row of its details (hidden until opened). */
export function ApplicationRow({ row }: { row: ApplicationRowData }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { details } = row;

  return (
    <>
      <TableRow>
        <TableCell>
          <div className="flex items-center gap-2">
            <LiveDot active={row.live} />
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
              {row.name.charAt(0)}
            </span>
            <span className="whitespace-nowrap font-medium">{row.name}</span>
          </div>
        </TableCell>
        <TableCell className="whitespace-nowrap">{row.job}</TableCell>
        <TableCell>
          <Badge variant="secondary">{row.source}</Badge>
        </TableCell>
        <TableCell>
          <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', row.statusClass)}>{row.status}</span>
        </TableCell>
        <TableCell className="whitespace-nowrap text-muted-foreground">{row.applied}</TableCell>
        <TableCell>
          {details ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={panelId}
              aria-label={`Details for ${row.name}`}
              onClick={() => setOpen((value) => !value)}
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-2 text-sm font-medium hover:bg-muted',
                TARGET,
                FOCUS,
              )}
            >
              Details
              <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} aria-hidden />
            </button>
          ) : null}
        </TableCell>
      </TableRow>
      {details ? (
        <TableRow id={panelId} hidden={!open} className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={6} className="whitespace-normal">
            <dl className="flex flex-col gap-3 py-1">
              {details.coverLetter ? (
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Cover letter</dt>
                  <dd className="max-w-prose whitespace-pre-line break-words text-sm">{details.coverLetter}</dd>
                </div>
              ) : null}
              {details.cv ? <DetailLink label="CV" link={details.cv} /> : null}
              {details.portfolio ? <DetailLink label="Portfolio" link={details.portfolio} /> : null}
              {details.expectedSalary ? (
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Expected salary</dt>
                  <dd className="text-sm">{details.expectedSalary}</dd>
                </div>
              ) : null}
            </dl>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
