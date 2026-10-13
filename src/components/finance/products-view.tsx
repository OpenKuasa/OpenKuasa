'use client';

import { type FormEvent, useId, useState } from 'react';
import { Archive, ArchiveRestore, BarChart3, Boxes, Pencil, PieChart, Plus, Search, Trash2 } from 'lucide-react';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  PRODUCT_LIMIT,
  PRODUCT_NAME_MAX,
  type FinanceProduct,
  type ProductType,
  type ProductsViewData,
} from '@/lib/finance/products';
import { rm } from '@/lib/finance/format';
import type { FinResult } from '@/lib/finance/result';
import { cn } from '@/lib/utils';

export type ProductActions = {
  create: (input: unknown) => Promise<FinResult<FinanceProduct>>;
  update: (input: unknown) => Promise<FinResult<FinanceProduct>>;
  setActive: (input: unknown) => Promise<FinResult<FinanceProduct>>;
  remove: (input: unknown) => Promise<FinResult<{ id: string }>>;
};

const CATEGORY_SERIES: Series[] = [{ key: 'items', label: 'Items', color: 'var(--chart-1)' }];

type Filter = 'active' | 'product' | 'service' | 'archived';

function matches(row: FinanceProduct, filter: Filter) {
  if (filter === 'archived') return !row.active;
  if (!row.active) return false;
  return filter === 'active' || row.type === filter;
}

