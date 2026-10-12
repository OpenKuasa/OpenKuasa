'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, Copy, ExternalLink, FileText, MonitorSmartphone, Pencil, Plus, Trash2 } from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LiveDot } from '@/components/ui/live-dot';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import type { CrmFormAction } from '@/lib/crm/form-state';
import {
  DEFAULT_BUTTON_LABEL,
  LANDING_PAGE_STATUS_LABELS,
  PAGE_BODY_MAX,
  PAGE_BUTTON_MAX,
  PAGE_HEADLINE_MAX,
  PAGE_NAME_MAX,
  PAGE_SUBHEADLINE_MAX,
  landingPageStats,
  type LandingPage,
  type LandingPageFormChoice,
} from '@/lib/crm/landing-pages';
import { cn } from '@/lib/utils';
import { SELECT_CLASS, useCrmForm } from './crm-form';

type Actions = { save: CrmFormAction; remove: CrmFormAction };

type Draft = {
  name: string;
  headline: string;
  subheadline: string;
  body: string;
  buttonLabel: string;
  formId: string;
  status: string;
};

const EMPTY: Draft = {
  name: '',
  headline: '',
  subheadline: '',
  body: '',
  buttonLabel: '',
  formId: '',
  status: 'draft',
};

function toDraft(page: LandingPage): Draft {
  return {
    name: page.name,
    headline: page.headline,
    subheadline: page.subheadline,
    body: page.body,
    buttonLabel: page.buttonLabel,
    formId: page.formId ?? '',
    status: page.status,
  };
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/** What a visitor will see, drawn small from what is in the form. */
function PagePreview({ draft, orgHint }: { draft: Draft; orgHint: string }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-background shadow-sm" aria-label="Preview">
      <div className="flex items-center gap-1.5 border-b bg-muted/40 px-3 py-2">
        <span className="size-2 rounded-full bg-muted-foreground/30" />
        <span className="size-2 rounded-full bg-muted-foreground/30" />
        <span className="size-2 rounded-full bg-muted-foreground/30" />
        <span className="ml-2 truncate text-[10px] text-muted-foreground">{orgHint}</span>
      </div>
      <div className="space-y-2 bg-muted/40 p-4">
        <p className="text-base font-bold leading-tight break-words">
          {draft.headline || <span className="text-muted-foreground">Your headline</span>}
        </p>
        {draft.subheadline ? (
          <p className="text-xs text-muted-foreground break-words">{draft.subheadline}</p>
        ) : null}
        {draft.body ? (
          <p className="line-clamp-4 whitespace-pre-line text-[11px] leading-relaxed break-words">{draft.body}</p>
        ) : null}
        <div className="space-y-1.5 rounded-lg border bg-card p-3">
          {['Name', 'Email', 'Phone', 'Message'].map((field) => (
            <div key={field} className="rounded border bg-background px-2 py-1 text-[10px] text-muted-foreground">
              {field}
            </div>
          ))}
          <div className="truncate rounded-md bg-primary px-3 py-1.5 text-center text-[11px] font-semibold text-primary-foreground">
            {draft.buttonLabel || DEFAULT_BUTTON_LABEL}
          </div>
        </div>
      </div>
    </div>
  );
}

