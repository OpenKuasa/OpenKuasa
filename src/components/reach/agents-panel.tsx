'use client';

import { useRef, useState, useTransition } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Pause,
  Pencil,
  Play,
  Plus,
  XCircle,
} from 'lucide-react';
import {
  WEEKLY_STUDIO,
  type AgentCadence,
  type AgentConfig,
  type AgentProposal,
  type AgentRun,
  type AgentRunAsset,
  type AgentSchedule,
  type ScheduleStatus,
} from '@/lib/agents/types';
import { PendingApprovals } from '@/components/reach/pending-approvals';
import { RecentlyDecided } from '@/components/reach/recently-decided';
import {
  cancelScheduleAction,
  createScheduleAction,
  pauseScheduleAction,
  resumeScheduleAction,
  setWorkspaceCapsAction,
  updateScheduleAction,
  setAgentCadenceAction,
  setAgentCapAction,
  runAgentNowAction,
  setAgentEnabledAction,
} from '@/app/(app)/reach/actions';
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
import { Switch } from '@/components/ui/switch';

const CADENCE_LABEL: Record<AgentCadence, string> = {
  off: 'Off',
  daily: 'Daily',
  weekly: 'Weekly',
};

const STATUS_LABEL: Record<AgentRun['status'], string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
};

type ActionResult = { ok: boolean; error?: string };

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en-MY', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'Asia/Kuala_Lumpur',
      });
}