export function ProductsView({ view, actions }: { view: ProductsViewData; actions?: ProductActions }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('active');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<FinanceProduct | null>(null);
  const [deleting, setDeleting] = useState<FinanceProduct | null>(null);
  const rowAction = useFinanceAction();
  const deleteAction = useFinanceAction();

  const q = query.trim().toLowerCase();
  const rows = view.rows.filter(
    (p) => matches(p, filter) && `${p.name} ${p.sku ?? ''} ${p.category ?? ''}`.toLowerCase().includes(q),
  );
  const columns = actions ? 8 : 7;
  const { items, services, taxable, averagePrice } = view.stats;
  const split: Slice[] = [
    { key: 'product', label: 'Products', value: items - services, color: 'var(--chart-1)' },
    { key: 'service', label: 'Services', value: services, color: 'var(--chart-2)' },
  ];

  return (
    <ScreenContainer className="pb-24 sm:pb-24">
      <PageHeader
        title="Products & Services"
        subtitle="Items you sell & buy, Saudara."
        actions={
          actions ? (
            <Button
              size="sm"
              aria-expanded={adding}
              onClick={() => {
                setEditing(null);
                setDeleting(null);
                setAdding(true);
              }}
            >
              <Plus className="size-4" />
              Add Item
            </Button>
          ) : undefined
        }
      />

      <BentoGrid>
        {actions && (adding || editing) ? (
          <ProductFormCard
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
          <BentoStat label="Items" value={String(items)} onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Avg price" value={rm(averagePrice)} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Taxable items" value={String(taxable)} delta="with SST" deltaTone="flat" />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Services" value={String(services)} />
        </BentoCard>

        <BentoCard
          title="Items by category"
          subtitle="Active items"
          icon={BarChart3}
          className="col-span-2 md:col-span-8"
        >
          {view.byCategory.length ? (
            <BarGroup data={view.byCategory.slice(0, 6)} series={CATEGORY_SERIES} horizontal height={240} />
          ) : (
            <p className="grid h-60 place-items-center text-sm text-muted-foreground">No items yet.</p>
          )}
        </BentoCard>
        <BentoCard
          title="Products vs services"
          subtitle="Active items"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          <DonutStat data={split} height={240} centerValue={String(items)} centerLabel="items" />
        </BentoCard>

        <BentoCard
          title="All items"
          subtitle="Products and services in this workspace"
          icon={Boxes}
          flush
          className="col-span-2 md:col-span-12"
        >
          <div className="flex flex-wrap items-center gap-2 px-4">
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search items by name, SKU or category"
                placeholder="Search items…"
                className="pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
              <SelectTrigger className="w-40" aria-label="Show">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">All active</SelectItem>
                <SelectItem value="product">Products</SelectItem>
                <SelectItem value="service">Services</SelectItem>
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
                  <TableHead>SKU</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead>SST</TableHead>
                  <TableHead>Status</TableHead>
                  {actions ? <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 &&
                  (view.rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={columns} className="py-8 text-center text-muted-foreground">
                        No items yet.{actions ? ' Add your first product or service.' : ''}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <NoMatchesRow colSpan={columns} />
                  ))}
                {rows.map((p) =>
                  actions && deleting?.id === p.id ? (
                    <ConfirmRow
                      key={p.id}
                      colSpan={columns}
                      label={`Delete ${p.name}`}
                      confirmLabel="Delete item"
                      pendingLabel="Deleting…"
                      pending={deleteAction.pending}
                      error={deleteAction.error}
                      onConfirm={() => deleteAction.run(() => actions.remove({ id: p.id }), () => setDeleting(null))}
                      onCancel={() => setDeleting(null)}
                    >
                      Delete <span className="font-medium">{p.name}</span>? This cannot be undone. An item
                      that is on a bill or other document cannot be deleted; archive it instead.
                    </ConfirmRow>
                  ) : (
                    <TableRow key={p.id} className={cn(!p.active && 'opacity-60')}>
                      <TableCell className="whitespace-nowrap font-medium">{p.name}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                        {p.sku ?? '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{p.type === 'service' ? 'Service' : 'Product'}</Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{p.category ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums">
                        {rm(p.price)}
                        <span className="ml-1 text-xs text-muted-foreground">/ {p.uom}</span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{p.sst_rate > 0 ? `SST ${p.sst_rate}%` : 'None'}</TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                            p.active ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {p.active ? 'Active' : 'Archived'}
                        </span>
                      </TableCell>
                      {actions ? (
                        <TableCell>
                          <RowMenu
                            label={p.name}
                            items={[
                              {
                                label: 'Edit',
                                icon: Pencil,
                                opens: true,
                                onSelect: () => {
                                  setAdding(false);
                                  setDeleting(null);
                                  setEditing(p);
                                },
                              },
                              p.active
                                ? {
                                    label: 'Archive',
                                    icon: Archive,
                                    onSelect: () => rowAction.run(() => actions.setActive({ id: p.id, active: false })),
                                  }
                                : {
                                    label: 'Restore',
                                    icon: ArchiveRestore,
                                    onSelect: () => rowAction.run(() => actions.setActive({ id: p.id, active: true })),
                                  },
                              {
                                label: 'Delete',
                                icon: Trash2,
                                destructive: true,
                                opens: true,
                                onSelect: () => {
                                  setAdding(false);
                                  setEditing(null);
                                  deleteAction.clear();
                                  setDeleting(p);
                                },
                              },
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
            Showing {rows.length} of {view.rows.length} items
            {view.rows.length >= PRODUCT_LIMIT ? ` (the first ${PRODUCT_LIMIT} by name)` : ''}
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}

/** A typed amount as a number, or null when it is empty or not a number. */
function amount(value: string): number | null {
  const n = Number(value);
  return value.trim() === '' || !Number.isFinite(n) ? null : n;
}

function ProductFormCard({
  editing,
  actions,
  onClose,
}: {
  editing: FinanceProduct | null;
  actions: ProductActions;
  onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(editing?.name ?? '');
  const [type, setType] = useState<ProductType>(editing?.type ?? 'product');
  const [sku, setSku] = useState(editing?.sku ?? '');
  const [category, setCategory] = useState(editing?.category ?? '');
  const [uom, setUom] = useState(editing?.uom ?? 'unit');
  const [price, setPrice] = useState(editing ? String(editing.price) : '');
  const [cost, setCost] = useState(editing ? String(editing.cost) : '');
  const [sst, setSst] = useState(editing ? String(editing.sst_rate) : '0');
  const save = useFinanceAction();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const priceValue = amount(price);
    if (priceValue === null) {
      save.fail('Enter a price of 0 or more.');
      return;
    }
    const costValue = cost.trim() === '' ? 0 : amount(cost);
    if (costValue === null) {
      save.fail('Enter a cost of 0 or more.');
      return;
    }
    const sstValue = sst.trim() === '' ? 0 : amount(sst);
    if (sstValue === null) {
      save.fail('Enter an SST rate between 0 and 100.');
      return;
    }
    const fields = { name, type, sku, category, uom, price: priceValue, cost: costValue, sst_rate: sstValue };
    save.run(
      () => (editing ? actions.update({ id: editing.id, ...fields }) : actions.create(fields)),
      onClose,
    );
  };

  return (
    <BentoCard
      title={editing ? 'Edit item' : 'Add item'}
      subtitle={editing ? `Changing ${editing.name}` : 'A product or a service'}
      icon={editing ? Boxes : Plus}
      className="col-span-2 md:col-span-12"
    >
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className="space-y-1.5 md:col-span-5">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={PRODUCT_NAME_MAX}
            placeholder="A4 Paper (Ream)"
            autoComplete="off"
            autoFocus
            data-finance-focus
            required
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor={`${id}-type`}>Type</Label>
          <Select value={type} onValueChange={(v) => setType(v as ProductType)}>
            <SelectTrigger id={`${id}-type`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="product">Product</SelectItem>
              <SelectItem value="service">Service</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor={`${id}-sku`}>SKU</Label>
          <Input id={`${id}-sku`} value={sku} placeholder="PRD-011" autoComplete="off" className="font-mono" onChange={(e) => setSku(e.target.value)} />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-category`}>Category</Label>
          <Input id={`${id}-category`} value={category} placeholder="Office supplies" autoComplete="off" onChange={(e) => setCategory(e.target.value)} />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-price`}>Selling price (RM)</Label>
          <Input id={`${id}-price`} type="number" inputMode="decimal" min={0} step="0.01" value={price} placeholder="0.00" required onChange={(e) => setPrice(e.target.value)} />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-cost`}>Cost (RM)</Label>
          <Input id={`${id}-cost`} type="number" inputMode="decimal" min={0} step="0.0001" value={cost} placeholder="0.0000" onChange={(e) => setCost(e.target.value)} />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-sst`}>SST rate (%)</Label>
          <Input id={`${id}-sst`} type="number" inputMode="decimal" min={0} max={100} step="0.01" value={sst} onChange={(e) => setSst(e.target.value)} />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-uom`}>Unit</Label>
          <Input id={`${id}-uom`} value={uom} placeholder="unit" autoComplete="off" onChange={(e) => setUom(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" size="sm" disabled={save.pending}>
            {save.pending ? 'Saving…' : editing ? 'Save changes' : 'Add item'}
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
