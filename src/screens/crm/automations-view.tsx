'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, FileText, Pencil, Plus, TrendingUp, Trash2, Zap } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import { BarGroup, type Series } from '@/components/charts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  ACTION_LABELS,
  ANY_FORM,
  AUTOMATION_ACTIONS,
  AUTOMATION_DAILY_CAP,
  AUTOMATION_DUE_DAYS_MAX,
  AUTOMATION_NAME_MAX,
  AUTOMATION_STATUSES,
  AUTOMATION_TITLE_MAX,
  AUTOMATION_TRIGGERS,
  STATUS_LABELS,
  TRIGGER_LABELS,
  describeAction,
  describeTrigger,
  type Automation,
  type AutomationAction,
  type AutomationChoice,
  type AutomationRun,
  type AutomationStats,
  type AutomationTrigger,
} from '@/lib/crm/automations';
import { MAX_TAG_LENGTH } from '@/lib/crm/contacts';
import { formatDay } from '@/lib/crm/deal-stats';
import type { CrmFormAction } from '@/lib/crm/form-state';
import { cn } from '@/lib/utils';
import { SELECT_CLASS, useCrmForm } from './crm-form';

type Actions = { save: CrmFormAction; switch: CrmFormAction; remove: CrmFormAction };

const RUN_SERIES: Series[] = [
  { key: 'done', label: 'Ran', color: 'var(--chart-2)' },
  { key: 'failed', label: 'Failed', color: 'var(--chart-4)' },
];

const RUN_PILL: Record<AutomationRun['status'], { label: string; className: string }> = {
  done: { label: 'Done', className: 'bg-emerald-500/15 text-emerald-600' },
  skipped: { label: 'Nothing to do', className: 'bg-muted text-muted-foreground' },
  failed: { label: 'Failed', className: 'bg-red-500/15 text-red-600' },
};

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/** '12 Oct 2026, 3:04 pm' in Malaysia. */
function when(iso: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kuala_Lumpur',
  }).format(new Date(iso));
}