function preview(md: string | null): string {
  if (!md) return 'No digest.';
  const text = md.replace(/[#*_`>-]/g, '').replace(/\s+/g, ' ').trim();
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

const MIN_INTERVAL_MINUTES = 5;

const rm = (cents: number) => `RM ${(cents / 100).toFixed(2)}`;

const SCHEDULE_STATUS: Record<ScheduleStatus, { label: string; Icon: typeof Play }> = {
  active: { label: 'Active', Icon: Play },
  paused: { label: 'Paused', Icon: Pause },
  completed: { label: 'Completed', Icon: CheckCircle2 },
};

function intervalLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? '' : 's'}`;
  return `${Math.round(seconds / 60)} min`;
}

function scheduleTitle(s: AgentSchedule): string {
  if (s.nl_text) return s.nl_text;
  return `Every ${intervalLabel(s.interval_seconds)}${s.max_runs ? ` · ${s.max_runs} runs` : ''}`;
}

type ScheduleValues = { minutes: string; maxRuns: string; budgetRm: string };
type ScheduleErrors = Partial<Record<keyof ScheduleValues, string>>;

function validateField(key: keyof ScheduleValues, v: string): string | undefined {
  const t = v.trim();
  if (key === 'minutes') {
    const n = Number(t);
    if (!t || !Number.isInteger(n)) return 'Enter a whole number of minutes.';
    if (n < MIN_INTERVAL_MINUTES) return `Minimum ${MIN_INTERVAL_MINUTES} minutes.`;
    if (n > 525_600) return 'Maximum is one year (525,600 minutes).';
  } else if (key === 'maxRuns') {
    if (!t) return undefined;
    const n = Number(t);
    if (!Number.isInteger(n) || n < 1 || n > 1000) return 'Enter 1 to 1000, or leave blank for no limit.';
  } else if (t) {
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || n > 1000) return 'Enter RM 0 to RM 1000, or leave blank for no limit.';
  }
  return undefined;
}

function ScheduleForm({
  idPrefix,
  initial,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  idPrefix: string;
  initial: ScheduleValues;
  submitLabel: string;
  pending: boolean;
  onSubmit: (v: ScheduleValues) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<ScheduleValues>(initial);
  const [errors, setErrors] = useState<ScheduleErrors>({});

  const set = (key: keyof ScheduleValues) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));
  const blur = (key: keyof ScheduleValues) => () =>
    setErrors((er) => ({ ...er, [key]: validateField(key, values[key]) }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: ScheduleErrors = {};
    (Object.keys(values) as (keyof ScheduleValues)[]).forEach((k) => {
      next[k] = validateField(k, values[k]);
    });
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    onSubmit(values);
  }

  const fields: { key: keyof ScheduleValues; label: string; help: string; step?: number }[] = [
    { key: 'minutes', label: 'Repeat every (minutes)', help: `Minimum ${MIN_INTERVAL_MINUTES} minutes` },
    { key: 'maxRuns', label: 'Stop after (runs)', help: 'Leave blank for no limit' },
    { key: 'budgetRm', label: 'Budget (RM)', help: 'Leave blank for no limit', step: 0.5 },
  ];

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md bg-muted/40 p-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-3">
        {fields.map((f) => (
          <div key={f.key} className="space-y-1">
            <Label htmlFor={`${idPrefix}-${f.key}`}>{f.label}</Label>
            <Input
              id={`${idPrefix}-${f.key}`}
              type="number"
              inputMode="decimal"
              min={0}
              step={f.step ?? 1}
              value={values[f.key]}
              disabled={pending}
              aria-invalid={errors[f.key] ? true : undefined}
              aria-describedby={`${idPrefix}-${f.key}-help`}
              className="tabular-nums"
              onChange={set(f.key)}
              onBlur={blur(f.key)}
            />
            <p
              id={`${idPrefix}-${f.key}-help`}
              role={errors[f.key] ? 'alert' : undefined}
              className={`text-xs ${errors[f.key] ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {errors[f.key] ?? f.help}
            </p>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
          Discard
        </Button>
      </div>
    </form>
  );
}

function toValues(s: AgentSchedule): ScheduleValues {
  return {
    minutes: String(Math.round(s.interval_seconds / 60)),
    maxRuns: s.max_runs == null ? '' : String(s.max_runs),
    budgetRm: s.max_total_cents == null ? '' : String(s.max_total_cents / 100),
  };
}

const parseOpt = (t: string, scale: number): number | null =>
  t.trim() === '' ? null : Math.round(Number(t) * scale);

function ScheduleRow({
  schedule: s,
  canEdit,
  busy,
  run,
}: {
  schedule: AgentSchedule;
  canEdit: boolean;
  busy: boolean;
  run: (p: Promise<ActionResult>, ok: string, done?: () => void) => void;
}) {
  const [editing, setEditing] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { label, Icon } = SCHEDULE_STATUS[s.status];
  const overBudget = s.max_total_cents != null && s.spent_cents >= s.max_total_cents;

  return (
    <li className="space-y-2 p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium">{scheduleTitle(s)}</p>
          <p className="text-xs text-muted-foreground">
            {s.status === 'completed' ? 'No further runs' : `Next run ${formatWhen(s.next_run_at)}`}
          </p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium">
          <Icon className="size-3.5" aria-hidden="true" />
          {label}
        </span>
      </div>

      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground">
        <span>
          Runs {s.runs_used}/{s.max_runs ?? '∞'}
        </span>
        <span className="inline-flex items-center gap-1">
          {overBudget && <AlertTriangle className="size-3.5" aria-hidden="true" />}
          Spent {rm(s.spent_cents)}
          {s.max_total_cents != null ? ` / ${rm(s.max_total_cents)}` : ' (no budget limit)'}
          {overBudget && <span className="font-medium"> · Budget reached</span>}
        </span>
      </p>

      {s.status === 'paused' && s.paused_reason && (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          Paused — {s.paused_reason}
        </p>
      )}

      {canEdit && s.status !== 'completed' && (
        <div className="flex flex-wrap items-center gap-2">
          {s.status === 'paused' ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => run(resumeScheduleAction({ id: s.id }), 'Schedule resumed.')}
            >
              <Play className="size-3.5" aria-hidden="true" /> Resume
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => run(pauseScheduleAction({ id: s.id }), 'Schedule paused.')}
            >
              <Pause className="size-3.5" aria-hidden="true" /> Pause
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-expanded={editing}
            onClick={() => setEditing((e) => !e)}
          >
            <Pencil className="size-3.5" aria-hidden="true" /> Edit
          </Button>
          <span className="ml-auto border-l pl-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              className="text-destructive hover:text-destructive"
              onClick={() => dialogRef.current?.showModal()}
            >
              <XCircle className="size-3.5" aria-hidden="true" /> Cancel
            </Button>
          </span>
        </div>
      )}

      {editing && (
        <ScheduleForm
          idPrefix={`sched-${s.id}`}
          initial={toValues(s)}
          submitLabel="Save changes"
          pending={busy}
          onCancel={() => setEditing(false)}
          onSubmit={(v) =>
            run(
              updateScheduleAction({
                id: s.id,
                interval_seconds: Math.round(Number(v.minutes) * 60),
                max_runs: parseOpt(v.maxRuns, 1),
                max_total_cents: parseOpt(v.budgetRm, 100),
              }),
              'Schedule updated.',
              () => setEditing(false),
            )
          }
        />
      )}

      <dialog
        ref={dialogRef}
        aria-labelledby={`cancel-${s.id}-title`}
        className="m-auto max-w-sm rounded-lg border bg-background p-4 text-foreground backdrop:bg-black/40"
      >
        <h4 id={`cancel-${s.id}-title`} className="font-medium">
          Cancel this schedule?
        </h4>
        <p className="mt-1 text-sm text-muted-foreground">
          It will stop running and be marked completed. This cannot be undone — to run it again,
          create a new schedule.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => dialogRef.current?.close()}>
            Keep schedule
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => {
              dialogRef.current?.close();
              run(cancelScheduleAction({ id: s.id }), 'Schedule cancelled.');
            }}
          >
            Cancel schedule
          </Button>
        </div>
      </dialog>
    </li>
  );
}

