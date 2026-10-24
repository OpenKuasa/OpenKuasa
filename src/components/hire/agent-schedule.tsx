'use client';

import {
  runHireAgentNowAction,
  setHireCadenceAction,
  setHireCapsAction,
} from '@/app/(app)/hire/agent-actions';
import { ScheduleBox, type ScheduleSettings, type ScheduleSpend } from '@/components/agents/schedule-box';

const ACTIONS = { setCadence: setHireCadenceAction, setCaps: setHireCapsAction, runNow: runHireAgentNowAction };

/** Lekir's schedule and limits (see {@link ScheduleBox}). */
export function HireAgentSchedule(props: {
  settings: ScheduleSettings;
  spend: ScheduleSpend;
  needsSchedule: boolean;
  canManage: boolean;
  canRun: boolean;
  hasKey: boolean;
}) {
  return <ScheduleBox {...props} actions={ACTIONS} idPrefix="hire" />;
}
