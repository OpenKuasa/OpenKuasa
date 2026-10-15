'use client';

import { type FormEvent, useId, useState } from 'react';
import { Archive, ArchiveRestore, BarChart3, Pencil, PieChart, Plus, Search, Trash2, Users } from 'lucide-react';
import { BentoCard, BentoGrid, BentoStat } from '@/components/bento/bento';
import { BarGroup, DonutStat, type Series, type Slice } from '@/components/charts';
import { ConfirmRow } from '@/components/finance/confirm-row';
import { RowMenu } from '@/components/finance/row-menu';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import { NoMatchesRow } from '@/components/screen/table-filter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LiveDot } from '@/components/ui/live-dot';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  CONTACT_LIMIT,
  CONTACT_NAME_MAX,
  type ContactRow,
  type ContactsViewData,
  type FinanceContact,
} from '@/lib/finance/contacts';
import { BASE_CURRENCY, currencyOptions } from '@/lib/finance/currencies';
import { rm, rmShort } from '@/lib/finance/format';
import type { FinResult } from '@/lib/finance/result';
import { cn } from '@/lib/utils';

export type ContactActions = {
  create: (input: unknown) => Promise<FinResult<FinanceContact>>;
  update: (input: unknown) => Promise<FinResult<FinanceContact>>;
  setActive: (input: unknown) => Promise<FinResult<FinanceContact>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
};

const BALANCE_SERIES: Series[] = [{ key: 'balance', label: 'Open balance (RM)', color: 'var(--chart-1)' }];

type Filter = 'active' | 'customers' | 'suppliers' | 'archived';

function matches(row: ContactRow, filter: Filter) {
  if (filter === 'archived') return !row.active;
  if (!row.active) return false;
  if (filter === 'customers') return row.is_customer;
  if (filter === 'suppliers') return row.is_supplier;
  return true;
}

function roleLabel(c: { is_customer: boolean; is_supplier: boolean }) {
  if (c.is_customer && c.is_supplier) return 'Customer & supplier';
  return c.is_customer ? 'Customer' : 'Supplier';
}

