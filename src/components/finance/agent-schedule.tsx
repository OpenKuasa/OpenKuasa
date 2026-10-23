'use client';

import {
  runFinanceAgentNowAction,
  setFinanceCadenceAction,
  setFinanceCapsAction,
} from '@/app/(app)/finance/agent-actions';
import { ScheduleBox, type ScheduleSettings, type ScheduleSpend } from '@/components/agents/schedule-box';

const ACTIONS = { setCadence: setFinanceCadenceAction, setCaps: setFinanceCapsAction, runNow: runFinanceAgentNowAction };

/** Bendahara's schedule and limits (see {@link ScheduleBox}). */
export function FinanceAgentSchedule(props: {
  settings: ScheduleSettings;
  spend: ScheduleSpend;
  needsSchedule: boolean;
  canManage: boolean;
  canRun: boolean;
  hasKey: boolean;
}) {
  return <ScheduleBox {...props} actions={ACTIONS} idPrefix="finance" />;
}
