'use client';

import { type FormEvent, useId, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { FinResult } from '@/lib/finance/result';
import { SST_NUMBER_MAX, type SstBasis, type SstSettings, sstPeriodFor, sstPeriodLabel } from '@/lib/finance/sst';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The twelve two-month pairs a first taxable period can be: 'Jan – Feb' … 'Dec – Jan', by its start month. */
const PAIRS = MONTHS.map((m, i) => ({ month: i + 1, label: `${m} – ${MONTHS[(i + 1) % 12]}` }));

const BASIS_LABELS: Record<SstBasis, string> = {
  payment: 'Payment received',
  invoice: 'Invoice issued (approved by Customs)',
};

const NOT_REGISTERED = 'Not registered';
const NOTHING_SAVED = 'Set your taxable period to see your returns.';

const SELECT_CLASS =
  'h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30';

export type SaveSstSettings = (input: unknown) => Promise<FinResult<null>>;

type Form = { month: number | null; service: string; sales: string; basis: SstBasis };

/**
 * What pressing Save does before anything is sent: the "Saved." note of an earlier save is always dropped, so it
 * never shows beside this attempt's refusal or lost answer; then either the form as it stands is sent, or the
 * month is asked for first.
 */
export function sstSaveStart(form: Form): {
  saved: false;
  failure: string | null;
  payload: { period_start_month: number; service_tax_no: string; sales_tax_no: string; service_tax_basis: SstBasis } | null;
} {
  if (form.month === null) return { saved: false, failure: 'Choose the month the first taxable period starts.', payload: null };
  return {
    saved: false,
    failure: null,
    payload: { period_start_month: form.month, service_tax_no: form.service, sales_tax_no: form.sales, service_tax_basis: form.basis },
  };
}

const formOf = (s: SstSettings | null): Form => ({
  month: s?.period_start_month ?? null,
  service: s?.service_tax_no ?? '',
  sales: s?.sales_tax_no ?? '',
  basis: s?.service_tax_basis ?? 'payment',
});

/**
 * The workspace's SST settings (#222 stage 1): which two-month pair the taxable periods follow, the service and
 * sales tax registration numbers, and whether service tax is counted when payment is received or, with Customs
 * (JKDM) approval, when the invoice is issued. `settings` is null only while nothing has been saved.
 *
 * `save` is given only to an owner or admin outside the demo; without it the card is read only, as text, with no
 * control at all. `suggestedNumber` is the SST no. in the company details: offered to fill a field while both
 * numbers are empty, never saved unless the person saves the form.
 */
export function SstSettingsCard({
  settings,
  suggestedNumber,
  today,
  save,
}: {
  settings: SstSettings | null;
  suggestedNumber: string | null;
  /** YYYY-MM-DD: the day the current period is found for. */
  today: string;
  save?: SaveSstSettings;
}) {
  const suggest = suggestedNumber && !settings?.service_tax_no && !settings?.sales_tax_no ? suggestedNumber : null;
  return (
    <BentoCard
      title="SST settings"
      subtitle="Your taxable periods and registration numbers"
      icon={CalendarClock}
      className="col-span-2 md:col-span-12"
    >
      {save ? (
        <SettingsForm settings={settings} suggest={suggest} today={today} save={save} />
      ) : (
        <SettingsText settings={settings} suggest={suggest} today={today} />
      )}
    </BentoCard>
  );
}

function CurrentPeriod({ month, today }: { month: number; today: string }) {
  return (
    <p className="text-sm">
      <span className="text-muted-foreground">Current period: </span>
      <span className="font-medium">{sstPeriodLabel(sstPeriodFor(today, month))}</span>
    </p>
  );
}

function SettingsText({ settings, suggest, today }: { settings: SstSettings | null; suggest: string | null; today: string }) {
  const rows = [
    { label: 'Periods follow', value: settings ? PAIRS[settings.period_start_month - 1].label : 'Not set' },
    { label: 'Service tax no.', value: settings?.service_tax_no || NOT_REGISTERED },
    { label: 'Sales tax no.', value: settings?.sales_tax_no || NOT_REGISTERED },
    { label: 'Service tax counted on', value: BASIS_LABELS[settings?.service_tax_basis ?? 'payment'] },
  ];
  return (
    <div className="space-y-3">
      {settings ? <CurrentPeriod month={settings.period_start_month} today={today} /> : <p className="text-sm">{NOTHING_SAVED}</p>}
      <dl className="divide-y text-sm">
        {rows.map((r) => (
          <div key={r.label} className="flex gap-3 py-2">
            <dt className="w-32 shrink-0 text-muted-foreground sm:w-48">{r.label}</dt>
            <dd className="min-w-0 flex-1 break-words font-medium">{r.value}</dd>
          </div>
        ))}
      </dl>
      {suggest ? <p className="text-xs text-muted-foreground">Your company details have SST no. {suggest}.</p> : null}
      <p className="text-xs text-muted-foreground">Only an owner or admin can change SST settings.</p>
    </div>
  );
}

function SettingsForm({
  settings,
  suggest,
  today,
  save,
}: {
  settings: SstSettings | null;
  suggest: string | null;
  today: string;
  save: SaveSstSettings;
}) {
  const id = useId();
  const [form, setForm] = useState<Form>(() => formOf(settings));
  const [saved, setSaved] = useState(false);
  const action = useFinanceAction();

  const edit = (patch: Partial<Form>) => {
    setSaved(false);
    action.clear();
    setForm((f) => ({ ...f, ...patch }));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const start = sstSaveStart(form);
    setSaved(start.saved);
    const payload = start.payload;
    if (payload === null) {
      action.fail(start.failure);
      return;
    }
    action.run(() => save(payload), () => setSaved(true));
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {settings && form.month !== null ? <CurrentPeriod month={form.month} today={today} /> : <p className="text-sm">{NOTHING_SAVED}</p>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-month`}>Periods follow</Label>
          <select
            id={`${id}-month`}
            className={SELECT_CLASS}
            value={form.month ?? ''}
            disabled={action.pending}
            onChange={(e) => edit({ month: e.target.value === '' ? null : Number(e.target.value) })}
          >
            {form.month === null ? <option value="">Choose a pair of months</option> : null}
            {PAIRS.map((p) => (
              <option key={p.month} value={p.month}>
                {p.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">The two months of each taxable period, from your Customs (JKDM) registration.</p>
        </div>

        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium leading-none">Service tax counted on</legend>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1.5">
            {(Object.keys(BASIS_LABELS) as SstBasis[]).map((b) => (
              <label key={b} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-basis`}
                  className="size-4 accent-primary"
                  checked={form.basis === b}
                  disabled={action.pending}
                  onChange={() => edit({ basis: b })}
                />
                {BASIS_LABELS[b]}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="space-y-1.5">
          <Label htmlFor={`${id}-service`}>Service tax no.</Label>
          <Input
            id={`${id}-service`}
            value={form.service}
            maxLength={SST_NUMBER_MAX}
            autoComplete="off"
            placeholder={NOT_REGISTERED}
            disabled={action.pending}
            onChange={(e) => edit({ service: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-sales`}>Sales tax no.</Label>
          <Input
            id={`${id}-sales`}
            value={form.sales}
            maxLength={SST_NUMBER_MAX}
            autoComplete="off"
            placeholder={NOT_REGISTERED}
            disabled={action.pending}
            onChange={(e) => edit({ sales: e.target.value })}
          />
        </div>
      </div>

      {suggest ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
          <span className="min-w-0 basis-full sm:basis-auto sm:flex-1">Your company details have SST no. {suggest}.</span>
          <Button type="button" variant="outline" size="sm" disabled={action.pending} onClick={() => edit({ service: suggest })}>
            Use for service tax
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={action.pending} onClick={() => edit({ sales: suggest })}>
            Use for sales tax
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={action.pending}>
          {action.pending ? 'Saving…' : 'Save'}
        </Button>
        {saved ? <span className="text-sm text-muted-foreground">Saved.</span> : null}
        {action.error ? (
          <p role="alert" className="text-sm text-destructive">
            {action.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