function PageFormCard({
  action,
  editing,
  forms,
  onSaved,
  onClose,
}: {
  action: CrmFormAction;
  /** The page being edited; null to add a new one. */
  editing: LandingPage | null;
  forms: LandingPageFormChoice[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const { formAction, pending, error } = useCrmForm(action, onSaved);
  // Held here so the preview follows what is typed, and a rejected save keeps it.
  const [draft, setDraft] = useState<Draft>(editing ? toDraft(editing) : EMPTY);
  const set = (key: keyof Draft) => (event: { target: { value: string } }) =>
    setDraft((current) => ({ ...current, [key]: event.target.value }));

  // A form deleted since the page was made is no longer offered.
  const chosen = forms.find((form) => form.id === draft.formId);

  return (
    <BentoCard
      title={editing ? 'Edit page' : 'New page'}
      subtitle={editing ? `Changing ${editing.name}` : 'A public page with one of your lead forms on it'}
      // The card's icon chip only draws icons from the animated set.
      icon={editing ? FileText : Plus}
      className="col-span-2 md:col-span-12"
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        <form action={formAction} className="grid content-start gap-3 md:grid-cols-12">
          {editing ? <input type="hidden" name="pageId" value={editing.id} /> : null}
          <div className="space-y-1.5 md:col-span-6">
            <Label htmlFor="page-name">Name</Label>
            <Input
              id="page-name"
              name="name"
              placeholder="Raya promo"
              value={draft.name}
              onChange={set('name')}
              maxLength={PAGE_NAME_MAX}
              aria-describedby="page-name-hint"
              autoFocus
              required
            />
            <p id="page-name-hint" className="text-xs text-muted-foreground">
              Only you see this.
            </p>
          </div>
          <div className="space-y-1.5 md:col-span-6">
            <Label htmlFor="page-form">Lead form</Label>
            <select
              id="page-form"
              name="formId"
              value={chosen ? draft.formId : ''}
              onChange={set('formId')}
              className={SELECT_CLASS}
              aria-describedby="page-form-hint"
            >
              <option value="">None yet</option>
              {forms.map((form) => (
                <option key={form.id} value={form.id}>
                  {form.name}
                  {form.status === 'active' ? '' : ` (${form.status})`}
                </option>
              ))}
            </select>
            <p id="page-form-hint" className="text-xs text-muted-foreground">
              {forms.length === 0 ? (
                <>
                  No lead forms yet.{' '}
                  <Link href="/crm/lead-forms" className="font-medium text-primary underline-offset-4 hover:underline">
                    Create one first
                  </Link>
                  .
                </>
              ) : chosen && chosen.status !== 'active' ? (
                'This form is not active, so visitors will see "page not available" until it is.'
              ) : (
                'Responses go to this form, and its contacts, as usual.'
              )}
            </p>
          </div>
          <div className="space-y-1.5 md:col-span-12">
            <Label htmlFor="page-headline">Headline</Label>
            <Input
              id="page-headline"
              name="headline"
              placeholder="Diskaun Raya sehingga 50%"
              value={draft.headline}
              onChange={set('headline')}
              maxLength={PAGE_HEADLINE_MAX}
              required
            />
          </div>
          <div className="space-y-1.5 md:col-span-12">
            <Label htmlFor="page-subheadline">Subheading</Label>
            <Input
              id="page-subheadline"
              name="subheadline"
              placeholder="Tempahan terhad, hingga 20 April"
              value={draft.subheadline}
              onChange={set('subheadline')}
              maxLength={PAGE_SUBHEADLINE_MAX}
            />
          </div>
          <div className="space-y-1.5 md:col-span-12">
            <Label htmlFor="page-body">Text</Label>
            <Textarea
              id="page-body"
              name="body"
              rows={5}
              placeholder="Tell visitors what they get. Leave a blank line between paragraphs."
              value={draft.body}
              onChange={set('body')}
              maxLength={PAGE_BODY_MAX}
            />
          </div>
          <div className="space-y-1.5 md:col-span-6">
            <Label htmlFor="page-button">Button label</Label>
            <Input
              id="page-button"
              name="buttonLabel"
              placeholder={DEFAULT_BUTTON_LABEL}
              value={draft.buttonLabel}
              onChange={set('buttonLabel')}
              maxLength={PAGE_BUTTON_MAX}
            />
          </div>
          <div className="space-y-1.5 md:col-span-6">
            <Label htmlFor="page-status">Status</Label>
            <select
              id="page-status"
              name="status"
              value={draft.status}
              onChange={set('status')}
              className={SELECT_CLASS}
            >
              <option value="draft">Draft (only you can see it)</option>
              <option value="published">Published (anyone with the link)</option>
            </select>
          </div>
          <div className="flex flex-wrap items-end gap-3 md:col-span-12">
            <Button type="submit" className="w-full md:w-auto" disabled={pending}>
              {editing ? <Check className="size-4" /> : <Plus className="size-4" />}
              {pending ? 'Saving…' : editing ? 'Save changes' : 'Save page'}
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
        <div className="space-y-2">
          <p className="text-sm font-medium">Preview</p>
          <PagePreview draft={draft} orgHint={editing ? editing.path : '/p/…'} />
        </div>
      </div>
    </BentoCard>
  );
}

function DeletePageRow({
  page,
  action,
  colSpan,
  onClose,
}: {
  page: LandingPage;
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
          <input type="hidden" name="pageId" value={page.id} />
          <p className="min-w-0 flex-1 text-sm">
            Delete <span className="font-medium">{page.name}</span>? Its link stops working and its counts are
            lost. The lead form and its contacts are kept. This cannot be undone.
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="destructive" size="sm" disabled={pending}>
            <Trash2 className="size-4" />
            {pending ? 'Deleting…' : 'Delete page'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
        </form>
      </TableCell>
    </TableRow>
  );
}

function CopyLinkButton({ page }: { page: LandingPage }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${page.path}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard access: the link is still there to open and copy by hand.
    }
  };
  return (
    <Button variant="ghost" size="icon" onClick={copy} aria-label={`Copy link to ${page.name}`}>
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </Button>
  );
}

/** Kasturi's landing pages, with the form to add and edit them. */
export function LandingPagesView({
  pages,
  forms,
  actions,
}: {
  pages: LandingPage[];
  forms: LandingPageFormChoice[];
  /** Present only when the signed-in person may change pages. */
  actions?: Actions;
}) {
  // One thing is open at a time: the form, or a delete question.
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<LandingPage | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const stats = landingPageStats(pages);
  const columns = 6 + (actions ? 1 : 0);
  const closeForm = () => {
    setAdding(false);
    setEditing(null);
  };

  return (
    <ScreenContainer>
      <PageHeader
        title="Landing Pages"
        subtitle="Public pages that put a lead form in front of visitors."
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
              New page
            </Button>
          ) : null
        }
      />

      <BentoGrid>
        {actions && (adding || editing) ? (
          <PageFormCard
            // A fresh form for each page, and for adding.
            key={editing?.id ?? 'new'}
            action={actions.save}
            editing={editing}
            forms={forms}
            onSaved={closeForm}
            onClose={closeForm}
          />
        ) : null}

        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Pages"
            value={String(stats.pages)}
            delta={`${stats.published} published`}
            onPrimary
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Views" value={stats.views.toLocaleString('en-MY')} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Leads captured" value={stats.leads.toLocaleString('en-MY')} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Conversion" value={stats.conversion === null ? '—' : `${stats.conversion}%`} />
        </BentoCard>

        <BentoCard
          title="My pages"
          subtitle={pages.length === 0 ? 'None yet' : 'Newest first'}
          icon={MonitorSmartphone}
          className="col-span-2 md:col-span-12"
        >
          {pages.length === 0 ? (
            <Muted>
              {actions
                ? 'No landing pages yet. Choose "New page" to make your first.'
                : 'No landing pages yet.'}
            </Muted>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Page</TableHead>
                    <TableHead>Lead form</TableHead>
                    <TableHead className="text-right">Views</TableHead>
                    <TableHead className="text-right">Leads</TableHead>
                    <TableHead className="text-right">Conversion</TableHead>
                    <TableHead>Status</TableHead>
                    {/* Pinned to the right edge, so the buttons stay in reach when the table is wider than its card. */}
                    {actions ? <TableHead className="sticky right-0 bg-muted text-right shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.2)]">Actions</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pages.map((page) =>
                    actions && deletingId === page.id ? (
                      <DeletePageRow
                        key={page.id}
                        page={page}
                        action={actions.remove}
                        colSpan={columns}
                        onClose={() => setDeletingId(null)}
                      />
                    ) : (
                      <TableRow key={page.id}>
                        <TableCell className="max-w-64">
                          <p className="truncate font-medium">{page.name}</p>
                          <p className="truncate text-xs text-muted-foreground">{page.headline}</p>
                        </TableCell>
                        <TableCell className="max-w-48 truncate">
                          {page.formName ?? <span className="text-muted-foreground">None</span>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{page.views.toLocaleString('en-MY')}</TableCell>
                        <TableCell className="text-right tabular-nums">{page.leads.toLocaleString('en-MY')}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {page.views > 0 ? `${Math.round((page.leads / page.views) * 1000) / 10}%` : '—'}
                        </TableCell>
                        <TableCell>
                          <span className="flex items-center gap-2">
                            <LiveDot active={page.live} />
                            <span
                              className={cn(
                                'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
                                page.live
                                  ? 'bg-emerald-500/15 text-emerald-600'
                                  : page.status === 'published'
                                    ? 'bg-amber-500/15 text-amber-600'
                                    : 'bg-muted text-muted-foreground',
                              )}
                            >
                              {page.status === 'published' && !page.live
                                ? 'Form not active'
                                : LANDING_PAGE_STATUS_LABELS[page.status]}
                            </span>
                          </span>
                        </TableCell>
                        {actions ? (
                          <TableCell className="sticky right-0 bg-card shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.2)]">
                            <div className="flex items-center justify-end gap-1">
                              <CopyLinkButton page={page} />
                              <Link
                                href={page.path}
                                target="_blank"
                                rel="noopener"
                                prefetch={false}
                                aria-label={`Open ${page.name}`}
                                className="grid size-9 place-items-center rounded-md text-foreground transition-colors hover:bg-accent"
                              >
                                <ExternalLink className="size-4" />
                              </Link>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Edit ${page.name}`}
                                onClick={() => {
                                  setAdding(false);
                                  setDeletingId(null);
                                  setEditing(page);
                                }}
                              >
                                <Pencil className="size-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Delete ${page.name}`}
                                onClick={() => {
                                  closeForm();
                                  setDeletingId(page.id);
                                }}
                              >
                                <Trash2 className="size-4 text-destructive" />
                              </Button>
                            </div>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ),
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