function SchedulesSection({
  schedules,
  canEdit,
  dailyCapCents,
  weeklyCapCents,
  spentTodayCents,
  spentWeekCents,
}: {
  schedules: AgentSchedule[];
  canEdit: boolean;
  dailyCapCents: number;
  weeklyCapCents: number;
  spentTodayCents: number;
  spentWeekCents: number;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [dailyRm, setDailyRm] = useState(String(dailyCapCents / 100));
  const [weeklyRm, setWeeklyRm] = useState(String(weeklyCapCents / 100));

  function run(p: Promise<ActionResult>, ok: string, done?: () => void) {
    setNotice(null);
    start(async () => {
      const res = await p;
      if (res.ok) {
        setError(null);
        setNotice(ok);
        done?.();
      } else {
        setError(res.error ?? 'Something went wrong.');
      }
    });
  }

  function commitCaps() {
    const daily = Math.round(Number(dailyRm) * 100);
    const weekly = Math.round(Number(weeklyRm) * 100);
    if (
      dailyRm.trim() === '' ||
      weeklyRm.trim() === '' ||
      ![daily, weekly].every((c) => Number.isFinite(c) && c >= 0 && c <= 1_000_000)
    ) {
      setError('Enter spend caps between RM 0 and RM 10,000.');
      return;
    }
    if (daily === dailyCapCents && weekly === weeklyCapCents) return;
    run(
      setWorkspaceCapsAction({ daily_cap_cents: daily, weekly_cap_cents: weekly }),
      'Spend caps saved.',
    );
  }

  const weekPct = weeklyCapCents > 0 ? Math.min(100, (spentWeekCents / weeklyCapCents) * 100) : 100;
  const weekFull = weeklyCapCents > 0 ? spentWeekCents >= weeklyCapCents : true;
  const dayFull = dailyCapCents > 0 ? spentTodayCents >= dailyCapCents : true;
  const pausedWithReason = schedules.filter((s) => s.status === 'paused' && s.paused_reason);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <CalendarClock className="size-4" aria-hidden="true" /> Schedules
        </h3>
        {canEdit && !adding && schedules.length > 0 && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" aria-hidden="true" /> Add schedule
          </Button>
        )}
      </div>

      <div className="space-y-2 rounded-md border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="font-medium">Weekly spend</span>
          <span className="inline-flex items-center gap-1 tabular-nums text-muted-foreground">
            {weekFull && <AlertTriangle className="size-3.5" aria-hidden="true" />}
            {rm(spentWeekCents)} of {rm(weeklyCapCents)}
            {weekFull && <span className="font-medium"> · Cap reached</span>}
          </span>
        </div>
        <Progress value={weekPct} aria-label="Weekly spend against cap" className="h-2" />
        <p className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
          {dayFull && <AlertTriangle className="size-3.5" aria-hidden="true" />}
          Today {rm(spentTodayCents)} of {rm(dailyCapCents)}
          {dayFull && <span className="font-medium"> · Cap reached</span>}
        </p>
        {canEdit && (
          <div className="grid gap-3 pt-1 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="cap-daily">Daily cap (RM)</Label>
              <Input
                id="cap-daily"
                type="number"
                min={0}
                max={10000}
                step={0.5}
                className="tabular-nums"
                value={dailyRm}
                disabled={pending}
                onChange={(e) => setDailyRm(e.target.value)}
                onBlur={commitCaps}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cap-weekly">Weekly cap (RM)</Label>
              <Input
                id="cap-weekly"
                type="number"
                min={0}
                max={10000}
                step={0.5}
                className="tabular-nums"
                value={weeklyRm}
                disabled={pending}
                onChange={(e) => setWeeklyRm(e.target.value)}
                onBlur={commitCaps}
              />
            </div>
          </div>
        )}
      </div>

      {pausedWithReason.map((s) => (
        <div
          key={s.id}
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 p-3 text-sm"
        >
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            Paused — {s.paused_reason}
          </span>
          {canEdit && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run(resumeScheduleAction({ id: s.id }), 'Schedule resumed.')}
            >
              {pending ? 'Working…' : 'Resume'}
            </Button>
          )}
        </div>
      ))}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}

      {schedules.length === 0 && !adding ? (
        <div className="grid min-h-24 place-items-center gap-2 py-3 text-center text-sm text-muted-foreground">
          <p>No schedules yet — ask Jebat &lsquo;run every Monday 9am&rsquo;, or add one here.</p>
          {canEdit && (
            <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" aria-hidden="true" /> Add schedule
            </Button>
          )}
        </div>
      ) : (
        schedules.length > 0 && (
          <ul className="divide-y rounded-md border">
            {schedules.map((s) => (
              <ScheduleRow key={s.id} schedule={s} canEdit={canEdit} busy={pending} run={run} />
            ))}
          </ul>
        )
      )}

      {canEdit && adding && (
        <ScheduleForm
          idPrefix="sched-new"
          initial={{ minutes: '10080', maxRuns: '', budgetRm: '' }}
          submitLabel="Create schedule"
          pending={pending}
          onCancel={() => setAdding(false)}
          onSubmit={(v) => {
            const maxRuns = parseOpt(v.maxRuns, 1);
            const budget = parseOpt(v.budgetRm, 100);
            run(
              createScheduleAction({
                agent_key: WEEKLY_STUDIO,
                interval_seconds: Math.round(Number(v.minutes) * 60),
                ...(maxRuns != null ? { max_runs: maxRuns } : {}),
                ...(budget != null ? { max_total_cents: budget } : {}),
              }),
              'Schedule created.',
              () => setAdding(false),
            );
          }}
        />
      )}
    </div>
  );
}

