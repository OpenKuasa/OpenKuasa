'use client';

import { useId, useState, useTransition } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ApplicationDetails, ApplicationState, PanelInterview, SafeLink } from '@/lib/hire/lists';
import type { PoolStatus } from '@/lib/hire/types';
import { viewCvAction } from '@/app/(app)/hire/actions';
import { panelShowsHelper } from '@/lib/hire/feedback-dialog-state';
import { PANEL_FEEDBACK_HELPER, panelFeedbackLine } from '@/lib/hire/interview-feedback';
import { PANEL_EMPTY, PANEL_HEADING, panelLine, panelMore, panelRows } from '@/lib/hire/interview-dialog-state';
import { cn } from '@/lib/utils';
import { LiveDot } from '@/components/ui/live-dot';
import { Badge } from '@/components/ui/badge';
import { TableCell, TableRow } from '@/components/ui/table';
import { ApplicationActions } from '@/screens/hire/application-actions';

/** 44 pixels of hit area on every button and link. */
const TARGET = 'min-h-11 min-w-11';
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** One application, as plain data from the server. */
export type ApplicationRowData = {
  id: string;
  /** The person's id, for the Edit candidate form. Their contact details are not here. */
  candidateId: string;
  name: string;
  job: string;
  source: string;
  status: string;
  /** The classes for the status pill, chosen on the server. */
  statusClass: string;
  live: boolean;
  applied: string;
  details: ApplicationDetails | null;
} & ApplicationState & {
  /** The person's stored talent pool status; left out reads as not in the pool. */
  poolStatus?: PoolStatus;
  /** This application's interviews, the ones ahead first. Left out reads as none. No contact details and no notes. */
  interviews?: PanelInterview[];
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

/** The uploaded CV: opened through a short-lived link made on the server, in a tab opened at once so a popup blocker allows it. */
function ViewCv({ applicationId }: { applicationId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    if (pending) return;
    setError(null);
    const tab = window.open('about:blank', '_blank');
    startTransition(async () => {
      try {
        const result = await viewCvAction(applicationId);
        if (result.ok) {
          if (tab) {
            tab.opener = null;
            tab.location.replace(result.url);
          } else {
            // The link is a download, so this page stays.
            window.location.assign(result.url);
          }
          return;
        }
        tab?.close();
        setError(result.error);
      } catch {
        tab?.close();
        setError("Couldn't open the CV. Try again.");
      }
    });
  };

  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">CV file</dt>
      <dd>
        <button
          type="button"
          aria-disabled={pending || undefined}
          onClick={open}
          className={cn(
            'inline-flex items-center rounded-md border px-3 text-sm font-medium hover:bg-muted',
            'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent',
            TARGET,
            FOCUS,
          )}
        >
          {pending ? 'Opening…' : 'View CV'}
        </button>
        {error ? (
          <p role="alert" className="mt-1 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </dd>
    </div>
  );
}

/**
 * The application's interviews, for reading while deciding: at most five, then
 * how many more there are. Shown to everyone who can open the panel, viewers
 * included. An interview is changed on the Interviews screen, not here. A
 * place is a link only from `placeLink`, which the server made with `safeLink`.
 * An interview's feedback is shown under its line, to everyone who can open the panel; it is recorded on the Interviews screen.
 */
function InterviewList({ interviews }: { interviews: PanelInterview[] }) {
  const { shown, more } = panelRows(interviews);
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-xs font-medium text-muted-foreground">{PANEL_HEADING}</h4>
      {/* The application has a rating of its own, in the controls below: neither sets the other. */}
      {panelShowsHelper(shown) ? <p className="text-xs text-muted-foreground">{PANEL_FEEDBACK_HELPER}</p> : null}
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{PANEL_EMPTY}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((interview) => (
            <li key={interview.id} className="max-w-prose text-sm">
              <p className="break-words">{panelLine(interview)}</p>
              {interview.placeLink ? (
                <a
                  href={interview.placeLink.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn('inline-flex max-w-full items-center rounded-md break-all text-primary underline underline-offset-2', TARGET, FOCUS)}
                >
                  {interview.placeLink.host}
                </a>
              ) : interview.place ? (
                <p className="break-words text-muted-foreground">{interview.place}</p>
              ) : null}
              {interview.feedback ? (
                <div className="mt-1">
                  <p className="break-words">{panelFeedbackLine(interview.feedback)}</p>
                  {/* In full, with their line breaks, wrapped inside the panel: a long word must not widen the page. */}
                  {interview.feedback.comments ? (
                    <p className="whitespace-pre-line break-words text-muted-foreground">{interview.feedback.comments}</p>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {more > 0 ? <p className="text-xs text-muted-foreground">{panelMore(more)}</p> : null}
    </section>
  );
}

/**
 * The table row of an application and, under it, the row of its details (hidden until opened): what the applicant
 * gave on the form, then its interviews, then the controls that change the application. Someone who may not edit gets
 * the details and the interviews alone, and no button where there is nothing to open.
 */
export function ApplicationRow({ row, canEdit }: { row: ApplicationRowData; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { details } = row;
  const interviews = row.interviews ?? [];
  // Something to open: what the applicant gave, the controls, or interviews to read. A viewer of an application with
  // none of the three still gets no button.
  const hasPanel = details !== null || canEdit || interviews.length > 0;

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
          {hasPanel ? (
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
      {hasPanel ? (
        <TableRow id={panelId} hidden={!open} className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={6} className="whitespace-normal">
            {/* Held to the width of the screen, and kept in view when a narrow table is scrolled sideways. */}
            <div className="sticky left-4 flex w-[min(100%,calc(100vw-4rem))] flex-col gap-4 py-1">
            {details ? (
            <dl className="flex flex-col gap-3">
              {details.coverLetter ? (
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Cover letter</dt>
                  <dd className="max-w-prose whitespace-pre-line break-words text-sm">{details.coverLetter}</dd>
                </div>
              ) : null}
              {details.hasCvFile ? <ViewCv applicationId={row.id} /> : null}
              {details.cv ? <DetailLink label="CV" link={details.cv} /> : null}
              {details.portfolio ? <DetailLink label="Portfolio" link={details.portfolio} /> : null}
              {details.expectedSalary ? (
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Expected salary</dt>
                  <dd className="text-sm">{details.expectedSalary}</dd>
                </div>
              ) : null}
            </dl>
            ) : null}
            <InterviewList interviews={interviews} />
            <ApplicationActions
              application={{
                id: row.id, candidateId: row.candidateId, name: row.name, job: row.job,
                stage: row.stage, outcome: row.outcome, rating: row.rating, rejectReason: row.rejectReason,
                poolStatus: row.poolStatus,
              }}
              canEdit={canEdit}
            />
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
