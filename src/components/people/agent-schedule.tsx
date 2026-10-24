'use client';

import { runPeopleAgentNowAction, setPeopleCadenceAction, setPeopleCapsAction } from '@/app/(app)/people/agent-actions';
import { ScheduleBox, type ScheduleSettings, type ScheduleSpend } from '@/components/agents/schedule-box';

const ACTIONS = { setCadence: setPeopleCadenceAction, setCaps: setPeopleCapsAction, runNow: runPeopleAgentNowAction };

/** Lekiu's schedule and limits (see {@link ScheduleBox}). */
export function PeopleAgentSchedule(props: {
  settings: ScheduleSettings;
  spend: ScheduleSpend;
  needsSchedule: boolean;
  canManage: boolean;
  canRun: boolean;
  hasKey: boolean;
}) {
  return <ScheduleBox {...props} actions={ACTIONS} idPrefix="people" />;
}
