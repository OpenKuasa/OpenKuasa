'use client';

import { useState, useTransition } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AgentCadence } from '@/lib/agents/types';
import { rm } from '@/lib/reach/format';

const CADENCE_LABEL: Record<AgentCadence, string> = { off: 'Off', daily: 'Daily', weekly: 'Weekly' };
const NEEDS_SCHEDULE = 'Pick daily or weekly so the agent runs on its own, or press Run now.';
const CADENCE_HINT = 'Daily runs at 7:00 am; weekly on Monday 7:00 am (Kuala Lumpur time)';

type ActionResult = { ok: boolean; error?: string };

/** The agent's schedule and limits as the screen read them. */
export type ScheduleSettings = { cadence: AgentCadence; maxCostCents: number; dailyCapCents: number; weeklyCapCents: number };
/** What the agent spent today and this week; null when it could not be read. */
export type ScheduleSpend = { todayCents: number | null; weekCents: number | null };

/** The product's own server actions behind the schedule, the limits and Run now. */
export type ScheduleActions = {
  setCadence: (cadence: unknown) => Promise<ActionResult>;
  setCaps: (input: unknown) => Promise<ActionResult>;
  runNow: () => Promise<ActionResult>;
};

/** RM text to whole cents, or null when it is not a number in range. */
function toCents(value: string, maxCents: number): number | null {
  if (value.trim() === '') return null;
  const cents = Math.round(Number(value) * 100);
  return Number.isFinite(cents) && cents >= 0 && cents <= maxCents ? cents : null;
}

function SpendLine({ label, spent, cap }: { label: string; spent: number | null; cap: number }) {
  if (spent === null) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">Couldn&rsquo;t read spend</span>
      </div>
    );
  }
  const full = cap > 0 ? spent >= cap : true;
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 100;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium">{label}</span>
        <span className="inline-flex items-center gap-1 tabular-nums text-muted-foreground">
          {full && <AlertTriangle className="size-3.5" aria-hidden="true" />}
          {rm(spent)} of {rm(cap)}
          {full && <span className="font-medium"> · Cap reached</span>}
        </span>
      </div>
      <Progress value={pct} aria-label={`${label} spend against cap`} className="h-2" />
    </div>
  );
}

/**
 * When the agent runs and what it may spend. Owners and admins change these; anyone who
 * edits data may press Run now, which obeys every cap.
 */
export function ScheduleBox({
  settings,
  spend,
  needsSchedule,
  canManage,
  canRun,
  hasKey,
  actions,
  idPrefix,
}: {
  settings: ScheduleSettings;
  spend: ScheduleSpend;
  needsSchedule: boolean;
  canManage: boolean;
  canRun: boolean;
  hasKey: boolean;
  actions: ScheduleActions;
  /** Prefix of the limit inputs' ids, so two products' boxes never share one. */
  idPrefix: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [perRun, setPerRun] = useState(String(settings.maxCostCents / 100));
  const [daily, setDaily] = useState(String(settings.dailyCapCents / 100));
  const [weekly, setWeekly] = useState(String(settings.weeklyCapCents / 100));

  function act(p: () => Promise<ActionResult>, ok: string) {
    setError(null);
    setNotice(null);
    start(async () => {
      try {
        const res = await p();
        if (res.ok) setNotice(ok);
        else setError(res.error ?? 'Something went wrong.');
      } catch {
        setError('Something went wrong.');
      }
    });
  }

  function saveLimits() {
    const max = toCents(perRun, 10_000);
    const day = toCents(daily, 1_000_000);
    const week = toCents(weekly, 1_000_000);
    if (max === null) {
      setError('Enter a per-run limit between RM 0 and RM 100.');
      return;
    }
    if (day === null || week === null) {
      setError('Enter daily and weekly limits between RM 0 and RM 10,000.');
      return;
    }
    act(
      () => actions.setCaps({ max_cost_cents: max, daily_cap_cents: day, weekly_cap_cents: week }),
      'Limits saved.',
    );
  }

  const limits = [
    { id: `${idPrefix}-cap-run`, label: 'Per run (RM)', value: perRun, set: setPerRun, max: 100 },
    { id: `${idPrefix}-cap-day`, label: 'Per day (RM)', value: daily, set: setDaily, max: 10000 },
    { id: `${idPrefix}-cap-week`, label: 'Per week (RM)', value: weekly, set: setWeekly, max: 10000 },
  ];

  return (
    <div className="space-y-4">
      {needsSchedule && <p className="text-sm font-medium">{NEEDS_SCHEDULE}</p>}
      {canManage ? (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>How often</Label>
            <Select
              value={settings.cadence}
              disabled={pending}
              onValueChange={(cadence) => act(() => actions.setCadence(cadence), 'Schedule saved.')}
            >
              <SelectTrigger className="w-full sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(CADENCE_LABEL) as AgentCadence[]).map((c) => (
                  <SelectItem key={c} value={c}>
                    {CADENCE_LABEL[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{CADENCE_HINT}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {limits.map((l) => (
              <div key={l.id} className="space-y-1">
                <Label htmlFor={l.id}>{l.label}</Label>
                <Input
                  id={l.id}
                  type="number"
                  min={0}
                  max={l.max}
                  step={0.01}
                  className="tabular-nums"
                  value={l.value}
                  disabled={pending}
                  onChange={(e) => l.set(e.target.value)}
                />
              </div>
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={saveLimits}>
            Save limits
          </Button>
        </div>
      ) : (
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>
            {CADENCE_LABEL[settings.cadence]} · up to {rm(settings.maxCostCents)} per run,{' '}
            {rm(settings.dailyCapCents)} per day and {rm(settings.weeklyCapCents)} per week.
          </p>
          <p className="text-xs">{CADENCE_HINT}. Only an owner or admin can change these.</p>
        </div>
      )}

      <div className="space-y-2 rounded-md border p-3">
        <SpendLine label="Today" spent={spend.todayCents} cap={settings.dailyCapCents} />
        <SpendLine label="This week" spent={spend.weekCents} cap={settings.weeklyCapCents} />
      </div>

      {canRun && (
        <Button
          type="button"
          disabled={pending || !hasKey}
          onClick={() => act(actions.runNow, 'Run finished. Any suggestions are waiting above.')}
        >
          {pending ? 'Working…' : 'Run now'}
        </Button>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && !error && <p className="text-sm text-muted-foreground">{notice}</p>}
    </div>
  );
}
