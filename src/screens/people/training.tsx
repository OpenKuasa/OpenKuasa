import { BookOpen, ChartColumn, GraduationCap, PieChart, Plus } from 'lucide-react';
import { CourseAdmin } from '@/components/people/course-enrolments';
import { AddCourse } from '@/components/people/course-form';
import { EnrolButtons } from '@/components/people/enrol-buttons';
import { RequestRow } from '@/components/people/request-row';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { BarGroup, DonutStat, type Series, type Slice } from '@/components/charts';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { LiveDot } from '@/components/ui/live-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { todayInMalaysia } from '@/lib/people/dates';
import { enrolCandidates, memberCourseControl, trainingScreenControls } from '@/lib/people/goals-training';
import { showsWriteControls } from '@/lib/people/reviews-announcements';
import { TRAINING_STATUS_LABEL, type TrainingRow, buildTrainingModel } from '@/lib/people/performance';
import { HR_ONLY, LOAD_FAILED, LaterButton, Muted, StatusPill, loadPeople } from './parts';

const COMPLETION_SERIES: Series[] = [
  { key: 'enrolled', label: 'Enrolled', color: 'var(--chart-1)' },
  { key: 'completed', label: 'Completed', color: 'var(--chart-2)' },
];
const CATEGORY_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--muted-foreground)'];
const STATUS_TONE = { completed: 'good', in_progress: 'pending', upcoming: 'neutral' } as const;

export default async function TrainingScreen() {
  const { model: loaded, viewer } = await loadPeople('training', async (data, now, ctx) => {
    // Names are used only to list who is enrolled and who can be enrolled: an owner's or admin's controls.
    const names = showsWriteControls(ctx.viewer);
    const [trainings, enrolments, employees] = await Promise.all([
      data.listTrainings(),
      data.listTrainingEnrolments(),
      names ? data.listEmployees() : Promise.resolve([]),
    ]);
    const today = todayInMalaysia(now);
    return { model: buildTrainingModel(trainings, enrolments, ctx.viewer, today, employees), employees, today };
  });
  const model = loaded?.model ?? null;
  const today = loaded?.today ?? '';
  const employees = loaded?.employees ?? [];
  // What is rendered for this viewer is decided by one pure function: owner controls only for an owner or admin
  // outside the demo, placeholders only in the demo, the enrol column only for a linked member.
  const controls = trainingScreenControls(viewer, model !== null);
  const owner = controls.owner;
  const linked = viewer.employeeId !== null;
  const memberControls = controls.memberEnrol;
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
          controls.demoPlaceholders ? (
            <LaterButton icon={Plus} size="sm">
              Add course
            </LaterButton>
          ) : owner ? (
            <AddCourse />
          ) : null
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
            viewer.isDemo
              ? 'Courses and enrolment · enrolling is available in a later update'
              : team
                ? 'Courses and enrolment'
                : 'All courses, with your own enrolment'
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
                    ) : null}
                    <TableHead>Status</TableHead>
                    {owner ? <TableHead>Manage</TableHead> : null}
                    {controls.demoPlaceholders ? <TableHead>Enrol</TableHead> : null}
                    {memberControls ? <TableHead>Your enrolment</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {model.rows.map((row) => {
                    const cells = (
                      <>
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
                        ) : null}
                        <TableCell>{statusCell(row)}</TableCell>
                        {owner ? (
                          <TableCell className="whitespace-nowrap align-top">
                            <CourseAdmin
                              course={{
                                id: row.id,
                                title: row.title,
                                category_value: row.category_value,
                                provider: row.provider,
                                starts_on: row.starts_on,
                                ends_on: row.ends_on,
                              }}
                              people={row.people ?? []}
                              candidates={enrolCandidates(employees, row.people ?? [])}
                              today={today}
                            />
                          </TableCell>
                        ) : null}
                        {controls.demoPlaceholders ? (
                          <TableCell>
                            {row.status !== 'completed' ? (
                              <LaterButton variant="outline" size="sm" compact>
                                Enrol
                              </LaterButton>
                            ) : null}
                          </TableCell>
                        ) : null}
                        {memberControls ? (
                          <TableCell>
                            {(() => {
                              const control = memberCourseControl(
                                row,
                                row.mine === null ? null : { completed: row.mine === 'completed' },
                                today,
                                { linked, isDemo: viewer.isDemo },
                              );
                              return <EnrolButtons key={`${row.id}-${control}`} trainingId={row.id} control={control} title={row.title} />;
                            })()}
                          </TableCell>
                        ) : null}
                      </>
                    );
                    return owner ? (
                      <RequestRow key={row.id} columns={8}>
                        {cells}
                      </RequestRow>
                    ) : (
                      <TableRow key={row.id}>{cells}</TableRow>
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