export function AgentsPanel({
  config,
  runs,
  assets,
  assetUrls,
  canEdit,
  schedules,
  proposals,
  decided,
  dailyCapCents,
  weeklyCapCents,
  spentTodayCents,
  spentWeekCents,
}: {
  config: AgentConfig;
  runs: AgentRun[];
  assets: AgentRunAsset[];
  /** Signed URL strings keyed by asset id, built server-side. */
  assetUrls: Record<string, string>;
  canEdit: boolean;
  schedules: AgentSchedule[];
  proposals: AgentProposal[];
  decided: AgentProposal[];
  dailyCapCents: number;
  weeklyCapCents: number;
  spentTodayCents: number;
  spentWeekCents: number;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [capRm, setCapRm] = useState(String(config.max_cost_cents / 100));

  function act(p: Promise<ActionResult>) {
    start(async () => {
      const res = await p;
      setError(res.ok ? null : (res.error ?? 'Something went wrong.'));
    });
  }

  function commitCap() {
    const cents = Math.round(Number(capRm) * 100);
    if (!Number.isFinite(cents) || cents < 0 || cents > 10000) {
      setError('Enter a cost cap between RM 0 and RM 100.');
      return;
    }
    if (cents === config.max_cost_cents) return;
    act(setAgentCapAction({ agent_key: WEEKLY_STUDIO, max_cost_cents: cents }));
  }

  const assetCount = (runId: string) => assets.filter((a) => a.run_id === runId).length;

  return (
    <div className="space-y-5">
      {canEdit ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
          <div className="flex items-center gap-3">
            <Switch
              id="agent-enabled"
              checked={config.enabled}
              disabled={pending}
              onCheckedChange={(enabled) =>
                act(setAgentEnabledAction({ agent_key: WEEKLY_STUDIO, enabled }))
              }
            />
            <Label htmlFor="agent-enabled">{config.enabled ? 'Enabled' : 'Disabled'}</Label>
          </div>

          <div className="space-y-1.5">
            <Label>Cadence</Label>
            <Select
              value={config.cadence}
              disabled={pending}
              onValueChange={(cadence) =>
                act(
                  setAgentCadenceAction({
                    agent_key: WEEKLY_STUDIO,
                    cadence: cadence as AgentCadence,
                  }),
                )
              }
            >
              <SelectTrigger className="w-full">
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
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="agent-cap">Cost cap per run (RM)</Label>
            <Input
              id="agent-cap"
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={capRm}
              disabled={pending}
              onChange={(e) => setCapRm(e.target.value)}
              onBlur={commitCap}
            />
          </div>

          <div>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => act(runAgentNowAction({}))}
            >
              {pending ? 'Working…' : 'Run now'}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {config.enabled ? 'Enabled' : 'Disabled'} · {CADENCE_LABEL[config.cadence]} · cap RM{' '}
          {(config.max_cost_cents / 100).toFixed(2)} per run. You need edit access to change these.
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <PendingApprovals proposals={proposals} canEdit={canEdit} />

      <RecentlyDecided decided={decided} />

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Run history</h3>
        {runs.length === 0 ? (
          <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
            No runs yet.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {runs.map((run) => (
              <li key={run.id} className="space-y-1 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{STATUS_LABEL[run.status]}</span>
                  <span className="text-muted-foreground">
                    {formatWhen(run.started_at)} · RM {(run.cost_cents / 100).toFixed(2)} ·{' '}
                    {assetCount(run.id)} asset{assetCount(run.id) === 1 ? '' : 's'}
                  </span>
                </div>
                {run.digest_md ? (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-muted-foreground">
                      {preview(run.digest_md)}
                    </summary>
                    <div className="mt-2 whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-foreground">
                      {run.digest_md}
                    </div>
                  </details>
                ) : (
                  <p className="text-muted-foreground">No digest.</p>
                )}
                {assets.some((a) => a.run_id === run.id) && (
                  <div className="grid gap-2 pt-1 sm:grid-cols-2">
                    {assets
                      .filter((a) => a.run_id === run.id)
                      .map((a) => {
                        const url = a.status === 'done' ? assetUrls[a.id] : undefined;
                        const label =
                          a.kind === 'poster' ? 'Poster' : a.kind === 'video' ? 'Video' : 'Hero image';
                        if (a.kind === 'video' && url) {
                          return (
                            <video
                              key={a.id}
                              src={url}
                              controls
                              preload="metadata"
                              className="w-full rounded-md border"
                            />
                          );
                        }
                        if (a.kind === 'video' && a.status === 'pending') {
                          return (
                            <div
                              key={a.id}
                              className="grid min-h-24 place-items-center rounded-md border border-dashed text-xs text-muted-foreground"
                            >
                              Video rendering…
                            </div>
                          );
                        }
                        return url ? (
                          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                          <img
                            key={a.id}
                            src={url}
                            alt={label}
                            className="w-full rounded-md border object-cover"
                          />
                        ) : (
                          <div
                            key={a.id}
                            className="grid min-h-24 place-items-center rounded-md border border-dashed text-xs text-muted-foreground"
                          >
                            {label} {a.status === 'failed' ? 'could not be generated' : 'is not ready yet'}
                          </div>
                        );
                      })}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <SchedulesSection
        schedules={schedules}
        canEdit={canEdit}
        dailyCapCents={dailyCapCents}
        weeklyCapCents={weeklyCapCents}
        spentTodayCents={spentTodayCents}
        spentWeekCents={spentWeekCents}
      />
    </div>
  );
}
