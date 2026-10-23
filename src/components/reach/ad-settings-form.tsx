'use client';

import { useState, useTransition } from 'react';
import { Bell, Wallet, Zap } from 'lucide-react';
import type { AdSettings } from '@/lib/reach/types';
import { updateAdSettingsAction } from '@/app/(app)/reach/actions';
import { BentoCard } from '@/components/bento/bento';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

type ToggleRow = {
  id: string;
  label: string;
  description?: string;
};

const AUTOMATION: ToggleRow[] = [
  {
    id: 'auto_pause_low_ctr',
    label: 'Pause ads below your CTR threshold',
    description: 'Stop underperforming ads automatically to save budget.',
  },
  {
    id: 'auto_boost_winners',
    label: 'Auto-optimise budget to top performers',
    description: 'Shift spend toward the campaigns with the lowest cost per lead.',
  },
  {
    id: 'daily_budget_guard',
    label: 'Stop spend at your daily budget cap',
  },
];

const NOTIFICATIONS: ToggleRow[] = [
  { id: 'spend_alerts', label: 'Alert me on budget overspend' },
  { id: 'weekly_summary', label: 'Email me a weekly performance summary' },
];

const CURRENCIES = [
  { value: 'MYR', label: 'Malaysian Ringgit (RM)' },
  { value: 'SGD', label: 'Singapore Dollar (S$)' },
  { value: 'USD', label: 'US Dollar ($)' },
];

function seedToggles(rows: ToggleRow[], saved: Record<string, boolean> | undefined) {
  return Object.fromEntries(rows.map((r) => [r.id, saved?.[r.id] === true]));
}

function capToInput(cents: number | null | undefined) {
  return cents == null ? '' : (cents / 100).toString();
}

function inputToCap(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

type AdSettingsPatch = Parameters<typeof updateAdSettingsAction>[0];

/** One card's Save: pending, the last error, and whether the last save went through. */
function useCardSave(canEdit: boolean) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  return {
    pending,
    disabled: !canEdit || pending,
    touched: () => setSaved(false),
    submit: (patch: () => AdSettingsPatch) => (e: React.FormEvent) => {
      e.preventDefault();
      if (!canEdit) return;
      setSaved(false);
      start(async () => {
        try {
          const res = await updateAdSettingsAction(patch());
          setError(res.ok ? null : (res.error ?? 'Something went wrong.'));
          setSaved(res.ok);
        } catch {
          setError('Something went wrong. Please try again.');
        }
      });
    },
    footer: canEdit ? (
      <div className="flex flex-wrap items-center gap-3 pt-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : saved && !pending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Saved.
          </p>
        ) : null}
      </div>
    ) : null,
  };
}

function Toggles({
  rows,
  values,
  set,
  disabled,
}: {
  rows: ToggleRow[];
  values: Record<string, boolean>;
  set: (next: Record<string, boolean>) => void;
  disabled: boolean;
}) {
  return rows.map((row) => (
    <div key={row.id} className="flex items-start justify-between gap-4 py-2">
      <div className="space-y-0.5">
        <Label htmlFor={`setting-${row.id}`} className="font-medium">
          {row.label}
        </Label>
        {row.description ? <p className="text-sm text-muted-foreground">{row.description}</p> : null}
      </div>
      <Switch
        id={`setting-${row.id}`}
        checked={values[row.id] ?? false}
        disabled={disabled}
        onCheckedChange={(checked) => set({ ...values, [row.id]: checked })}
      />
    </div>
  ));
}

function BudgetCard({ settings, canEdit }: { settings: AdSettings | null; canEdit: boolean }) {
  const save = useCardSave(canEdit);
  const [daily, setDaily] = useState(capToInput(settings?.daily_cap_cents));
  const [monthly, setMonthly] = useState(capToInput(settings?.monthly_cap_cents));
  const [currency, setCurrency] = useState(settings?.currency ?? 'MYR');
  const currencies = CURRENCIES.some((c) => c.value === currency)
    ? CURRENCIES
    : [...CURRENCIES, { value: currency, label: currency }];

  return (
    <BentoCard
      title="Budget & spend"
      subtitle="Caps apply across all active campaigns"
      icon={Wallet}
      className="col-span-2 md:col-span-6"
    >
      <form
        className="space-y-4"
        onSubmit={save.submit(() => ({
          daily_cap_cents: inputToCap(daily),
          monthly_cap_cents: inputToCap(monthly),
          currency,
        }))}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="daily-cap">Daily budget cap (RM)</Label>
            <Input
              id="daily-cap"
              type="number"
              min="0"
              step="0.01"
              placeholder="No cap"
              value={daily}
              onChange={(e) => {
                save.touched();
                setDaily(e.target.value);
              }}
              disabled={save.disabled}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="monthly-cap">Monthly cap (RM)</Label>
            <Input
              id="monthly-cap"
              type="number"
              min="0"
              step="0.01"
              placeholder="No cap"
              value={monthly}
              onChange={(e) => {
                save.touched();
                setMonthly(e.target.value);
              }}
              disabled={save.disabled}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="currency">Currency</Label>
          <Select
            value={currency}
            onValueChange={(value) => {
              save.touched();
              setCurrency(value);
            }}
            disabled={save.disabled}
          >
            <SelectTrigger id="currency" className="w-full sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {currencies.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {save.footer}
      </form>
    </BentoCard>
  );
}

/** A card of switches with its own Save. The whole set is sent: the stored value is replaced, not merged. */
function TogglesCard({
  title,
  subtitle,
  icon,
  rows,
  saved,
  field,
  canEdit,
  className,
}: {
  title: string;
  subtitle: string;
  icon: typeof Bell;
  rows: ToggleRow[];
  saved: Record<string, boolean> | undefined;
  field: 'automation' | 'notifications';
  canEdit: boolean;
  className: string;
}) {
  const save = useCardSave(canEdit);
  const [values, setValues] = useState(() => seedToggles(rows, saved));
  return (
    <BentoCard title={title} subtitle={subtitle} icon={icon} className={className}>
      <form onSubmit={save.submit(() => ({ [field]: values }))}>
        <Toggles
          rows={rows}
          values={values}
          set={(next) => {
            save.touched();
            setValues(next);
          }}
          disabled={save.disabled}
        />
        {save.footer}
      </form>
    </BentoCard>
  );
}

/** Budget, Automation and Notifications: three cards, each saving only its own part. */
export function AdSettingsForm({ settings, canEdit }: { settings: AdSettings | null; canEdit: boolean }) {
  return (
    <>
      <BudgetCard settings={settings} canEdit={canEdit} />
      <TogglesCard
        title="Automation"
        subtitle="Let Jebat optimise while you sleep"
        icon={Zap}
        rows={AUTOMATION}
        saved={settings?.automation}
        field="automation"
        canEdit={canEdit}
        className="col-span-2 md:col-span-6"
      />
      <TogglesCard
        title="Notifications"
        subtitle="Stay in the loop on spend & performance"
        icon={Bell}
        rows={NOTIFICATIONS}
        saved={settings?.notifications}
        field="notifications"
        canEdit={canEdit}
        className="col-span-2 md:col-span-12"
      />
    </>
  );
}
