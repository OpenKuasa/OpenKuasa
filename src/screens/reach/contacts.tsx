'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { BarChart3, PieChart, Plus, Target, TrendingUp, Users } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import {
  AreaTrend,
  BarGroup,
  DonutStat,
  RadialGauge,
  Sparkline,
  type Series,
  type Slice,
} from '@/components/charts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  DEFAULT_FILTERS,
  filterContacts,
  filterOptions,
  type ContactFilters,
} from '@/lib/crm/contact-filters';
import type { CrmContact } from '@/lib/crm/contacts';
import type { CrmFollowUp } from '@/lib/crm/follow-ups';
import type { CrmContactActions } from '@/lib/crm/form-state';
import type { BillingCustomerChoice } from '@/lib/crm/invoice-links';
import { useHiddenColumns } from '@/screens/crm/contact-columns';
import { ContactImportCard } from '@/screens/crm/contact-import';
import {
  ContactFollowUps,
  ContactFormCard,
  ContactRowMenu,
  ContactTags,
  DeleteContactRow,
} from '@/screens/crm/contact-parts';
import {
  AddContactMenu,
  ColumnsMenu,
  ContactFilterPanel,
  ContactsToolbar,
} from '@/screens/crm/contact-toolbar';

/* ---- mock data (Rimba Ventures Sdn Bhd) --------------------------- */

type Contact = CrmContact;

/** Total contacts in the book; the table below shows a recent sample. */
const TOTAL_CONTACTS = 1284;

const CONTACTS: Contact[] = [
  {
    id: '1',
    email: 'aisyah.rahim@rimbaventures.com',
    company: 'Rimba Ventures Sdn Bhd',
    first: 'Aisyah',
    last: 'Rahim',
    phone: '+60123456789',
    country: 'MY',
    status: 'Qualified',
    score: 92,
    pic: 'Faiz',
    lastInteraction: '2h ago',
  },
  {
    id: '2',
    email: 'faiz.hakim@gmail.com',
    company: 'Personal',
    first: 'Faiz',
    last: 'Hakim',
    phone: '+60123456782',
    country: 'MY',
    status: 'Contacted',
    score: 78,
    pic: 'Aisyah',
    lastInteraction: 'Yesterday',
  },
  {
    id: '3',
    email: 'nurul.huda@mesramart.my',
    company: 'Mesra Mart Enterprise',
    first: 'Nurul',
    last: 'Huda',
    phone: '+60123456783',
    country: 'MY',
    status: 'New Leads',
    score: 64,
    pic: 'Aisyah',
    lastInteraction: '3 days ago',
  },
  {
    id: '4',
    email: 'ahmad.zaki@tanibumi.my',
    company: 'Tani Bumi Sdn Bhd',
    first: 'Ahmad',
    last: 'Zaki',
    phone: '+60123456781',
    country: 'MY',
    status: 'Qualified',
    score: 85,
    pic: 'Faiz',
    lastInteraction: '5h ago',
  },
  {
    id: '5',
    email: 'sarah.tan@worksphere.my',
    company: 'WorkSphere',
    first: 'Sarah',
    last: 'Tan',
    phone: '+60123456784',
    country: 'MY',
    status: 'Contacted',
    score: 45,
    pic: 'Nurul',
    lastInteraction: '1 week ago',
  },
  {
    id: '6',
    email: 'wan.azlan@gmail.com',
    company: 'Personal',
    first: 'Wan',
    last: 'Azlan',
    phone: '+60123456785',
    country: 'MY',
    status: 'New Leads',
    score: 33,
    pic: 'Nurul',
    lastInteraction: 'Yesterday',
  },
  {
    id: '7',
    email: 'weijie.lim@kedairuncit.my',
    company: 'Kedai Runcit Online',
    first: 'Lim',
    last: 'Wei Jie',
    phone: '+60123456786',
    country: 'MY',
    status: 'Customer',
    score: 58,
    pic: 'Zaki',
    lastInteraction: '2 weeks ago',
  },
  {
    id: '8',
    email: 'siti.khadijah@outlook.com',
    company: 'Personal',
    first: 'Siti',
    last: 'Khadijah',
    phone: '+60123456787',
    country: 'MY',
    status: null,
    score: 18,
    pic: null,
    lastInteraction: null,
  },
];

