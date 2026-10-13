import { Download, Layers, ListChecks, TrendingUp } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, type Series } from '@/components/charts';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { LiveDot } from '@/components/ui/live-dot';
import { AddClaimFor } from '@/components/people/add-claim-for';
import { AddLeaveFor, type LeaveEmployee } from '@/components/people/add-leave-for';
import { AddOvertimeFor } from '@/components/people/add-overtime-for';
import { RequestRow } from '@/components/people/request-row';
import { DecideButtons, type DecideKind } from '@/components/people/decide-buttons';
import { PaidButtons } from '@/components/people/paid-buttons';
import { ReceiptLink } from '@/components/people/receipt-link';
import { TeamDecideButtons } from '@/components/people/team-decide-buttons';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  APPROVAL_QUEUES,
  queueColumns,
  rowControls,
  screenControls,
  type ApprovalQueue,
  type ApprovalRow,
  type ApprovalsModel,
} from '@/lib/people/approvals';
import { OWN_REQUEST_REFUSAL } from '@/lib/people/leave';
import { teamScreenView, type TeamScreenView } from '@/lib/people/tier';
import type { PeopleViewer } from '@/lib/people/types';
import { cn } from '@/lib/utils';
import { EmployeeCell, HrOnlyScreen, LOAD_FAILED, LaterButton, Muted, StatusPill, requestTone } from './parts';

function Breakdown({ rows }: { rows: NonNullable<ApprovalsModel['breakdown']> }) {
  const max = Math.max(0, ...rows.map((row) => row.value));
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li key={row.label}>
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="font-medium">{row.label}</span>
            <span className="tabular-nums text-muted-foreground">{row.text}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${max > 0 ? (row.value / max) * 100 : 0}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

const DECIDE_KIND: Record<ApprovalQueue, DecideKind> = {
  leave: 'leave',
  claims: 'claim',
  overtime: 'overtime',
  time_off: 'time_off',
};

/** What a claim or overtime row shows besides its columns: the receipt, the year's total, the kind of day, the notes. */
function RowDetails({ row, view }: { row: ApprovalRow; view: TeamScreenView }) {
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      {row.claim ? (
        <>
          <div>
            <ReceiptLink claimId={row.id} hasFile={row.claim.has_file} ticked={row.claim.ticked} />
          </div>
          {row.claim.year_total ? (
            <div>
              {row.claim.year_total} approved or paid in {row.claim.year} in this category
            </div>
          ) : null}
          {row.claim.paid_on_text ? <div>Paid {row.claim.paid_on_text}</div> : null}
        </>
      ) : null}
      {row.overtime && view !== 'manager' ? (
        <>
          <div>{row.overtime.kind}</div>
          {row.overtime.calculated ? null : <div>Set a salary to work this out</div>}
        </>
      ) : null}
      {row.notes.map((line) => (
        <div key={line} className="max-w-64 whitespace-normal break-words">
          {line}
        </div>
      ))}
    </div>
  );
}

/**
 * The layout the four approval queues share. Approve, Reject and Cancel work
 * on all of them; claims also have Mark paid and Undo paid. Export stays
 * disabled. A demo visitor sees the working controls disabled. On their own
 * request an admin gets Cancel only: Approve, Reject and Mark paid are for the
 * workspace's owner or another admin (`row.decidable`).
 */
