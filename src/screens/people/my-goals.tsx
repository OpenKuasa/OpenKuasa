import { AlertTriangle, CircleCheck, Flag, Gauge, Plus, Target, TrendingUp } from 'lucide-react';
import { deleteMyGoalAction, saveMyGoalAction } from '@/app/(app)/people/performance-actions';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { BarGroup, RadialGauge, type Series } from '@/components/charts';
import { GoalCardControls } from '@/components/people/goal-card-controls';
import { AddGoal } from '@/components/people/goal-form';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { Progress } from '@/components/ui/progress';
import { formatDate } from '@/lib/people/dates';
import { myGoalsControls } from '@/lib/people/goals-training';
import { type GoalRow, buildGoalsModel } from '@/lib/people/performance';
import { LOAD_FAILED, LaterButton, Muted, NotLinkedCard, StatusPill, loadPeople } from './parts';

const PROGRESS_SERIES: Series[] = [{ key: 'progress', label: 'Progress %', color: 'var(--chart-1)' }];

const STATUS_LABEL: Record<GoalRow['status'], string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  done: 'Done',
};
const STATUS_TONE = { on_track: 'good', at_risk: 'pending', done: 'neutral' } as const;
const STATUS_ICON = { on_track: Target, at_risk: AlertTriangle, done: CircleCheck } as const;

export default async function MyGoalsScreen() {
  const { model, viewer } = await loadPeople('my-goals', async (data, _now, ctx) => {
    // Not linked to an employee: nothing to read, the builder answers "not linked".
    if (ctx.viewer.employeeId === null) return buildGoalsModel([], ctx.viewer);
    return buildGoalsModel(await data.listGoals(), ctx.viewer);
  });
  const dash = '—';
  // Every new control is absent in the demo (the server refuses there); the placeholder stays for the visitor.
  const controls = myGoalsControls(viewer, model ? { linked: model.linked } : null);
  const header = (
    <PageHeader
      title="My Goals"
      subtitle="Your objectives and how far along they are"
      actions={
        controls.placeholder ? (
          <LaterButton icon={Plus} size="sm">
            Add Goal
          </LaterButton>
        ) : controls.add ? (
          <AddGoal save={saveMyGoalAction} />
        ) : null
      }
    />
  );

  if (model && !model.linked) {
    return (
      <ScreenContainer>
        {header}
        <BentoGrid>
          <NotLinkedCard />
        </BentoGrid>
      </ScreenContainer>
    );
  }

  const average = model?.average_progress ?? null;
  return (
    <ScreenContainer>
      {header}

      <BentoGrid>
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat label="Goals" value={model ? model.counts.total : dash} onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="On track" value={model ? model.counts.on_track : dash} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="At risk" value={model ? model.counts.at_risk : dash} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Average progress" value={average === null ? dash : `${average}%`} />
        </BentoCard>

        <BentoCard
          title="Overall progress"
          subtitle="Average across your goals"
          icon={Gauge}
          className="col-span-2 md:col-span-4"
        >
          {!model ? (
            LOAD_FAILED
          ) : average === null ? (
            <Muted>No goals yet</Muted>
          ) : (
            <RadialGauge value={average} valueLabel={`${average}%`} label="complete" color="var(--chart-1)" height={220} />
          )}
        </BentoCard>
        <BentoCard
          title="Progress by goal"
          subtitle="Completion per objective"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          {!model ? (
            LOAD_FAILED
          ) : model.goals.length === 0 ? (
            <Muted>No goals yet</Muted>
          ) : (
            <BarGroup
              data={model.goals.map((g) => ({ label: g.short, progress: g.progress }))}
              series={PROGRESS_SERIES}
              horizontal
              height={220}
            />
          )}
        </BentoCard>

        {!model ? (
          <BentoCard className="col-span-2 md:col-span-12">{LOAD_FAILED}</BentoCard>
        ) : (
          model.goals.map((g) => {
            const Icon = STATUS_ICON[g.status];
            return (
              <BentoCard
                key={g.id}
                title={g.title}
                icon={Icon}
                action={<StatusPill tone={STATUS_TONE[g.status]}>{STATUS_LABEL[g.status]}</StatusPill>}
                className="col-span-2 md:col-span-6"
              >
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Progress</span>
                      <span className="font-semibold tabular-nums">{g.progress}%</span>
                    </div>
                    <Progress value={g.progress} />
                  </div>
                  {g.due_date ? (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Flag className="size-3.5" />
                      <span>Due {formatDate(g.due_date)}</span>
                    </div>
                  ) : null}
                  {controls.cards ? (
                    <GoalCardControls
                      key={`${g.id}-${g.progress}-${g.status}-${g.title}-${g.due_date}`}
                      goal={g}
                      save={saveMyGoalAction}
                      remove={deleteMyGoalAction}
                    />
                  ) : null}
                </div>
              </BentoCard>
            );
          })
        )}
      </BentoGrid>
    </ScreenContainer>
  );
}