/* KPI sparkline trends ------------------------------------------------ */
const SPARK_TOTAL = [1060, 1104, 1138, 1172, 1201, 1238, 1262, 1284];
const SPARK_NEW = [52, 61, 58, 73, 69, 81, 78, 86];
const SPARK_QUALIFIED = [318, 332, 347, 358, 371, 384, 393, 402];
const SPARK_SCORE = [61, 63, 62, 65, 66, 67, 67, 68];

/* Contacts added over time (last 8 weeks) ----------------------------- */
const ADDED_TREND = [
  { label: 'Wk1', added: 52, qualified: 22 },
  { label: 'Wk2', added: 61, qualified: 28 },
  { label: 'Wk3', added: 58, qualified: 26 },
  { label: 'Wk4', added: 73, qualified: 33 },
  { label: 'Wk5', added: 69, qualified: 31 },
  { label: 'Wk6', added: 81, qualified: 36 },
  { label: 'Wk7', added: 78, qualified: 34 },
  { label: 'Wk8', added: 86, qualified: 38 },
];
const ADDED_SERIES: Series[] = [
  { key: 'added', label: 'Added', color: 'var(--chart-1)' },
  { key: 'qualified', label: 'Qualified', color: 'var(--chart-2)' },
];

/* Lead score distribution — matches the LeadScore badge thresholds ---- */
const SCORE_MIX: Slice[] = [
  { key: 'hot', label: 'Hot (75+)', value: 386, color: 'var(--chart-1)' },
  { key: 'warm', label: 'Warm (40–74)', value: 592, color: 'var(--chart-3)' },
  { key: 'cold', label: 'Cold (<40)', value: 306, color: 'var(--chart-4)' },
];

/* Pipeline by status -------------------------------------------------- */
const STATUS_MIX = [
  { label: 'New', count: 431 },
  { label: 'Contacted', count: 358 },
  { label: 'Qualified', count: 402 },
  { label: 'Customer', count: 93 },
];
const STATUS_SERIES: Series[] = [
  { key: 'count', label: 'Contacts', color: 'var(--chart-2)' },
];

/* ------------------------------------------------------------------ */

function LeadScore({ value }: { value: number }) {
  const tone =
    value >= 75
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : value >= 40
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
        : 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400';
  return (
    <span
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-full border text-xs font-bold',
        tone,
      )}
      title={`Lead score ${value}`}
    >
      {value}
    </span>
  );
}

function StatusPill({ status }: { status: string | null }) {
  if (!status)
    return <span className="text-sm text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
      {status}
    </span>
  );
}

/** `?contact=<id>` on the Contacts URL opens the page on that one contact. */
export const CONTACT_PARAM = 'contact';

/** Rows put on screen at a time; "Show more" adds another lot. */
const PAGE_SIZE = 50;

type ContactsScreenProps = {
  /** Live contacts. Omitted on Jebat and when no database is configured. */
  contacts?: Contact[];
  totalContacts?: number;
  /** Open follow-ups by contact id. */
  followUps?: Record<string, CrmFollowUp[]>;
  /** Present only when the signed-in person may change contacts. */
  actions?: CrmContactActions;
  /** Bendahara's customers, for the form's "Billing customer" picker. Kasturi only. */
  billingCustomers?: BillingCustomerChoice[];
  /** `?open=<id>`: the contact whose card opens on load, when it is not among `contacts`. Kasturi only. */
  openContact?: Contact | null;
  /** `?open=<id>`, when it is a valid id. */
  openId?: string | null;
};

