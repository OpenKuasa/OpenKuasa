'use client';

import {
  runCrmAgentNowAction,
  setCrmCadenceAction,
  setCrmCapsAction,
} from '@/app/(app)/crm/agent-actions';
import { ScheduleBox } from '@/components/agents/schedule-box';
import type { CrmAgentsView } from '@/screens/crm/agents-view';

const ACTIONS = { setCadence: setCrmCadenceAction, setCaps: setCrmCapsAction, runNow: runCrmAgentNowAction };

/** Kasturi's schedule and limits (see {@link ScheduleBox}). */
export function AgentSchedule(props: {
  settings: CrmAgentsView['settings'];
  spend: CrmAgentsView['spend'];
  needsSchedule: boolean;
  canManage: boolean;
  canRun: boolean;
  hasKey: boolean;
}) {
  return <ScheduleBox {...props} actions={ACTIONS} idPrefix="crm" />;
}
