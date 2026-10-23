import type { ReactNode } from 'react';
import Link from 'next/link';
import { Bell, Building2, CalendarDays, Coins, Hash, Landmark, ReceiptText } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard } from '@/components/bento/bento';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { saveFinanceSettingsAction, setSequenceAction } from '@/app/(app)/finance/actions';
import { FinanceYearLockForm, SequenceRowForm } from '@/components/finance/settings-forms';
import { type Company, getCompany } from '@/lib/account/data';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { displayDate } from '@/lib/finance/view-helpers';
import {
  DEFAULT_FINANCE_SETTINGS,
  type FinanceSettings,
  MONTHS,
  SEQUENCE_DOCS,
  type SequenceRow,
  getFinanceSettings,
  listSequences,
} from '@/lib/finance/settings';
import { type SstSettings, getSstSettings } from '@/lib/finance/sst';
import { todayInMalaysia } from '@/lib/people/dates';
import { createClient } from '@/lib/supabase/server';
import { SAMPLE_TODAY } from './sales-sample';

/*
 * Accounting Settings: the company (read-only here), the financial year and books lock, the numbering of every
 * document, and pointers to SST and banking. Everyone in the workspace reads; an owner or admin outside the demo
 * changes the year end, the lock and the numbering. Each card is read on its own, so one failed read says
 * "Couldn't load" in that card and leaves the rest.
 */

const COULD_NOT_LOAD = "Couldn't load";

/** A card's data, or the fact that it could not be read. */
type Part<T> = { ok: true; value: T } | { ok: false };

const SAMPLE_COMPANY: Company = {
  name: 'Rimba Ventures Sdn Bhd',
  registrationNo: '202601012345',
  sstNo: 'W10-2608-32000123',
  tin: 'C1234567890',
  website: '',
  industry: '',
  companySize: '',
  address: 'No. 12, Jalan Ampang',
  city: 'Kuala Lumpur',
  state: 'Wilayah Persekutuan',
  postcode: '50450',
  logoPath: null,
};

const SAMPLE_SST: SstSettings = {
  period_start_month: 9,
  service_tax_no: 'W10-2608-32000123',
  sales_tax_no: null,
  service_tax_basis: 'invoice',
};

const SAMPLE_SEQUENCES: SequenceRow[] = SEQUENCE_DOCS.map((d) => ({
  doc: d.doc,
  label: d.label,
  prefix: d.defaultPrefix,
  nextNumber: d.doc === 'invoice' ? 1043 : 1,
  pad: 4,
}));

/** Third-party features that are not built yet: shown switched off, with a note, never working. */
const COMING_SOON = [
  'MyInvois integration',
  'Auto-submit validated invoices',
  'FPX auto-reconciliation',
  'e-Invois alerts',
  'Overdue reminders',
  'SST due reminders',
];

type Loaded = {
  company: Part<Company>;
  settings: Part<FinanceSettings>;
  sequences: Part<SequenceRow[]>;
  sst: Part<SstSettings | null>;
  today: string;
  /** An owner or admin outside the demo: changes the year end, the lock and the numbering. */
  canEdit: boolean;
  /** The sample screen: the forms are shown but greyed out. */
  sample: boolean;
  canEditCompany: boolean;
};

async function part<T>(read: () => Promise<T>, what: string): Promise<Part<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    console.error(`[finance] the ${what} could not be read:`, error);
    return { ok: false };
  }
}

