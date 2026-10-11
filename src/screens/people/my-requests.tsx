import { ClipboardList, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { CancelRequestButton } from '@/components/people/cancel-request-button';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { LiveDot } from '@/components/ui/live-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { REQUEST_STATUS_LABEL } from '@/lib/people/own';
import type { RequestStatus } from '@/lib/people/types';
import { LOAD_FAILED, LaterButton, Muted, NotLinkedCard, StatusPill, requestTone } from './parts';

/** The status column: a live dot while a request waits, then the pill. */
export function StatusCell({ status, note }: { status: RequestStatus; note?: string | null }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-center gap-2">
        <LiveDot active={status === 'pending'} />
        <StatusPill tone={requestTone(status)}>{REQUEST_STATUS_LABEL[status]}</StatusPill>
      </span>
      {note ? (
        <span className="max-w-56 whitespace-normal text-xs text-muted-foreground">Note: {note}</span>
      ) : null}
    </span>
  );
}

export const DEMO_SIGN_UP_NOTE = 'Sign up to try this with your own team.';

/**
 * The header control of a screen where members can act: the live `apply`
 * control for a linked member, the disabled "later" button and an invitation
 * for a demo visitor, and nothing for an account that is linked to no
 * employee (or when the read failed).
 */
export function requestHeaderAction({
  model,
  isDemo,
  label,
  apply,
}: {
  model: { linked: boolean } | null;
  isDemo: boolean;
  label: string;
  apply: ReactNode;
}): ReactNode {
  if (isDemo) {
    return (
      <span className="flex flex-col items-end gap-1">
        <LaterButton icon={Plus} size="sm">
          {label}
        </LaterButton>
        <span className="text-xs text-muted-foreground">{DEMO_SIGN_UP_NOTE}</span>
      </span>
    );
  }
  return model?.linked ? apply : null;
}

/** The last cell of a row: Cancel when the rule allows it, the disabled button for a demo visitor, else nothing. */
export function requestCancelCell({
  cancellable,
  isDemo,
  kind,
  id,
}: {
  cancellable: boolean;
  isDemo: boolean;
  kind: 'leave' | 'time-off';
  id: string;
}): ReactNode {
  if (!cancellable) return null;
  if (isDemo) return <LaterButton variant="outline" size="sm" compact>Cancel</LaterButton>;
  return <CancelRequestButton kind={kind} id={id} />;
}

export type RequestKpi = { label: string; value: ReactNode; caption?: string };

export type RequestTableRow = {
  key: string;
  /** One node per column. The cell for the first column is shown in bold. */
  cells: ReactNode[];
};

/**
 * The layout the four "my requests" screens share: a header with one control,
 * four figures, two summary cards, and the person's own requests. By default
 * the control is the disabled "later" button named by `laterLabel`; a screen
 * that is built passes `headerAction` instead (null for no control at all).
 * `model` is null when the read failed; `linked` is false when the account is
 * linked to no employee record.
 */
export function MyRequestsScreen({
  title,
  subtitle,
  laterLabel,
  headerAction,
  model,
  kpis,
  summary,
  tableSubtitle,
  columns,
  rows,
  emptyText,
}: {
  title: string;
  subtitle: string;
  laterLabel: string;
  /** Replaces the "later" button: a live control, or null for none. Left out, the "later" button shows. */
  headerAction?: ReactNode;
  /** Null when the read failed. */
  model: { linked: boolean } | null;
  kpis: RequestKpi[];
  /** The two summary cards, as BentoCards with their own grid spans. */
  summary: ReactNode;
  tableSubtitle: string;
  columns: string[];
  rows: RequestTableRow[];
  emptyText: string;
}) {
  const header = (
    <PageHeader
      className="mb-3"
      title={title}
      subtitle={subtitle}
      actions={
        headerAction !== undefined ? (
          headerAction
        ) : (
          <LaterButton icon={Plus} size="sm">
            {laterLabel}
          </LaterButton>
        )
      }
    />
  );

  if (!model) {
    return (
      <ScreenContainer>
        {header}
        <BentoGrid>
          <BentoCard className="col-span-2 md:col-span-12">{LOAD_FAILED}</BentoCard>
        </BentoGrid>
      </ScreenContainer>
    );
  }

  if (!model.linked) {
    return (
      <ScreenContainer>
        {header}
        <BentoGrid>
          <NotLinkedCard />
        </BentoGrid>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      {header}
      <BentoGrid>
        {kpis.map((kpi, index) => (
          <BentoCard key={kpi.label} tone={index === 0 ? 'primary' : 'default'} className={kpis.length === 3 ? 'col-span-1 md:col-span-4' : 'col-span-1 md:col-span-3'}>
            <BentoStat
              label={kpi.label}
              value={kpi.value}
              delta={kpi.caption}
              deltaTone="flat"
              onPrimary={index === 0}
            />
          </BentoCard>
        ))}

        {summary}

        <BentoCard
          title="My requests"
          subtitle={tableSubtitle}
          icon={ClipboardList}
          flush
          className="col-span-2 md:col-span-12"
        >
          {rows.length === 0 ? (
            <Muted>{emptyText}</Muted>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    {columns.map((column) => (
                      <TableHead key={column} className="whitespace-nowrap">
                        {column}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.key}>
                      {row.cells.map((cell, index) => (
                        <TableCell
                          key={columns[index]}
                          className={index === 0 ? 'whitespace-nowrap font-medium' : 'whitespace-nowrap'}
                        >
                          {cell}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
