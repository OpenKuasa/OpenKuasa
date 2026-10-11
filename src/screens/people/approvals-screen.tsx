import { Download, Layers, ListChecks, TrendingUp } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { AreaTrend, type Series } from '@/components/charts';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { LiveDot } from '@/components/ui/live-dot';
import { AddLeaveFor, type LeaveEmployee } from '@/components/people/add-leave-for';
import { DecideButtons } from '@/components/people/decide-buttons';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { APPROVAL_QUEUES, type ApprovalQueue, type ApprovalsModel } from '@/lib/people/approvals';
import { isTeamView } from '@/lib/people/own';
import type { PeopleViewer } from '@/lib/people/types';
import { cn } from '@/lib/utils';
import { EmployeeCell, HrOnlyScreen, LATER_NOTE, LOAD_FAILED, LaterButton, Muted, StatusPill, requestTone } from './parts';

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

/**
 * The layout the four approval queues share. On the queues whose config
 * `decides` (leave, time-off) Approve, Reject and Cancel work; on the others
 * (claims, overtime) they stay disabled, as does Export. A demo visitor sees
 * the working controls disabled.
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
  /** Active employees, for "Add leave for…" on the leave queue; omitted elsewhere. */
  employees?: LeaveEmployee[];
}) {
  const config = APPROVAL_QUEUES[queue];
  if (!isTeamView(viewer)) return <HrOnlyScreen title={config.title} />;

  const series: Series[] = [
    { key: 'submitted', label: `Submitted (${config.trendUnit})`, color: 'var(--chart-1)' },
    { key: 'approved', label: `Approved since (${config.trendUnit})`, color: 'var(--chart-2)' },
  ];
  const dash = '—';
  const hasTrend = (model?.trend ?? []).some((b) => b.submitted > 0 || b.approved > 0);

  return (
    <ScreenContainer>
      <PageHeader
        className="mb-3"
        title={config.title}
        subtitle={config.subtitle}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {queue === 'leave' && employees ? <AddLeaveFor employees={employees} disabled={viewer.isDemo} /> : null}
            <LaterButton variant="outline" size="sm" icon={Download}>
              Export
            </LaterButton>
          </div>
        }
      />

      <BentoGrid>
        <BentoCard tone="primary" className="col-span-1 md:col-span-4">
          <BentoStat
            label="Pending"
            value={model ? model.pending.count : dash}
            delta={model?.pending.caption}
            deltaTone="flat"
            onPrimary
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-4">
          <BentoStat
            label="Approved this month"
            value={model ? model.approved.count : dash}
            delta={model?.approved.caption}
            deltaTone="flat"
          />
        </BentoCard>
        <BentoCard className="col-span-2 md:col-span-4">
          <BentoStat
            label="Rejected this month"
            value={model ? model.rejected.count : dash}
            delta={model?.rejected.caption}
            deltaTone="flat"
          />
        </BentoCard>

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
            config.decides
              ? viewer.isDemo
                ? 'Most recent first · Sign up to decide requests in your own workspace'
                : 'Most recent first'
              : `Most recent first · Approve and Reject: ${LATER_NOTE.toLowerCase()}`
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
                    {config.columns.map((column) => (
                      <TableHead key={column.label} className={column.right ? 'text-right' : undefined}>
                        {column.label}
                      </TableHead>
                    ))}
                    <TableHead>Status</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {model.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <EmployeeCell name={row.employee_name} />
                      </TableCell>
                      {row.cells.map((cell, index) => (
                        <TableCell
                          key={config.columns[index]?.label ?? index}
                          className={cn('whitespace-nowrap', config.columns[index]?.right && 'text-right tabular-nums')}
                        >
                          {cell}
                        </TableCell>
                      ))}
                      <TableCell>
                        <span className="flex flex-wrap items-center gap-2">
                          <LiveDot active={row.pending} />
                          <StatusPill tone={requestTone(row.status)}>{row.status_label}</StatusPill>
                          {row.yours ? <StatusPill tone="neutral">Yours</StatusPill> : null}
                          {row.over_by > 0 ? (
                            <StatusPill tone="pending">
                              Over balance by {row.over_by} {row.over_by === 1 ? 'day' : 'days'}
                            </StatusPill>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell>
                        {config.decides ? (
                          <DecideButtons
                            kind={queue === 'leave' ? 'leave' : 'time_off'}
                            id={row.id}
                            pending={row.pending}
                            cancellable={row.cancellable}
                            disabled={viewer.isDemo}
                          />
                        ) : row.pending ? (
                          <span className="flex gap-2">
                            <LaterButton size="sm" compact>
                              Approve
                            </LaterButton>
                            <LaterButton variant="outline" size="sm" compact>
                              Reject
                            </LaterButton>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
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