async function load(): Promise<Loaded> {
  if (!hasSupabaseEnv()) {
    return {
      company: { ok: true, value: SAMPLE_COMPANY },
      settings: { ok: true, value: DEFAULT_FINANCE_SETTINGS },
      sequences: { ok: true, value: SAMPLE_SEQUENCES },
      sst: { ok: true, value: SAMPLE_SST },
      today: SAMPLE_TODAY,
      canEdit: true,
      sample: true,
      canEditCompany: false,
    };
  }
  const viewer = await getViewer();
  const ctx = { client: await createClient(), orgId: viewer.orgId };
  const [company, settings, sequences, sst] = await Promise.all([
    part(() => getCompany(), 'company details'),
    part(() => getFinanceSettings(ctx), 'accounting settings'),
    part(() => listSequences(ctx), 'document numbering'),
    part(() => getSstSettings(ctx), 'SST settings'),
  ]);
  return {
    company,
    settings,
    sequences,
    sst,
    today: todayInMalaysia(new Date()),
    canEdit: !viewer.isDemo && can(viewer.role, 'sign-off-finance'),
    sample: false,
    canEditCompany: !viewer.isDemo && can(viewer.role, 'manage-company'),
  };
}

function Failed() {
  return <p className="text-sm text-muted-foreground">{COULD_NOT_LOAD}</p>;
}

function Facts({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <dl className="divide-y text-sm">
      {rows.map((r) => (
        <div key={r.label} className="flex gap-3 py-2">
          <dt className="w-32 shrink-0 text-muted-foreground sm:w-44">{r.label}</dt>
          <dd className="min-w-0 flex-1 break-words font-medium">{r.value || 'Not set'}</dd>
        </div>
      ))}
    </dl>
  );
}

function CardLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}

const addressOf = (c: Company) =>
  [c.address, [c.postcode, c.city].filter(Boolean).join(' '), c.state].filter((p) => p.trim() !== '').join(', ');

function CompanyCard({ company, canEditCompany }: { company: Part<Company>; canEditCompany: boolean }) {
  return (
    <BentoCard
      title="Company"
      subtitle="Legal details used on invoices and reports"
      icon={Building2}
      className="col-span-2 md:col-span-6"
    >
      {company.ok ? (
        <div className="space-y-3">
          <Facts
            rows={[
              { label: 'Legal name', value: company.value.name },
              { label: 'SSM registration no.', value: company.value.registrationNo },
              { label: 'SST no.', value: company.value.sstNo },
              { label: 'TIN', value: company.value.tin ?? '' },
              { label: 'Address', value: addressOf(company.value) },
            ]}
          />
          {canEditCompany ? <CardLink href="/account/company">Edit company details</CardLink> : null}
        </div>
      ) : (
        <Failed />
      )}
    </BentoCard>
  );
}

function CurrencyCard() {
  return (
    <BentoCard title="Base currency" subtitle="What the books are kept in" icon={Coins} className="col-span-2 md:col-span-6">
      <p className="text-sm font-medium">MYR (Malaysian ringgit)</p>
      <p className="mt-1 text-sm text-muted-foreground">Every report and the ledger are kept in ringgit.</p>
    </BentoCard>
  );
}

function YearLockCard({ data }: { data: Loaded }) {
  const { settings } = data;
  return (
    <BentoCard
      title="Financial year & books lock"
      subtitle="Where each year ends, and the date the books are closed up to"
      icon={CalendarDays}
      className="col-span-2 md:col-span-12"
    >
      {settings.ok ? (
        <div className="space-y-4">
          <p className="text-sm font-medium">
            {settings.value.lockDate ? `Books locked to ${displayDate(settings.value.lockDate)}` : 'Books open'}
          </p>
          <p className="text-xs text-muted-foreground">
            Nothing dated on or before this date can be posted, voided or paid. Move it back to reopen.
          </p>
          {data.canEdit ? (
            <FinanceYearLockForm
              // A saved change remounts the form, so it starts from what was stored.
              key={`${settings.value.yearEndMonth}|${settings.value.lockDate ?? ''}`}
              yearEndMonth={settings.value.yearEndMonth}
              lockDate={settings.value.lockDate}
              today={data.today}
              save={saveFinanceSettingsAction}
              disabled={data.sample}
            />
          ) : (
            <Facts
              rows={[
                { label: 'Financial year ends in', value: MONTHS[settings.value.yearEndMonth - 1] ?? '' },
              ]}
            />
          )}
        </div>
      ) : (
        <Failed />
      )}
    </BentoCard>
  );
}