function AutomationFormCard({
  action,
  editing,
  stages,
  forms,
  onSaved,
  onClose,
}: {
  action: CrmFormAction;
  /** The automation being edited; null to add a new one. */
  editing: Automation | null;
  stages: AutomationChoice[];
  forms: AutomationChoice[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const { onSubmit, pending, error } = useCrmForm(action, onSaved);
  // Held here so the form shows only what the chosen trigger and action need,
  // and a rejected save keeps what was typed.
  const [name, setName] = useState(editing?.name ?? '');
  const [trigger, setTrigger] = useState<AutomationTrigger>(editing?.trigger ?? 'contact_created');
  const [stageId, setStageId] = useState(editing?.stageId ?? stages[0]?.id ?? '');
  const [formId, setFormId] = useState(editing?.anyForm ? ANY_FORM : (editing?.formId ?? ANY_FORM));
  const [act, setAct] = useState<AutomationAction>(editing?.action ?? 'add_follow_up');
  const [title, setTitle] = useState(editing?.title ?? '');
  const [dueDays, setDueDays] = useState(editing?.dueDays === null || !editing ? '' : String(editing.dueDays));
  const [tag, setTag] = useState(editing?.tag ?? '');
  const [status, setStatus] = useState<string>(editing?.status ?? 'contacted');
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);

  return (
    <BentoCard
      title={editing ? 'Edit automation' : 'New automation'}
      subtitle={editing ? `Changing ${editing.name}` : 'When something happens in Kasturi, do one thing about it'}
      // The card's icon chip only draws icons from the animated set.
      icon={editing ? FileText : Plus}
      className="col-span-2 md:col-span-12"
    >
      <form onSubmit={onSubmit} className="grid gap-4 md:grid-cols-12">
        {editing ? <input type="hidden" name="automationId" value={editing.id} /> : null}
        <div className="space-y-1.5 md:col-span-12">
          <Label htmlFor="automation-name">Name</Label>
          <Input
            id="automation-name"
            name="name"
            placeholder="Chase quotations"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={AUTOMATION_NAME_MAX}
            autoFocus
            required
          />
        </div>

        <fieldset className="space-y-3 rounded-lg border p-3 md:col-span-6">
          <legend className="px-1 text-sm font-medium">When</legend>
          <div className="space-y-1.5">
            <Label htmlFor="automation-trigger">This happens</Label>
            <select
              id="automation-trigger"
              name="trigger"
              value={trigger}
              onChange={(event) => setTrigger(event.target.value as AutomationTrigger)}
              className={SELECT_CLASS}
            >
              {AUTOMATION_TRIGGERS.map((value) => (
                <option key={value} value={value}>
                  {TRIGGER_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          {trigger === 'deal_stage' ? (
            <div className="space-y-1.5">
              <Label htmlFor="automation-stage">Stage</Label>
              {stages.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This workspace has no pipeline yet.{' '}
                  <Link href="/crm/deals" className="font-medium text-primary underline-offset-4 hover:underline">
                    Open Deals to set one up
                  </Link>
                  .
                </p>
              ) : (
                <select
                  id="automation-stage"
                  name="stageId"
                  value={stageId}
                  onChange={(event) => setStageId(event.target.value)}
                  className={SELECT_CLASS}
                >
                  {/* A stage deleted since the automation was made is no longer offered. */}
                  {stages.some((stage) => stage.id === stageId) ? null : <option value="">Choose a stage</option>}
                  {stages.map((stage) => (
                    <option key={stage.id} value={stage.id}>
                      {stage.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ) : null}
          {trigger === 'form_submitted' ? (
            <div className="space-y-1.5">
              <Label htmlFor="automation-form">Lead form</Label>
              <select
                id="automation-form"
                name="formId"
                value={formId === ANY_FORM || forms.some((form) => form.id === formId) ? formId : ''}
                onChange={(event) => setFormId(event.target.value)}
                className={SELECT_CLASS}
              >
                <option value={ANY_FORM}>Any lead form</option>
                {formId !== ANY_FORM && !forms.some((form) => form.id === formId) ? (
                  <option value="">Choose a lead form</option>
                ) : null}
                {forms.map((form) => (
                  <option key={form.id} value={form.id}>
                    {form.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {trigger === 'contact_created'
              ? 'However the contact is added: by hand, by Kasturi AI, by an import or from a lead form.'
              : trigger === 'form_submitted'
                ? 'Each time someone sends the form, including people who are already a contact.'
                : trigger === 'deal_stage'
                  ? 'When a deal is moved into this stage, or created in it.'
                  : 'The action is taken on the contact the deal belongs to.'}
          </p>
        </fieldset>

        <fieldset className="space-y-3 rounded-lg border p-3 md:col-span-6">
          <legend className="px-1 text-sm font-medium">Then</legend>
          <div className="space-y-1.5">
            <Label htmlFor="automation-action">Do this</Label>
            <select
              id="automation-action"
              name="action"
              value={act}
              onChange={(event) => setAct(event.target.value as AutomationAction)}
              className={SELECT_CLASS}
            >
              {AUTOMATION_ACTIONS.map((value) => (
                <option key={value} value={value}>
                  {ACTION_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          {act === 'add_follow_up' ? (
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px]">
              <div className="space-y-1.5">
                <Label htmlFor="automation-title">Follow-up</Label>
                <Input
                  id="automation-title"
                  name="title"
                  placeholder="Call back about the quotation"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={AUTOMATION_TITLE_MAX}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="automation-due">Due in (days)</Label>
                <Input
                  id="automation-due"
                  name="dueDays"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max={AUTOMATION_DUE_DAYS_MAX}
                  step="1"
                  placeholder="No date"
                  value={dueDays}
                  onChange={(event) => setDueDays(event.target.value)}
                />
              </div>
            </div>
          ) : null}
          {act === 'add_tag' ? (
            <div className="space-y-1.5">
              <Label htmlFor="automation-tag">Tag</Label>
              <Input
                id="automation-tag"
                name="tag"
                placeholder="vip"
                value={tag}
                onChange={(event) => setTag(event.target.value)}
                maxLength={MAX_TAG_LENGTH}
                required
              />
            </div>
          ) : null}
          {act === 'set_status' ? (
            <div className="space-y-1.5">
              <Label htmlFor="automation-status">Status</Label>
              <select
                id="automation-status"
                name="status"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
                className={SELECT_CLASS}
              >
                {AUTOMATION_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {act === 'add_follow_up'
              ? 'It appears on the contact and on the calendar. Nobody is sent a message.'
              : act === 'add_tag'
                ? 'Nothing happens if the contact already has the tag.'
                : 'An archived contact is left as it is.'}
          </p>
        </fieldset>

        {editing ? (
          <div className="md:col-span-12">
            {/* Says the checkbox was shown, so leaving it unticked means "off". */}
            <input type="hidden" name="enabledField" value="1" />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="enabled"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
                className="size-4 accent-primary"
              />
              Switched on
            </label>
          </div>
        ) : null}

        <div className="flex flex-wrap items-end gap-3 md:col-span-12">
          <Button type="submit" className="w-full md:w-auto" disabled={pending}>
            {editing ? <Check className="size-4" /> : <Plus className="size-4" />}
            {pending ? 'Saving…' : editing ? 'Save changes' : 'Save automation'}
          </Button>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            {editing ? 'Cancel' : 'Close'}
          </Button>
          {error ? (
            <p role="alert" className="pb-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </form>
    </BentoCard>
  );
}

function DeleteAutomationRow({
  automation,
  action,
  colSpan,
  onClose,
}: {
  automation: Automation;
  action: CrmFormAction;
  colSpan: number;
  onClose: () => void;
}) {
  const { formAction, pending, error } = useCrmForm(action, onClose);
  return (
    <TableRow className="bg-destructive/5 hover:bg-destructive/5">
      {/* Table cells do not wrap by default; a question this long has to. */}
      <TableCell colSpan={colSpan} className="whitespace-normal">
        <form action={formAction} className="flex flex-wrap items-center gap-3 py-1">
          <input type="hidden" name="automationId" value={automation.id} />
          <p className="min-w-0 flex-1 text-sm">
            Delete <span className="font-medium">{automation.name}</span>? It stops running and its record of
            runs is lost. What it already did (follow-ups, tags, statuses) stays. This cannot be undone.
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="destructive" size="sm" disabled={pending}>
            <Trash2 className="size-4" />
            {pending ? 'Deleting…' : 'Delete automation'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
        </form>
      </TableCell>
    </TableRow>
  );
}

/** The on/off switch in a row. For people who cannot edit, it only shows the state. */
function EnabledSwitch({ automation, action }: { automation: Automation; action?: CrmFormAction }) {
  const pill = (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
        automation.enabled ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground',
      )}
    >
      {automation.enabled ? 'On' : 'Off'}
    </span>
  );
  if (!action) return pill;
  return <SwitchForm automation={automation} action={action} />;
}

function SwitchForm({ automation, action }: { automation: Automation; action: CrmFormAction }) {
  const { formAction, pending, error } = useCrmForm(action);
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="automationId" value={automation.id} />
      {/* The state it is being switched to. */}
      {automation.enabled ? null : <input type="hidden" name="enabled" value="on" />}
      <button
        type="submit"
        role="switch"
        aria-checked={automation.enabled}
        aria-label={`${automation.name} is ${automation.enabled ? 'on' : 'off'}`}
        disabled={pending}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
          automation.enabled ? 'bg-primary' : 'bg-muted-foreground/30',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-4 rounded-full bg-background shadow transition-[left]',
            automation.enabled ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </button>
      <span className="text-xs text-muted-foreground">{automation.enabled ? 'On' : 'Off'}</span>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </form>
  );
}

/** Kasturi's automations, with the form to add and edit them. */
export function AutomationsView({
  automations,
  stages,
  forms,
  recent,
  stats,
  runsComplete,
  actions,
}: {
  automations: Automation[];
  stages: AutomationChoice[];
  forms: AutomationChoice[];
  recent: AutomationRun[];
  stats: AutomationStats;
  /** False when there were more runs than the figures and the chart were worked out over. */
  runsComplete: boolean;
  /** Present only when the signed-in person may change automations. */
  actions?: Actions;
}) {
  // One thing is open at a time: the form, or a delete question.
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const columns = 5 + (actions ? 1 : 0);
  const closeForm = () => {
    setAdding(false);
    setEditing(null);
  };

  return (
    <ScreenContainer>
      <PageHeader
        title="Automations"
        subtitle="When something happens in Kasturi, do one thing about it, without anyone having to remember."
        actions={
          actions ? (
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setDeletingId(null);
                setAdding(true);
              }}
            >
              <Plus className="size-4" />
              New automation
            </Button>
          ) : null
        }
      />

      <BentoGrid>
        {actions && (adding || editing) ? (
          <AutomationFormCard
            // A fresh form for each automation, and for adding.
            key={editing?.id ?? 'new'}
            action={actions.save}
            editing={editing}
            stages={stages}
            forms={forms}
            onSaved={closeForm}
            onClose={closeForm}
          />
        ) : null}

        <BentoCard tone="primary" className="col-span-1 md:col-span-4">
          <BentoStat
            label="Automations"
            value={String(stats.total)}
            delta={`${stats.active} switched on`}
            onPrimary
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-4">
          <BentoStat label="Runs this month" value={stats.runsThisMonth.toLocaleString('en-MY')} />
        </BentoCard>
        <BentoCard className="col-span-2 md:col-span-4">
          <BentoStat
            label="Ran without failing"
            value={stats.successRate === null ? '—' : `${stats.successRate}%`}
          />
        </BentoCard>

        <BentoCard
          title="Automations"
          subtitle={automations.length === 0 ? 'None yet' : 'Newest first'}
          icon={Zap}
          className="col-span-2 md:col-span-12"
        >
          {automations.length === 0 ? (
            <Muted>
              {actions
                ? 'No automations yet. Choose "New automation" to make your first.'
                : 'No automations yet.'}
            </Muted>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Name</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead>Then</TableHead>
                    <TableHead className="text-right">Runs</TableHead>
                    <TableHead>Switch</TableHead>
                    {/* Pinned to the right edge, so the buttons stay in reach when the table is wider than its card. */}
                    {actions ? (
                      <TableHead className="sticky right-0 bg-muted text-right shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.2)]">
                        Actions
                      </TableHead>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {automations.map((automation) => {
                    if (actions && deletingId === automation.id) {
                      return (
                        <DeleteAutomationRow
                          key={automation.id}
                          automation={automation}
                          action={actions.remove}
                          colSpan={columns}
                          onClose={() => setDeletingId(null)}
                        />
                      );
                    }
                    const trigger = describeTrigger(automation, stages, forms);
                    return (
                      <TableRow key={automation.id}>
                        <TableCell className="max-w-56 whitespace-normal">
                          <p className="font-medium">{automation.name}</p>
                          {automation.pausedReason ? (
                            <p className="text-xs text-amber-600">{automation.pausedReason}</p>
                          ) : null}
                        </TableCell>
                        <TableCell className="max-w-56 whitespace-normal">
                          {trigger.text}
                          {trigger.broken ? (
                            <p className="text-xs text-amber-600">It cannot run until you choose another.</p>
                          ) : null}
                        </TableCell>
                        <TableCell className="max-w-64 whitespace-normal">{describeAction(automation)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {automation.runs.toLocaleString('en-MY')}
                          <p className="text-xs text-muted-foreground">
                            {automation.lastRunDay ? `Last ${formatDay(automation.lastRunDay)}` : 'Never run'}
                          </p>
                        </TableCell>
                        <TableCell>
                          <EnabledSwitch automation={automation} action={actions?.switch} />
                        </TableCell>
                        {actions ? (
                          <TableCell className="sticky right-0 bg-card shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.2)]">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Edit ${automation.name}`}
                                onClick={() => {
                                  setAdding(false);
                                  setDeletingId(null);
                                  setEditing(automation);
                                }}
                              >
                                <Pencil className="size-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Delete ${automation.name}`}
                                onClick={() => {
                                  closeForm();
                                  setDeletingId(automation.id);
                                }}
                              >
                                <Trash2 className="size-4 text-destructive" />
                              </Button>
                            </div>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            An automation that runs {AUTOMATION_DAILY_CAP.toLocaleString('en-MY')} times in one day switches itself
            off. When a public form is sent by someone who is already a contact, an automation may add a
            follow-up but will not change their tags or status.
          </p>
        </BentoCard>

        <BentoCard
          title="Runs over time"
          subtitle={`Last ${stats.trend.length} weeks${runsComplete ? '' : ' (the most recent runs only)'}`}
          icon={TrendingUp}
          className="col-span-2 md:col-span-7"
        >
          {stats.trend.some((week) => week.runs > 0) ? (
            <BarGroup
              data={stats.trend.map((week) => ({
                label: week.label,
                done: week.runs - week.failed,
                failed: week.failed,
              }))}
              series={RUN_SERIES}
              stacked
              showLegend
              height={220}
            />
          ) : (
            <Muted>No automation has run in the last {stats.trend.length} weeks</Muted>
          )}
        </BentoCard>

        {/* The card's icon chip only draws icons from the animated set. */}
        <BentoCard title="Latest runs" subtitle="Newest first" icon={FileText} className="col-span-2 md:col-span-5">
          {recent.length === 0 ? (
            <Muted>Nothing has run yet</Muted>
          ) : (
            <ul className="divide-y">
              {recent.map((run) => (
                <li key={run.id} className="flex items-start gap-3 py-2">
                  <span
                    className={cn(
                      'mt-0.5 inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold',
                      RUN_PILL[run.status].className,
                    )}
                  >
                    {RUN_PILL[run.status].label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{run.automationName}</p>
                    <p className="text-xs text-muted-foreground">
                      {run.contactName ?? 'A contact since deleted'} · {when(run.at)}
                    </p>
                    {run.detail ? <p className="text-xs text-muted-foreground">{run.detail}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