export function ContactsView({ view, actions }: { view: ContactsViewData; actions?: ContactActions }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('active');
  // One thing open at a time: the add card, the edit card, or a delete question.
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ContactRow | null>(null);
  const [deleting, setDeleting] = useState<ContactRow | null>(null);
  const rowAction = useFinanceAction();
  const deleteAction = useFinanceAction();

  const q = query.trim().toLowerCase();
  const rows = view.rows.filter(
    (c) =>
      matches(c, filter) &&
      `${c.name} ${c.email ?? ''} ${c.ssm_no ?? ''} ${c.tin ?? ''}`.toLowerCase().includes(q),
  );
  const columns = actions ? 9 : 8;
  const exposure: Slice[] = [
    { key: 'receivable', label: 'Receivable', value: view.stats.receivable, color: 'var(--chart-1)' },
    { key: 'payable', label: 'Payable', value: view.stats.payable, color: 'var(--chart-4)' },
  ];

  const openAdd = () => {
    setEditing(null);
    setDeleting(null);
    setAdding(true);
  };
  const openEdit = (contact: ContactRow) => {
    setAdding(false);
    setDeleting(null);
    setEditing(contact);
  };
  const openDelete = (contact: ContactRow) => {
    setAdding(false);
    setEditing(null);
    deleteAction.clear();
    setDeleting(contact);
  };

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Customers & Suppliers"
        subtitle="Your contacts for billing & procurement, Saudara."
        actions={
          actions ? (
            <Button size="sm" onClick={openAdd} aria-expanded={adding}>
              <Plus className="size-4" />
              Add Contact
            </Button>
          ) : undefined
        }
      />

      <BentoGrid>
        {actions && (adding || editing) ? (
          <ContactFormCard
            // A different contact gets a fresh form.
            key={editing?.id ?? 'new'}
            editing={editing}
            actions={actions}
            onClose={() => {
              setAdding(false);
              setEditing(null);
            }}
          />
        ) : null}

        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat label="Customers" value={String(view.stats.customers)} onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Suppliers" value={String(view.stats.suppliers)} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Receivable" value={rmShort(view.stats.receivable)} delta="from invoices" deltaTone="flat" />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Payable" value={rmShort(view.stats.payable)} delta="open bills" deltaTone="flat" />
        </BentoCard>

        <BentoCard
          title="Largest open balances"
          subtitle="Suppliers you owe · RM"
          icon={BarChart3}
          className="col-span-2 md:col-span-8"
        >
          {view.topBalances.length ? (
            <BarGroup data={view.topBalances} series={BALANCE_SERIES} horizontal height={240} />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">No open balances.</p>
          )}
        </BentoCard>
        <BentoCard
          title="Open exposure"
          subtitle="Receivable vs payable"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          <DonutStat
            data={exposure}
            height={240}
            centerValue={rmShort(view.stats.receivable + view.stats.payable)}
            centerLabel="open"
          />
        </BentoCard>

        <BentoCard
          title="All contacts"
          subtitle="Customers and suppliers in this workspace"
          icon={Users}
          flush
          className="col-span-2 md:col-span-12"
        >
          <div className="flex flex-wrap items-center gap-2 px-4">
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search contacts by name, email, SSM or TIN"
                placeholder="Search contacts…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
              <SelectTrigger className="w-44" aria-label="Show">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">All active</SelectItem>
                <SelectItem value="customers">Customers</SelectItem>
                <SelectItem value="suppliers">Suppliers</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
            {rowAction.error ? (
              <p role="alert" className="text-sm text-destructive">
                {rowAction.error}
              </p>
            ) : null}
          </div>
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>SSM No.</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead className="text-right">Receivable</TableHead>
                  <TableHead className="text-right">Payable</TableHead>
                  <TableHead>Status</TableHead>
                  {actions ? <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 &&
                  (view.rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={columns} className="py-8 text-center text-muted-foreground">
                        No contacts yet.{actions ? ' Add your first customer or supplier.' : ''}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {rows.map((c) =>
                  actions && deleting?.id === c.id ? (
                    <ConfirmRow
                      key={c.id}
                      colSpan={columns}
                      label={`Delete ${c.name}`}
                      confirmLabel="Delete contact"
                      pendingLabel="Deleting…"
                      pending={deleteAction.pending}
                      error={deleteAction.error}
                      onConfirm={() => deleteAction.run(() => actions.remove({ id: c.id }), () => setDeleting(null))}
                      onCancel={() => setDeleting(null)}
                    >
                      Delete <span className="font-medium">{c.name}</span>? This cannot be undone. A contact
                      that is on a bill or other document cannot be deleted; archive it instead.
                    </ConfirmRow>
                  ) : (
                    <TableRow key={c.id} className={cn(!c.active && 'opacity-60')}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                            {c.name.charAt(0).toUpperCase()}
                          </span>
                          <span className="whitespace-nowrap font-medium">{c.name}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="whitespace-nowrap">{roleLabel(c)}</Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{c.email ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                        {c.ssm_no ?? '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">{c.phone ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {c.is_customer ? rm(c.receivable) : '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {c.is_supplier ? rm(c.payable) : '—'}
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <LiveDot active={c.active} />
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                              c.active ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground',
                            )}
                          >
                            {c.active ? 'Active' : 'Archived'}
                          </span>
                        </span>
                      </TableCell>
                      {actions ? (
                        <TableCell>
                          <RowMenu
                            label={c.name}
                            items={[
                              { label: 'Edit', icon: Pencil, opens: true, onSelect: () => openEdit(c) },
                              c.active
                                ? {
                                    label: 'Archive',
                                    icon: Archive,
                                    onSelect: () => rowAction.run(() => actions.setActive({ id: c.id, active: false })),
                                  }
                                : {
                                    label: 'Restore',
                                    icon: ArchiveRestore,
                                    onSelect: () => rowAction.run(() => actions.setActive({ id: c.id, active: true })),
                                  },
                              { label: 'Delete', icon: Trash2, destructive: true, opens: true, onSelect: () => openDelete(c) },
                            ]}
                          />
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ),
                )}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-4 py-3 text-sm text-muted-foreground">
            Showing {rows.length} of {view.rows.length} contacts
            {view.rows.length >= CONTACT_LIMIT ? ` (the first ${CONTACT_LIMIT} by name)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}

/** Radix Select has no empty value: "no default currency" is a word that never leaves the form. */
const NO_CURRENCY = 'none';
const CURRENCY_CHOICES = currencyOptions().filter((code) => code !== BASE_CURRENCY);

function ContactFormCard({
  editing,
  actions,
  onClose,
}: {
  /** The contact being edited; null to add a new one. */
  editing: ContactRow | null;
  actions: ContactActions;
  onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(editing?.name ?? '');
  const [isCustomer, setIsCustomer] = useState(editing?.is_customer ?? true);
  const [isSupplier, setIsSupplier] = useState(editing?.is_supplier ?? false);
  const [email, setEmail] = useState(editing?.email ?? '');
  const [phone, setPhone] = useState(editing?.phone ?? '');
  const [ssm, setSsm] = useState(editing?.ssm_no ?? '');
  const [tin, setTin] = useState(editing?.tin ?? '');
  const [terms, setTerms] = useState(String(editing?.payment_terms_days ?? 30));
  const [currency, setCurrency] = useState(editing?.default_currency ?? NO_CURRENCY);
  const save = useFinanceAction();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    const days = Number(terms);
    if (terms.trim() === '' || !Number.isFinite(days)) {
      save.fail('Payment terms must be between 0 and 365 days.');
      return;
    }
    const fields = {
      name,
      is_customer: isCustomer,
      is_supplier: isSupplier,
      email,
      phone,
      ssm_no: ssm,
      tin,
      payment_terms_days: days,
      default_currency: currency === NO_CURRENCY ? null : currency,
    };
    save.run(
      () => (editing ? actions.update({ id: editing.id, ...fields }) : actions.create(fields)),
      onClose,
    );
  };

  return (
    <BentoCard
      title={editing ? 'Edit contact' : 'Add contact'}
      subtitle={editing ? `Changing ${editing.name}` : 'A customer, a supplier, or both'}
      icon={editing ? Users : Plus}
      className="col-span-2 md:col-span-12"
    >
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className="space-y-1.5 md:col-span-5">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={CONTACT_NAME_MAX}
            placeholder="Lim Hardware Sdn Bhd"
            autoComplete="off"
            autoFocus
            data-finance-focus
            required
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <fieldset className="space-y-1.5 md:col-span-3">
          <legend className="text-sm font-medium leading-none">This contact is a</legend>
          <div className="flex h-9 items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={isCustomer}
                onChange={(e) => setIsCustomer(e.target.checked)}
              />
              Customer
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={isSupplier}
                onChange={(e) => setIsSupplier(e.target.checked)}
              />
              Supplier
            </label>
          </div>
        </fieldset>
        <div className="space-y-1.5 md:col-span-4">
          <Label htmlFor={`${id}-email`}>Email</Label>
          <Input
            id={`${id}-email`}
            type="email"
            value={email}
            placeholder="accounts@example.my"
            autoComplete="off"
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-phone`}>Phone</Label>
          <Input
            id={`${id}-phone`}
            type="tel"
            value={phone}
            placeholder="+60 12-345 6789"
            autoComplete="off"
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-ssm`}>SSM No.</Label>
          <Input id={`${id}-ssm`} value={ssm} placeholder="201901012345" autoComplete="off" onChange={(e) => setSsm(e.target.value)} />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-tin`}>Tax number (TIN)</Label>
          <Input id={`${id}-tin`} value={tin} placeholder="C1234567890" autoComplete="off" onChange={(e) => setTin(e.target.value)} />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-terms`}>Payment terms (days)</Label>
          <Input
            id={`${id}-terms`}
            type="number"
            inputMode="numeric"
            min={0}
            max={365}
            step={1}
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
          />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-currency`}>Default currency</Label>
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger id={`${id}-currency`} className="w-full min-w-28" aria-describedby={`${id}-currency-hint`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_CURRENCY}>None (ringgit)</SelectItem>
              {CURRENCY_CHOICES.map((code) => (
                <SelectItem key={code} value={code}>
                  {code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p id={`${id}-currency-hint`} className="text-xs text-muted-foreground">
            A new quotation for this contact starts in it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" disabled={save.pending}>
            {save.pending ? 'Saving…' : editing ? 'Save changes' : 'Add contact'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={save.pending}>
            Cancel
          </Button>
          {save.error ? (
            <p role="alert" className="text-sm text-destructive">
              {save.error}
            </p>
          ) : null}
        </div>
      </form>
    </BentoCard>
  );
}