export function ApprovalsScreen({
  queue,
  model,
  viewer,
  employees,
}: {
  queue: ApprovalQueue;
  model: ApprovalsModel | null;
  viewer: PeopleViewer;
  /** Active employees, for the "Add … for…" buttons on leave, claims and overtime; omitted on time-off. */
  employees?: LeaveEmployee[];
}) {
  const config = APPROVAL_QUEUES[queue];
  const view = teamScreenView(viewer);
  if (view === 'none') return <HrOnlyScreen title={config.title} />;
  const controls = screenControls(view, config.subtitle);
  const columns = queueColumns(queue, view);

  const series: Series[] = [
    { key: 'submitted', label: `Submitted (${config.trendUnit})`, color: 'var(--chart-1)' },
    { key: 'approved', label: `Approved since (${config.trendUnit})`, color: 'var(--chart-2)' },
  ];
  const dash = '—';
  const tileSpan = queue === 'claims' ? 'md:col-span-3' : 'md:col-span-4';
  const hasDetails = queue === 'claims' || queue === 'overtime';
  const hasTrend = (model?.trend ?? []).some((b) => b.submitted > 0 || b.approved > 0);

  return (
    <ScreenContainer>
      <PageHeader
        className="mb-3"
        title={config.title}
        subtitle={controls.subtitle}
        actions={
          controls.addFor || controls.export ? (
            <div className="flex flex-wrap items-center gap-2">
              {controls.addFor && queue === 'leave' && employees ? (
                <AddLeaveFor employees={employees} disabled={controls.disabled} />
              ) : null}
              {controls.addFor && queue === 'claims' && employees ? (
                <AddClaimFor employees={employees} disabled={controls.disabled} />
              ) : null}
              {controls.addFor && queue === 'overtime' && employees ? (
                <AddOvertimeFor employees={employees} disabled={controls.disabled} />
              ) : null}
              {controls.export ? (
                <LaterButton variant="outline" size="sm" icon={Download}>
                  Export
                </LaterButton>
              ) : null}
            </div>
          ) : null
        }
      />

      <BentoGrid>
        <BentoCard tone="primary" className={cn('col-span-1', tileSpan)}>
          <BentoStat
            label="Pending"
            value={model ? model.pending.count : dash}
            delta={model?.pending.caption}
            deltaTone="flat"
            onPrimary
          />
        </BentoCard>
        <BentoCard className={cn('col-span-1', tileSpan)}>
          <BentoStat
            label="Approved this month"
            value={model ? model.approved.count : dash}
            delta={model?.approved.caption}
            deltaTone="flat"
          />
        </BentoCard>
        <BentoCard className={cn(model?.unpaid ? 'col-span-1' : 'col-span-2', tileSpan)}>
          <BentoStat
            label="Rejected this month"
            value={model ? model.rejected.count : dash}
            delta={model?.rejected.caption}
            deltaTone="flat"
          />
        </BentoCard>
        {model?.unpaid ? (
          <BentoCard className={cn('col-span-1', tileSpan)}>
            <BentoStat
              label="Approved, not yet paid"
              value={model.unpaid.count}
              delta={model.unpaid.caption}
              deltaTone="flat"
            />
          </BentoCard>
        ) : null}

        <BentoCard
          title={config.chartTitle}
          subtitle="By the week submitted · approved since counts those from that week that are approved now · last 8 weeks"
          icon={TrendingUp}
          className={cn('col-span-2', config.breakdownTitle ? 'md:col-span-8' : 'md:col-span-12')}
        >
          {!model ? (
            LOAD_FAILED
          ) : !hasTrend ? (
            <Muted>Nothing submitted in the last 8 weeks</Muted>
          ) : (
            <AreaTrend data={model.trend} series={series} height={220} showLegend />
          )}
        </BentoCard>
        {config.breakdownTitle ? (
          <BentoCard
            title={config.breakdownTitle}
            subtitle={config.breakdownSubtitle ?? undefined}
            icon={Layers}
            className="col-span-2 md:col-span-4"
          >
            {!model ? (
              LOAD_FAILED
            ) : !model.breakdown || model.breakdown.length === 0 ? (
              <Muted>Nothing is waiting for a decision</Muted>
            ) : (
              <Breakdown rows={model.breakdown} />
            )}
          </BentoCard>
        ) : null}

        <BentoCard
          title={config.tableTitle}
          subtitle={
            viewer.isDemo ? 'Most recent first · Sign up to decide requests in your own workspace' : 'Most recent first'
          }
          icon={ListChecks}
          flush
          className="col-span-2 md:col-span-12"
        >
          {!model ? (
            LOAD_FAILED
          ) : model.rows.length === 0 ? (
            <Muted>{config.emptyText}</Muted>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Employee</TableHead>
                    {columns.map((column) => (
                      <TableHead key={column.label} className={column.right ? 'text-right' : undefined}>
                        {column.label}
                      </TableHead>
                    ))}
                    {hasDetails ? <TableHead>Details</TableHead> : null}
                    <TableHead>Status</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {model.rows.map((row) => {
                    const offer = rowControls(view, row);
                    return (
                    <RequestRow key={row.id} columns={columns.length + (hasDetails ? 4 : 3)}>
                      <TableCell>
                        <EmployeeCell
                          name={row.employee_name}
                          sub={row.manager_label ? `Reports to ${row.manager_label}` : null}
                        />
                      </TableCell>
                      {row.cells.map((cell, index) => (
                        <TableCell
                          key={columns[index]?.label ?? index}
                          className={cn('whitespace-nowrap', columns[index]?.right && 'text-right tabular-nums')}
                        >
                          {cell}
                        </TableCell>
                      ))}
                      {hasDetails ? (
                        <TableCell className="align-top">
                          <RowDetails row={row} view={view} />
                        </TableCell>
                      ) : null}
                      <TableCell className="px-1.5">
                        <span className="flex max-w-48 flex-wrap items-center gap-1.5">
                          <LiveDot active={row.pending} />
                          <StatusPill tone={requestTone(row.status)}>{row.status_label}</StatusPill>
                          {row.yours ? <StatusPill tone="neutral">Yours</StatusPill> : null}
                          {/* Their own request, waiting on a decision or a payment they may not make themselves. */}
                          {offer.note === 'own-admin' ? (
                            <span title={OWN_REQUEST_REFUSAL}>
                              <StatusPill tone="neutral">Needs the owner or another admin</StatusPill>
                            </span>
                          ) : null}
                          {row.over_by > 0 ? (
                            <StatusPill tone="pending">
                              Over balance by {row.over_by} {row.over_by === 1 ? 'day' : 'days'}
                            </StatusPill>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap px-1.5">
                        {/* Side by side, not stacked; whatever a button opens appears in the row below. */}
                        <div className="flex items-center gap-1.5">
                          {view === 'manager' ? (
                            offer.decide ? <TeamDecideButtons kind={DECIDE_KIND[queue]} id={row.id} /> : <span className="text-muted-foreground">—</span>
                          ) : (
                            <>
                              {row.pending || row.cancellable ? (
                                <DecideButtons
                                  kind={DECIDE_KIND[queue]}
                                  id={row.id}
                                  pending={offer.decide}
                                  cancellable={offer.cancel}
                                  disabled={offer.disabled}
                                />
                              ) : null}
                              {row.claim && (offer.markPaid || offer.undoPaid) ? (
                                <PaidButtons
                                  id={row.id}
                                  paid={row.status === 'paid'}
                                  claimDate={row.claim.claim_date}
                                  disabled={offer.disabled}
                                />
                              ) : null}
                              {!row.pending && !row.cancellable && !row.claim?.markable && row.status !== 'paid' ? (
                                <span className="text-muted-foreground">—</span>
                              ) : null}
                            </>
                          )}
                        </div>
                      </TableCell>
                    </RequestRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