function NumberingCard({ data }: { data: Loaded }) {
  const { sequences } = data;
  return (
    <BentoCard
      title="Document numbering"
      subtitle="The prefix and the next number of each document you issue"
      icon={Hash}
      className="col-span-2 md:col-span-12"
    >
      {sequences.ok ? (
        <div>
          <div className="hidden grid-cols-4 gap-x-3 border-b pb-2 text-xs font-medium text-muted-foreground sm:grid">
            <span>Document</span>
            <span>Prefix</span>
            <span>Next number</span>
            <span>Example</span>
          </div>
          <div className="divide-y">
            {sequences.value.map((row) => (
              <SequenceRowForm
                key={`${row.doc}|${row.prefix}|${row.nextNumber}`}
                row={row}
                save={data.canEdit ? setSequenceAction : undefined}
                disabled={data.sample}
              />
            ))}
          </div>
          {!data.canEdit ? (
            <p className="pt-2 text-xs text-muted-foreground">Only an owner or admin can change the numbering.</p>
          ) : null}
        </div>
      ) : (
        <Failed />
      )}
    </BentoCard>
  );
}

function SstCard({ sst }: { sst: Part<SstSettings | null> }) {
  return (
    <BentoCard
      title="SST"
      subtitle="Your taxable periods and registration numbers"
      icon={ReceiptText}
      className="col-span-2 md:col-span-6"
    >
      {sst.ok ? (
        <div className="space-y-3">
          {sst.value ? (
            <Facts
              rows={[
                {
                  label: 'Periods start in',
                  value: MONTHS[sst.value.period_start_month - 1] ?? '',
                },
                { label: 'Service tax no.', value: sst.value.service_tax_no ?? 'Not registered' },
                { label: 'Sales tax no.', value: sst.value.sales_tax_no ?? 'Not registered' },
                {
                  label: 'Service tax counted on',
                  value: sst.value.service_tax_basis === 'invoice' ? 'Invoice issued' : 'Payment received',
                },
              ]}
            />
          ) : (
            <p className="text-sm text-muted-foreground">SST settings are not set yet.</p>
          )}
          <CardLink href="/finance/sst-report">Open SST settings</CardLink>
        </div>
      ) : (
        <Failed />
      )}
    </BentoCard>
  );
}

function BankCard() {
  return (
    <BentoCard
      title="Bank accounts"
      subtitle="Where money comes in and goes out"
      icon={Landmark}
      className="col-span-2 md:col-span-6"
    >
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Your bank and cash accounts, and their opening balances, are kept under Banking.</p>
        <CardLink href="/finance/banking">Manage bank accounts</CardLink>
      </div>
    </BentoCard>
  );
}

function ComingSoonCard() {
  return (
    <BentoCard
      title="Integrations & notifications"
      subtitle="Not available yet"
      icon={Bell}
      className="col-span-2 md:col-span-12"
    >
      <div className="divide-y">
        {COMING_SOON.map((label, i) => (
          <div key={label} className="flex items-center justify-between gap-3 py-2">
            <Label htmlFor={`coming-soon-${i}`} className="min-w-0 font-medium">
              {label}
            </Label>
            <div className="flex shrink-0 items-center gap-3">
              <Badge variant="secondary">Coming soon</Badge>
              <Switch id={`coming-soon-${i}`} disabled checked={false} />
            </div>
          </div>
        ))}
      </div>
    </BentoCard>
  );
}

export default async function SettingsScreen() {
  const data = await load();
  return (
    <ScreenContainer>
      <PageHeader
        title="Accounting Settings"
        subtitle="Company, financial year, numbering and tax preferences, Saudara."
      />
      <BentoGrid>
        <CompanyCard company={data.company} canEditCompany={data.canEditCompany} />
        <CurrencyCard />
        <YearLockCard data={data} />
        <NumberingCard data={data} />
        <SstCard sst={data.sst} />
        <BankCard />
        <ComingSoonCard />
      </BentoGrid>
    </ScreenContainer>
  );
}