export default function ContactsScreen({
  contacts,
  totalContacts,
  followUps,
  actions,
  billingCustomers,
  openContact = null,
  openId = null,
}: ContactsScreenProps = {}) {
  // With live contacts, only what is backed by real data is shown: the total
  // and the table. The trend, score and pipeline cards are sample figures and
  // stay hidden until they have a live source.
  const live = contacts !== undefined;
  const rows = contacts ?? CONTACTS;
  const total = totalContacts ?? TOTAL_CONTACTS;
  const [selected, setSelected] = useState<string[]>([]);
  // One thing is open at a time: the edit card, a delete question, or a
  // follow-up form.
  // A link such as /crm/contacts?open=<id> opens that contact's card. An id that is not a contact of this workspace opens nothing.
  const [editing, setEditing] = useState<Contact | null>(
    actions && openId ? (rows.find((c) => c.id === openId) ?? openContact) : null,
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [followUpFor, setFollowUpFor] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // The add form stays out of the way until Add Contact asks for it.
  const [adding, setAdding] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // Filtering, search and the view all work on the contacts already loaded.
  const [filters, setFilterState] = useState<ContactFilters>(DEFAULT_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const { hidden, toggle: toggleColumn } = useHiddenColumns();
  const setFilters = (next: ContactFilters) => {
    setFilterState(next);
    setPageSize(PAGE_SIZE);
  };

  const options = useMemo(() => filterOptions(rows), [rows]);
  const filtered = useMemo(
    () => filterContacts(rows, followUps ?? {}, filters),
    [rows, followUps, filters],
  );
  // A link such as /crm/contacts?contact=<id> opens on that one contact,
  // whatever the view and filters are, so it works for an archived contact too.
  const pathname = usePathname();
  // Once read, the link's contact leaves the address, so a reload does not reopen the card.
  useEffect(() => {
    if (!openId || !pathname) return;
    const params = new URLSearchParams(window.location.search);
    params.delete('open');
    const rest = params.toString();
    window.history.replaceState(null, '', rest ? `${pathname}?${rest}` : pathname);
  }, [openId, pathname]);
  const openedId = useSearchParams().get(CONTACT_PARAM);
  const opened = openedId ? (rows.find((c) => c.id === openedId) ?? null) : null;
  const shown = openedId ? (opened ? [opened] : []) : filtered.slice(0, pageSize);
  // Fewer contacts than were loaded means a view, filter or search is narrowing the list.
  const narrowed = !openedId && filtered.length < rows.length;
  // Checkbox and Contact always show; the "⋯" column only for people who can edit.
  const columns = 2 + (7 - hidden.size) + (actions ? 1 : 0);

  // A menu holds on to focus until it has closed, so the form is focused then.
  const focusFormOnClose = useRef(false);
  const menuClosed = () => {
    if (!focusFormOnClose.current) return;
    focusFormOnClose.current = false;
    firstFieldRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    firstFieldRef.current?.focus({ preventScroll: true });
  };
  const startAdd = () => {
    setAdding(true);
    setEditing(null);
    setDeletingId(null);
    setImporting(false);
    focusFormOnClose.current = true;
  };
  const closeForm = () => {
    setAdding(false);
    setEditing(null);
  };
  const startEdit = (contact: Contact) => {
    setEditing(contact);
    setDeletingId(null);
    setFollowUpFor(null);
    setImporting(false);
    focusFormOnClose.current = true;
  };
  // Ticks only count for contacts that are on screen.
  const shownIds = new Set(shown.map((c) => c.id));
  const selectedShown = selected.filter((id) => shownIds.has(id));
  const allChecked = shown.length > 0 && selectedShown.length === shown.length;

  const toggleAll = () => setSelected(allChecked ? [] : shown.map((c) => c.id));
  const toggle = (id: string) =>
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : [...s, id],
    );

  return (
    <ScreenContainer>
      <PageHeader
        className="mb-3"
        title="Contacts"
        subtitle="All your leads and customers in one place."
        actions={
          <>
            <ColumnsMenu hidden={hidden} onToggle={toggleColumn} />
            {actions ? (
              <AddContactMenu
                onAddOne={startAdd}
                onClosed={menuClosed}
                onImport={() => {
                  closeForm();
                  setImporting(true);
                }}
              />
            ) : (
              // Nothing to add to on the sample view.
              <Button size="sm">
                <Plus className="size-4" />
                Add Contact
              </Button>
            )}
          </>
        }
      />

      <BentoGrid>
        {actions && importing ? (
          <ContactImportCard
            action={actions.importContacts}
            onClose={() => setImporting(false)}
          />
        ) : null}
        {actions && (adding || editing) ? (
          <ContactFormCard
            // A fresh form for each contact, and for adding.
            key={editing?.id ?? 'new'}
            action={actions.save}
            editing={editing}
            billingCustomers={billingCustomers}
            loadNotes={actions.notes}
            // An edit is finished once saved. After adding, the cleared form
            // stays for the next contact until it is closed.
            onSaved={() => {
              if (editing) closeForm();
            }}
            onClose={closeForm}
            firstFieldRef={firstFieldRef}
          />
        ) : null}

        {/* KPI row */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Total contacts"
            value={total.toLocaleString()}
            delta={live ? undefined : '+4.2%'}
            onPrimary
            chart={
              live ? undefined : (
                <Sparkline
                  data={SPARK_TOTAL}
                  color="var(--primary-foreground)"
                  height={36}
                />
              )
            }
          />
        </BentoCard>
        {!live && (
          <>
            <BentoCard className="col-span-1 md:col-span-3">
              <BentoStat
                label="New this week"
                value="86"
                delta="+18"
                deltaTone="up"
                chart={<Sparkline data={SPARK_NEW} color="var(--chart-2)" height={36} />}
              />
            </BentoCard>
            <BentoCard className="col-span-1 md:col-span-3">
              <BentoStat
                label="Qualified"
                value="402"
                delta="+6%"
                deltaTone="up"
                chart={<Sparkline data={SPARK_QUALIFIED} color="var(--chart-1)" height={36} />}
              />
            </BentoCard>
            <BentoCard className="col-span-1 md:col-span-3">
              <BentoStat
                label="Avg lead score"
                value="68"
                delta="+2"
                deltaTone="up"
                chart={<Sparkline data={SPARK_SCORE} color="var(--chart-3)" height={36} />}
              />
            </BentoCard>

            {/* Trend + score distribution */}
            <BentoCard
              title="Contacts added over time"
              subtitle="Last 8 weeks"
              icon={TrendingUp}
              className="col-span-2 md:col-span-8"
            >
              <AreaTrend data={ADDED_TREND} series={ADDED_SERIES} height={240} showLegend />
            </BentoCard>
            <BentoCard
              title="Lead score distribution"
              subtitle="Hot · Warm · Cold"
              icon={PieChart}
              className="col-span-2 md:col-span-4"
            >
              <DonutStat
                data={SCORE_MIX}
                height={240}
                centerValue={total.toLocaleString()}
                centerLabel="contacts"
              />
            </BentoCard>
          </>
        )}

        {/* Contacts table */}
        <BentoCard
          title="All contacts"
          subtitle="Most recent first"
          icon={Users}
          flush
          className="col-span-2 md:col-span-12"
        >
          <ContactsToolbar
            filters={filters}
            onChange={setFilters}
            tags={options.tags}
            filterOpen={filterOpen}
            onToggleFilter={() => setFilterOpen((open) => !open)}
          />
          {filterOpen ? (
            <ContactFilterPanel
              filters={filters}
              onChange={setFilters}
              pics={options.pics}
              countries={options.countries}
            />
          ) : null}
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allChecked}
                      onCheckedChange={toggleAll}
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead>Contact</TableHead>
                  {hidden.has('firstName') ? null : <TableHead>First name</TableHead>}
                  {hidden.has('lastName') ? null : <TableHead>Last name</TableHead>}
                  {hidden.has('phone') ? null : <TableHead>Phone</TableHead>}
                  {hidden.has('country') ? null : <TableHead>Country</TableHead>}
                  {hidden.has('status') ? null : <TableHead>Status</TableHead>}
                  {hidden.has('pic') ? null : <TableHead>PIC</TableHead>}
                  {hidden.has('lastInteraction') ? null : (
                    <TableHead>Last interaction</TableHead>
                  )}
                  {actions ? (
                    <TableHead className="w-10">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {openedId ? (
                  <TableRow className="bg-primary/5 hover:bg-primary/5">
                    <TableCell colSpan={columns} className="text-sm">
                      <span role="status">
                        {opened
                          ? 'Showing the contact you opened.'
                          : 'That contact could not be found. It may have been deleted, or it is not among the most recent contacts loaded here.'}
                      </span>{' '}
                      <Link href={pathname} className="font-medium text-primary hover:underline">
                        Show all contacts
                      </Link>
                    </TableCell>
                  </TableRow>
                ) : null}
                {shown.map((c) =>
                  actions && deletingId === c.id ? (
                    <DeleteContactRow
                      key={c.id}
                      contact={c}
                      action={actions.remove}
                      colSpan={columns}
                      onClose={() => setDeletingId(null)}
                    />
                  ) : (
                  <TableRow
                    key={c.id}
                    data-state={
                      selected.includes(c.id) || editing?.id === c.id ? 'selected' : undefined
                    }
                  >
                    <TableCell>
                      <Checkbox
                        checked={selected.includes(c.id)}
                        onCheckedChange={() => toggle(c.id)}
                        aria-label={`Select ${c.email}`}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <LeadScore value={c.score} />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{c.email}</p>
                          <ContactTags tags={c.tags ?? []} />
                          {live ? (
                            <ContactFollowUps
                              contactId={c.id}
                              items={followUps?.[c.id] ?? []}
                              add={actions?.addFollowUp}
                              complete={actions?.completeFollowUp}
                              adding={followUpFor === c.id}
                              onAdd={() => setFollowUpFor(c.id)}
                              onClose={() => setFollowUpFor(null)}
                            />
                          ) : (
                            <button
                              type="button"
                              className="text-xs font-medium uppercase tracking-wide text-primary hover:underline"
                            >
                              + Add follow-up
                            </button>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    {hidden.has('firstName') ? null : (
                      <TableCell className="whitespace-nowrap">{c.first}</TableCell>
                    )}
                    {hidden.has('lastName') ? null : (
                      <TableCell className="whitespace-nowrap">{c.last}</TableCell>
                    )}
                    {hidden.has('phone') ? null : (
                      <TableCell className="whitespace-nowrap tabular-nums">{c.phone}</TableCell>
                    )}
                    {hidden.has('country') ? null : <TableCell>{c.country}</TableCell>}
                    {hidden.has('status') ? null : (
                      <TableCell>
                        <StatusPill status={c.status} />
                      </TableCell>
                    )}
                    {hidden.has('pic') ? null : (
                      <TableCell className="whitespace-nowrap">{c.pic ?? '—'}</TableCell>
                    )}
                    {hidden.has('lastInteraction') ? null : (
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {c.lastInteraction ?? '—'}
                      </TableCell>
                    )}
                    {actions ? (
                      <TableCell>
                        <ContactRowMenu
                          label={c.email || c.first}
                          dealHref={`/crm/deals?contact=${encodeURIComponent(c.id)}`}
                          onEdit={() => startEdit(c)}
                          onClosed={menuClosed}
                          onDelete={() => {
                            setDeletingId(c.id);
                            setEditing((e) => (e?.id === c.id ? null : e));
                          }}
                        />
                      </TableCell>
                    ) : null}
                  </TableRow>
                  ),
                )}
                {shown.length === 0 && !openedId ? (
                  <TableRow>
                    <TableCell colSpan={columns} className="py-10 text-center text-muted-foreground">
                      {rows.length === 0
                        ? 'No contacts yet.'
                        : 'No contacts match. Try another view or clear the filters.'}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-muted-foreground">
            <span>
              Showing {shown.length} of {(narrowed ? filtered.length : total).toLocaleString()}{' '}
              contacts
              {narrowed ? ` (${total.toLocaleString()} in total)` : ''}
              {live && total > rows.length
                ? `. Views and filters cover the ${rows.length} most recent.`
                : ''}
            </span>
            <span className="flex items-center gap-3">
              {selectedShown.length > 0 ? <span>{selectedShown.length} selected</span> : null}
              {!openedId && filtered.length > shown.length ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPageSize((size) => size + PAGE_SIZE)}
                >
                  Show more
                </Button>
              ) : null}
            </span>
          </div>
        </BentoCard>

        {/* Pipeline breakdown + qualification rate */}
        {!live && (
          <>
            <BentoCard
              title="Pipeline by status"
              subtitle="Across all contacts"
              icon={BarChart3}
              className="col-span-2 md:col-span-8"
            >
              <BarGroup
                data={STATUS_MIX}
                series={STATUS_SERIES}
                horizontal
                height={200}
              />
            </BentoCard>
            <BentoCard
              title="Qualification rate"
              subtitle="Qualified ÷ total"
              icon={Target}
              className="col-span-2 md:col-span-4"
            >
              <RadialGauge
                value={31}
                label="qualified"
                valueLabel="31%"
                color="var(--chart-1)"
                height={200}
              />
            </BentoCard>
          </>
        )}
      </BentoGrid>
    </ScreenContainer>
  );
}
