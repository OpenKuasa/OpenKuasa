import { BookOpen, ChartColumn, GraduationCap, PieChart, Plus } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { BarGroup, DonutStat, type Series, type Slice } from '@/components/charts';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { LiveDot } from '@/components/ui/live-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { todayInMalaysia } from '@/lib/people/dates';
import { TRAINING_STATUS_LABEL, type TrainingRow, buildTrainingModel } from '@/lib/people/performance';
import { HR_ONLY, LOAD_FAILED, LaterButton, Muted, StatusPill, loadPeople } from './parts';

const COMPLETION_SERIES: Series[] = [
  { key: 'enrolled', label: 'Enrolled', color: 'var(--chart-1)' },
  { key: 'completed', label: 'Completed', color: 'var(--chart-2)' },
];
const CATEGORY_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--muted-foreground)'];
const STATUS_TONE = { completed: 'good', in_progress: 'pending', upcoming: 'neutral' } as const;
const MINE_LABEL = { enrolled: 'You are enrolled', completed: 'Completed' } as const;

export default async function TrainingScreen() {
  const { model } = await loadPeople('training', async (data, now, ctx) => {
    const [trainings, enrolments, employees] = await Promise.all([data.listTrainings(), data.listTrainingEnrolments(), data.listEmployees()]);
    return buildTrainingModel(trainings, enrolments, ctx.viewer, todayInMalaysia(now), employees);
  });
  const dash = '—';
  const team = model?.team ?? true;
  const stats = model?.team_stats ?? null;
  const total = model ? model.by_status.upcoming + model.by_status.in_progress + model.by_status.completed : null;

  const categoryMix: Slice[] = (stats?.by_category ?? []).map((c, index) => ({
    key: c.category,
    label: c.category,
    value: c.count,
    color: CATEGORY_COLORS[index % CATEGORY_COLORS.length],
  }));

  const statusCell = (row: TrainingRow) => (
    <span className="flex items-center gap-2">
      <LiveDot active={row.status === 'in_progress'} />
      <StatusPill tone={STATUS_TONE[row.status]}>{TRAINING_STATUS_LABEL[row.status]}</StatusPill>
    </span>
  );

  return (
    <ScreenContainer>
      <PageHeader
        title="Training"
        subtitle={team ? 'Courses and sessions for your team' : 'Courses and sessions you can join'}
        actions={
          <LaterButton icon={Plus} size="sm">
            Add course
          </LaterButton>
        }
      />

      <BentoGrid>
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat label="Courses" value={total ?? dash} onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Upcoming" value={model ? model.by_status.upcoming : dash} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="In progress" value={model ? model.by_status.in_progress : dash} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Completed" value={model ? model.by_status.completed : dash} />
        </BentoCard>

        <BentoCard
          title="Completion by course"
          subtitle="Enrolled vs completed"
          icon={ChartColumn}
          className="col-span-2 md:col-span-8"
        >
          {!model ? (
            LOAD_FAILED
          ) : !stats ? (
            HR_ONLY
          ) : stats.enrolled === 0 ? (
            <Muted>No one is enrolled yet</Muted>
          ) : (
            <BarGroup data={stats.by_course} series={COMPLETION_SERIES} horizontal height={260} showLegend />
          )}
        </BentoCard>
        <BentoCard
          title="Enrolments by category"
          subtitle="Across all courses"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          {!model ? (
            LOAD_FAILED
          ) : !stats ? (
            HR_ONLY
          ) : stats.enrolled === 0 ? (
            <Muted>No one is enrolled yet</Muted>
          ) : (
            <DonutStat data={categoryMix} height={260} centerValue={String(stats.enrolled)} centerLabel="enrolled" />
          )}
        </BentoCard>

        <BentoCard
          title="All training"
          subtitle={
            team
              ? 'Courses and enrolment · enrolling is available in a later update'
              : 'All courses, with your own enrolment status in the You column · enrolling is available in a later update'
          }
          icon={BookOpen}
          flush
          className="col-span-2 md:col-span-12"
        >
          {!model ? (
            LOAD_FAILED
          ) : model.rows.length === 0 ? (
            <Muted>No training courses yet</Muted>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Course</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead className="whitespace-nowrap">Dates</TableHead>
                    {model.team ? (
                      <>
                        <TableHead className="text-right">Enrolled</TableHead>
                        <TableHead className="text-right">Completed</TableHead>
                      </>
                    ) : (
                      <TableHead>You</TableHead>
                    )}
                    <TableHead>Status</TableHead>
                    <TableHead>Enrol</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {model.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap font-medium">
                        <div className="flex items-center gap-3">
                          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                            <GraduationCap className="size-4" />
                          </span>
                          {row.title}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{row.category}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{row.provider ?? dash}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{row.dates}</TableCell>
                      {model.team ? (
                        <>
                          <TableCell className="text-right tabular-nums">{row.enrolled ?? 0}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.completed ?? 0} / {row.enrolled ?? 0}
                          </TableCell>
                        </>
                      ) : (
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {row.mine ? MINE_LABEL[row.mine] : dash}
                        </TableCell>
                      )}
                      <TableCell>{statusCell(row)}</TableCell>
                      <TableCell>
                        {row.status !== 'completed' && row.mine === null ? (
                          <LaterButton variant="outline" size="sm" compact>
                            Enrol
                          </LaterButton>
                        ) : null}
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
