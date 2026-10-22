'use client';

import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  FileText,
  Inbox,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoCard, BentoGrid } from '@/components/bento/bento';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LiveDot } from '@/components/ui/live-dot';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DEFAULT_FORM_CONSENT,
  FORM_CATEGORY_MAX,
  FORM_CONSENT_MAX,
  FORM_CONSENT_PLACEHOLDER,
  FORM_NAME_MAX,
  FORM_SLUG_MAX,
  FORM_STATUSES,
  FORM_STATUS_LABEL,
  type FormFieldInput,
  type FormFilters,
  NO_FORM_FILTERS,
  filterForms,
  formCategoriesInUse,
  formCategorySuggestions,
  formatFormDate,
  hasFormFilters,
  parseFormFields,
  slugifyFormName,
} from '@/lib/reach/forms';
import { formatSubmissionTime, publicFormUrl } from '@/lib/reach/form-submissions';
import type { Form, FormStatus, FormSubmission } from '@/lib/reach/types';

/** What every lead form action answers with. */
export type LeadFormResult = { ok: boolean; error?: string };

/*
 * The editor and the Submissions card share one grid and can both be open for
 * the same form, so each card's key says which card it is as well as which form.
 */
export const formCardKey = (form: { id: string } | null): string => `edit-${form?.id ?? 'new'}`;
export const submissionsCardKey = (form: { id: string }): string => `submissions-${form.id}`;

/**
 * The writes this screen can make. The page hands them in (they are server
 * actions over the reach capabilities); people who can only read get none, and
 * with none there is no Create button and no row menu.
 */
export type LeadFormActions = {
  create: (input: FormFieldInput) => Promise<LeadFormResult>;
  update: (input: FormFieldInput & { id: string }) => Promise<LeadFormResult>;
  setStatus: (input: { id: string; status: FormStatus }) => Promise<LeadFormResult>;
  remove: (input: { id: string }) => Promise<LeadFormResult>;
};

/**
 * Reading and removing what visitors sent. Any member may read; `remove` is
 * handed only to people who may change data.
 */
export type LeadFormSubmissionActions = {
  list: (input: {
    formId: string;
  }) => Promise<{ ok: true; data: FormSubmission[] } | { ok: false; error: string }>;
  remove?: (input: { id: string }) => Promise<LeadFormResult>;
};

const FALLBACK_ERROR = 'That change could not be saved. Please try again.';
const CONTACTS_PATH = '/crm/contacts';
/** Radix selects cannot hold an empty value, so "all" needs one of its own. */
const ALL = '__all__';

const NATIVE_SELECT_CLASS =
  'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30';

/** Active pulses green, paused is amber, a draft is neutral. */
function StatusDot({ status }: { status: FormStatus }) {
  if (status === 'paused') {
    return <span aria-hidden className="size-2 shrink-0 rounded-full bg-amber-500" />;
  }
  return <LiveDot active={status === 'active'} />;
}

export function LeadFormsView({
  forms,
  actions,
  publicOrigin,
  submissions,
  top,
  bottom,
}: {
  forms: Form[];
  /** Absent for viewers and demo guests, who can only read. */
  actions?: LeadFormActions;
  /**
   * The address this site is reached at, such as https://example.com. With it,
   * an active form shows its public link. Absent in the demo, where the forms
   * are samples with no page behind them.
   */
  publicOrigin?: string;
  /** Absent in the demo, which has counts but no stored submissions. */
  submissions?: LeadFormSubmissionActions;
  /** KPI cards and charts shown above the table. */
  top?: ReactNode;
  /** Charts shown below the table. */
  bottom?: ReactNode;
}) {
  const canEdit = actions != null;
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [filters, setFilters] = useState<FormFilters>(NO_FORM_FILTERS);

  // One-click row changes (activate, pause) report here; the card and the
  // delete confirmation show their own errors beside their buttons.
  const [rowPending, startRow] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const editing = editingId ? (forms.find((f) => f.id === editingId) ?? null) : null;
  const formOpen = canEdit && (creating || editing != null);
  const viewing = viewingId ? (forms.find((f) => f.id === viewingId) ?? null) : null;

  const categories = useMemo(() => formCategoriesInUse(forms), [forms]);
  const suggestions = useMemo(() => formCategorySuggestions(forms), [forms]);
  // A category that has since been renamed away no longer narrows the list.
  const category = categories.includes(filters.category) ? filters.category : '';
  const applied = useMemo(() => ({ ...filters, category }), [filters, category]);
  const shown = useMemo(() => filterForms(forms, applied), [forms, applied]);
  const narrowed = hasFormFilters(applied);
  const columns = canEdit ? 7 : 6;

  /* ---- focus ------------------------------------------------------- */

  const nameRef = useRef<HTMLInputElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const menuButtons = useRef(new Map<string, HTMLButtonElement>());
  const viewButtons = useRef(new Map<string, HTMLButtonElement>());
  // A row whose "⋯" button should take focus as soon as it is back on screen.
  const focusMenuWhenBack = useRef<string | null>(null);
  // A menu holds on to focus until it has closed, so what it opened is focused then.
  const afterMenu = useRef<'form' | 'delete' | null>(null);

  const focusName = () => {
    nameRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    nameRef.current?.focus({ preventScroll: true });
  };
  const focusMenu = (id: string) => {
    const button = menuButtons.current.get(id);
    if (button) button.focus();
    else focusMenuWhenBack.current = id;
  };
  const registerMenu = (id: string) => (button: HTMLButtonElement | null) => {
    if (!button) {
      menuButtons.current.delete(id);
      return;
    }
    menuButtons.current.set(id, button);
    if (focusMenuWhenBack.current === id) {
      focusMenuWhenBack.current = null;
      button.focus();
    }
  };
  /** Runs once a row menu has closed. True when focus was moved somewhere new. */
  const menuClosed = (): boolean => {
    const next = afterMenu.current;
    afterMenu.current = null;
    if (next === 'form') focusName();
    else if (next === 'delete') cancelDeleteRef.current?.focus();
    return next != null;
  };

  /* ---- opening and closing ----------------------------------------- */

  const startCreate = () => {
    setRowError(null);
    setDeletingId(null);
    setEditingId(null);
    if (creating) focusName();
    // Otherwise the card mounts with the name field focused.
    setCreating(true);
  };
  const startEdit = (id: string) => {
    setRowError(null);
    setDeletingId(null);
    setCreating(false);
    setEditingId(id);
    afterMenu.current = 'form';
  };
  const startDelete = (id: string) => {
    setRowError(null);
    setCreating(false);
    setEditingId(null);
    setDeletingId(id);
    afterMenu.current = 'delete';
  };
  const closeForm = () => {
    const backTo = editingId;
    setCreating(false);
    setEditingId(null);
    if (backTo) focusMenu(backTo);
    else createRef.current?.focus();
  };
  const closeDelete = (deleted: boolean) => {
    const id = deletingId;
    setDeletingId(null);
    if (deleted || !id) createRef.current?.focus();
    else focusMenu(id);
  };

  const closeSubmissions = () => {
    const backTo = viewingId;
    setViewingId(null);
    if (backTo) viewButtons.current.get(backTo)?.focus();
  };

  const changeStatus = (form: Form, status: FormStatus) => {
    // One change at a time; the menu button stays enabled so focus can return to it.
    if (!actions || rowPending) return;
    setRowError(null);
    setBusyId(form.id);
    startRow(async () => {
      const result = await actions.setStatus({ id: form.id, status });
      setBusyId(null);
      if (!result.ok) setRowError(result.error ?? FALLBACK_ERROR);
    });
  };

  return (
    <ScreenContainer>
      <PageHeader
        className="mb-3"
        title="Lead Forms"
        subtitle="Manage all your lead-generation forms."
        actions={canEdit ? <CreateFormButton ref={createRef} onClick={startCreate} /> : undefined}
      />

      <BentoGrid>
        {top}

        {formOpen && actions ? (
          <LeadFormCard
            // A different form (or a new one) starts from a clean card.
            key={formCardKey(editing)}
            editing={editing}
            suggestions={suggestions}
            nameRef={nameRef}
            save={(input) =>
              editing ? actions.update({ id: editing.id, ...input }) : actions.create(input)
            }
            onClose={closeForm}
          />
        ) : null}

        {viewing && submissions ? (
          <SubmissionsCard
            // Another form starts from its own list.
            key={submissionsCardKey(viewing)}
            form={viewing}
            submissions={submissions}
            onClose={closeSubmissions}
          />
        ) : null}

        <BentoCard
          title="Your forms"
          subtitle={forms.length === 1 ? '1 form' : `${forms.length} forms`}
          icon={FileText}
          flush
          className="col-span-2 md:col-span-12"
        >
          <div className="flex flex-col gap-3 px-4 sm:flex-row sm:items-center">
            <div className="relative w-full sm:max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search forms by name or short name"
                placeholder="Search form title…"
                className="pl-9"
                value={filters.query}
                onChange={(e) => setFilters({ ...filters, query: e.target.value })}
              />
            </div>
            <Select
              value={category || ALL}
              onValueChange={(v) => setFilters({ ...filters, category: v === ALL ? '' : v })}
            >
              <SelectTrigger aria-label="Filter by category" className="w-full sm:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All categories</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={filters.status || ALL}
              onValueChange={(v) =>
                setFilters({ ...filters, status: v === ALL ? '' : (v as FormStatus) })
              }
            >
              <SelectTrigger aria-label="Filter by status" className="w-full sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="paused">Paused</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {rowError && !rowPending ? (
            <p
              role="alert"
              className="mx-4 mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {rowError}
            </p>
          ) : null}

          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className="whitespace-nowrap">Form details</TableHead>
                  <TableHead className="whitespace-nowrap">Public link</TableHead>
                  <TableHead className="whitespace-nowrap">Status</TableHead>
                  <TableHead className="whitespace-nowrap">Views</TableHead>
                  <TableHead className="whitespace-nowrap">Contacts</TableHead>
                  <TableHead className="whitespace-nowrap">Created at</TableHead>
                  {canEdit ? <TableHead className="whitespace-nowrap">Action</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((f) =>
                  actions && deletingId === f.id ? (
                    <DeleteFormRow
                      key={f.id}
                      form={f}
                      colSpan={columns}
                      cancelRef={cancelDeleteRef}
                      remove={() => actions.remove({ id: f.id })}
                      onClose={closeDelete}
                    />
                  ) : (
                    <TableRow key={f.id} aria-busy={busyId === f.id || undefined}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                            <FileText className="size-4" />
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-medium">{f.name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {f.category || 'No category'}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <p className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                          {f.slug}
                        </p>
                        {publicOrigin ? (
                          f.status === 'active' ? (
                            <PublicLink form={f} url={publicFormUrl(publicOrigin, f.id)} />
                          ) : (
                            <p className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                              Activate this form to get its link.
                            </p>
                          )
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-2 whitespace-nowrap text-sm">
                          <StatusDot status={f.status} />
                          {FORM_STATUS_LABEL[f.status]}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {f.views_count.toLocaleString('en-US')}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        <span className="inline-flex items-center gap-2">
                          {f.submissions_count.toLocaleString('en-US')}
                          {submissions ? (
                            <Button
                              ref={(button) => {
                                if (button) viewButtons.current.set(f.id, button);
                                else viewButtons.current.delete(f.id);
                              }}
                              type="button"
                              variant="outline"
                              size="xs"
                              aria-label={`View submissions for ${f.name}`}
                              aria-expanded={viewingId === f.id}
                              onClick={() => setViewingId(f.id)}
                            >
                              View
                            </Button>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatFormDate(f.created_at)}
                      </TableCell>
                      {canEdit ? (
                        <TableCell>
                          <FormRowMenu
                            form={f}
                            buttonRef={registerMenu(f.id)}
                            onEdit={() => startEdit(f.id)}
                            onStatus={(status) => changeStatus(f, status)}
                            onDelete={() => startDelete(f.id)}
                            onClosed={menuClosed}
                          />
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ),
                )}
                {shown.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={columns} className="py-10 text-center">
                      {forms.length === 0 ? (
                        <div className="flex flex-col items-center gap-3">
                          <p className="text-sm text-muted-foreground">No forms yet.</p>
                          {canEdit ? <CreateFormButton onClick={startCreate} /> : null}
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-3">
                          <p className="text-sm text-muted-foreground">
                            No forms match your search or filters.
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setFilters(NO_FORM_FILTERS)}
                          >
                            Clear filters
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-muted-foreground">
            <span aria-live="polite">
              Showing {shown.length} of {forms.length} {forms.length === 1 ? 'form' : 'forms'}
              {narrowed ? ' (filtered)' : ''}
            </span>
          </div>
        </BentoCard>

        {bottom}
      </BentoGrid>
    </ScreenContainer>
  );
}

function CreateFormButton({
  ref,
  onClick,
}: {
  ref?: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  return (
    <Button ref={ref} type="button" size="sm" onClick={onClick}>
      <Plus className="size-4" />
      Create new form
    </Button>
  );
}

/** The card above the table: adds a form, or edits the one picked from a row. */
export function LeadFormCard({
  editing,
  suggestions,
  nameRef,
  save,
  onClose,
}: {
  /** The form being edited; null to add a new one. */
  editing: Form | null;
  suggestions: string[];
  nameRef: RefObject<HTMLInputElement | null>;
  save: (input: FormFieldInput) => Promise<LeadFormResult>;
  /** Called after a save has gone through, and by Close or Cancel. */
  onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(editing?.name ?? '');
  const [category, setCategory] = useState(editing?.category ?? '');
  const [slug, setSlug] = useState(editing?.slug ?? '');
  // The short name follows the name until the person types one of their own.
  // An existing form keeps its short name unless it is changed on purpose.
  const [slugEdited, setSlugEdited] = useState(editing != null);
  const [status, setStatus] = useState<FormStatus>(editing?.status ?? 'draft');
  const [consentText, setConsentText] = useState(editing?.consent_text ?? DEFAULT_FORM_CONSENT);
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  // An old message is not shown while the next attempt is still running.
  const error = pending ? null : failure;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so the fields are never reset
    // and a rejected form keeps everything that was typed.
    event.preventDefault();
    const parsed = parseFormFields({ name, category, slug, status, consent_text: consentText });
    if (!parsed.ok) {
      setFailure(parsed.error);
      return;
    }
    start(async () => {
      const result = await save(parsed.input);
      if (result.ok) onClose();
      else setFailure(result.error ?? FALLBACK_ERROR);
    });
  };

  return (
    <BentoCard
      title={editing ? 'Edit form' : 'Create form'}
      subtitle={editing ? `Changing ${editing.name}` : 'Add a lead form to this workspace'}
      // The card's icon chip only draws icons from the animated set.
      icon={editing ? FileText : Plus}
      className="col-span-2 md:col-span-12"
    >
      <form onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-12">
        <div className="space-y-1.5 md:col-span-4">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            ref={nameRef}
            id={`${id}-name`}
            name="name"
            placeholder="Raya promo signup"
            value={name}
            maxLength={FORM_NAME_MAX}
            autoComplete="off"
            // Opened from the Create button, the card takes focus as it appears.
            autoFocus
            required
            onChange={(e) => {
              setName(e.target.value);
              if (!slugEdited) setSlug(slugifyFormName(e.target.value));
            }}
          />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-category`}>Category</Label>
          <Input
            id={`${id}-category`}
            name="category"
            list={`${id}-categories`}
            placeholder="Promotions"
            value={category}
            maxLength={FORM_CATEGORY_MAX}
            autoComplete="off"
            onChange={(e) => setCategory(e.target.value)}
          />
          <datalist id={`${id}-categories`}>
            {suggestions.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label htmlFor={`${id}-slug`}>Short name</Label>
          <div className="relative">
            <Input
              id={`${id}-slug`}
              name="slug"
              placeholder="raya-promo"
              className="font-mono"
              value={slug}
              maxLength={FORM_SLUG_MAX + 1}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby={`${id}-slug-hint`}
              onChange={(e) => {
                // Older forms were typed with a leading "/"; it is not part of the name.
                const typed = e.target.value.replace(/^\/+/, '');
                setSlug(typed);
                // Emptying the field hands the short name back to the name.
                setSlugEdited(typed !== '');
              }}
            />
          </div>
          <p id={`${id}-slug-hint`} className="text-xs text-muted-foreground">
            A label for your own use: lower-case letters, numbers and hyphens. Leave empty
            to use the name. The public link is made for you once the form is active.
          </p>
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor={`${id}-status`}>Status</Label>
          <select
            id={`${id}-status`}
            name="status"
            value={status}
            onChange={(e) => setStatus(e.target.value as FormStatus)}
            className={NATIVE_SELECT_CLASS}
          >
            {FORM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {FORM_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5 md:col-span-12">
          <Label htmlFor={`${id}-consent`}>Consent sentence</Label>
          <Textarea
            id={`${id}-consent`}
            name="consent_text"
            rows={2}
            value={consentText}
            // One more than allowed, so a pasted sentence that is too long is reported, not cut.
            maxLength={FORM_CONSENT_MAX + 1}
            required
            aria-describedby={`${id}-consent-hint`}
            onChange={(e) => setConsentText(e.target.value)}
            className="min-h-16"
          />
          <p id={`${id}-consent-hint`} className="text-xs text-muted-foreground">
            Visitors tick a box beside this sentence before they can send the form, and each
            submission keeps the wording they agreed to. {FORM_CONSENT_PLACEHOLDER} becomes your
            workspace&apos;s name. Up to {FORM_CONSENT_MAX} characters.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" className="w-full md:w-auto" disabled={pending}>
            {editing ? <Check className="size-4" /> : <Plus className="size-4" />}
            {pending ? 'Saving…' : editing ? 'Save changes' : 'Save form'}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full md:w-auto"
            onClick={onClose}
            disabled={pending}
          >
            {editing ? 'Cancel' : 'Close'}
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </form>
    </BentoCard>
  );
}

/** The "⋯" menu at the end of a form's row. */
function FormRowMenu({
  form,
  buttonRef,
  onEdit,
  onStatus,
  onDelete,
  onClosed,
}: {
  form: Form;
  buttonRef: (button: HTMLButtonElement | null) => void;
  onEdit: () => void;
  onStatus: (status: FormStatus) => void;
  onDelete: () => void;
  /** Called once the menu has gone; answers whether it moved focus itself. */
  onClosed: () => boolean;
}) {
  const live = form.status === 'active';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        ref={buttonRef}
        aria-label={`Actions for ${form.name}`}
        className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      {/* Focus goes to what the choice opened; otherwise back to this button. */}
      <DropdownMenuContent
        align="end"
        className="w-36"
        onCloseAutoFocus={(event) => {
          if (onClosed()) event.preventDefault();
        }}
      >
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onStatus(live ? 'paused' : 'active')}>
          {live ? <Pause /> : <Play />}
          {live ? 'Pause' : 'Activate'}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Replaces a form's row while asking whether to really delete it. */
function DeleteFormRow({
  form,
  colSpan,
  cancelRef,
  remove,
  onClose,
}: {
  form: Form;
  colSpan: number;
  cancelRef: RefObject<HTMLButtonElement | null>;
  remove: () => Promise<LeadFormResult>;
  /** Told whether the form was deleted, or the question was called off. */
  onClose: (deleted: boolean) => void;
}) {
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  const error = pending ? null : failure;

  const confirm = () =>
    start(async () => {
      const result = await remove();
      if (result.ok) onClose(true);
      else setFailure(result.error ?? FALLBACK_ERROR);
    });

  return (
    <TableRow className="bg-destructive/5 hover:bg-destructive/5">
      <TableCell colSpan={colSpan}>
        <div
          role="group"
          aria-label={`Delete ${form.name}`}
          // Stays in view when the table has been scrolled sideways on a phone.
          className="sticky left-2 flex max-w-[calc(100vw-4rem)] flex-wrap items-center gap-3 py-1 whitespace-normal md:max-w-none"
        >
          <p className="min-w-48 flex-1 text-sm">
            Delete <span className="font-medium">{form.name}</span>? Its public link stops
            working and its submissions are deleted; the contacts they created stay. This
            cannot be undone.
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="button" variant="destructive" size="sm" onClick={confirm} disabled={pending}>
            <Trash2 className="size-4" />
            {pending ? 'Deleting…' : 'Delete form'}
          </Button>
          <Button
            ref={cancelRef}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onClose(false)}
            disabled={pending}
          >
            Cancel
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

/** An active form's public link, with a way to copy it and a way to open it. */
function PublicLink({ form, url }: { form: Form; url: string }) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = async () => {
    let result: 'yes' | 'failed' = 'yes';
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // No clipboard access (an insecure page, or permission refused).
      result = 'failed';
    }
    setCopied(result);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 2500);
  };

  return (
    <div className="mt-1 flex max-w-xs flex-wrap items-center gap-x-2 gap-y-1">
      <span className="min-w-0 max-w-full select-all truncate font-mono text-xs" title={url}>
        {url}
      </span>
      <span className="inline-flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={`Copy link to ${form.name}`}
          onClick={copy}
        >
          {copied === 'yes' ? <Check /> : <Copy />}
          {copied === 'yes' ? 'Copied' : 'Copy link'}
        </Button>
        <Button asChild variant="outline" size="xs">
          {/* A plain link: opening it is a real visit, never fetched ahead. */}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${form.name} in a new tab`}
          >
            <ExternalLink />
            Open
          </a>
        </Button>
      </span>
      <span
        role="status"
        className={copied === 'failed' ? 'w-full text-xs whitespace-normal text-destructive' : 'sr-only'}
      >
        {copied === 'yes'
          ? 'Link copied.'
          : copied === 'failed'
            ? 'The link could not be copied. Select it and copy it yourself.'
            : ''}
      </span>
    </div>
  );
}

/**
 * What a visitor agreed to when they sent a submission: when, and the sentence
 * as they read it. Submissions from before consent was asked for say so.
 */
export function SubmissionConsent({
  submission,
}: {
  submission: Pick<FormSubmission, 'consent_text' | 'consented_at'>;
}) {
  const { consent_text: text, consented_at: at } = submission;
  return (
    <div className="flex min-w-0 gap-2 sm:col-span-2">
      <dt className="shrink-0 text-muted-foreground">Consent</dt>
      {text && at ? (
        <dd className="min-w-0 break-words">
          <span className="font-medium">Consented {formatSubmissionTime(at)}</span>
          <span className="block text-muted-foreground">“{text}”</span>
        </dd>
      ) : (
        <dd className="min-w-0 text-muted-foreground">
          Not recorded (sent before consent was asked for)
        </dd>
      )}
    </div>
  );
}

type SubmissionsState =
  | { status: 'loading' }
  | { status: 'failed'; error: string }
  | { status: 'ready'; rows: FormSubmission[] };

/** The card above the table: what visitors sent through one form, newest first. */
function SubmissionsCard({
  form,
  submissions,
  onClose,
}: {
  form: Form;
  submissions: LeadFormSubmissionActions;
  onClose: () => void;
}) {
  const { list, remove } = submissions;
  const [state, setState] = useState<SubmissionsState>({ status: 'loading' });
  const [, startLoad] = useTransition();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pending, startDelete] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const started = useRef(false);

  const load = () =>
    startLoad(async () => {
      setState({ status: 'loading' });
      const result = await list({ formId: form.id });
      setState(
        result.ok
          ? { status: 'ready', rows: result.data }
          : { status: 'failed', error: result.error },
      );
    });

  // The card appears with the Close button focused, and reads its list then.
  const mounted = (button: HTMLButtonElement | null) => {
    closeRef.current = button;
    if (!button || started.current) return;
    started.current = true;
    button.focus();
    load();
  };

  const confirmDelete = (id: string) => {
    if (!remove) return;
    setFailure(null);
    startDelete(async () => {
      const result = await remove({ id });
      if (!result.ok) {
        setFailure(result.error ?? FALLBACK_ERROR);
        return;
      }
      setDeletingId(null);
      setState((current) =>
        current.status === 'ready'
          ? { status: 'ready', rows: current.rows.filter((row) => row.id !== id) }
          : current,
      );
      // Its buttons are gone with it.
      closeRef.current?.focus();
    });
  };

  const rows = state.status === 'ready' ? state.rows : [];

  return (
    <BentoCard
      title="Submissions"
      subtitle={`The latest from ${form.name}`}
      icon={Inbox}
      className="col-span-2 md:col-span-12"
      action={
        <Button ref={mounted} type="button" variant="outline" size="sm" onClick={onClose}>
          <X className="size-4" />
          Close
        </Button>
      }
    >
      <div aria-live="polite" aria-busy={state.status === 'loading'}>
        {state.status === 'loading' ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading submissions…</p>
        ) : state.status === 'failed' ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={load}>
              Try again
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No submissions to show for this form yet.
          </p>
        ) : (
          <ul className="divide-y">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="min-w-0 break-words font-medium">{row.name || 'No name'}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatSubmissionTime(row.created_at)}
                  </p>
                </div>
                <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <div className="flex min-w-0 gap-2">
                    <dt className="shrink-0 text-muted-foreground">Email</dt>
                    <dd className="min-w-0 break-all">{row.email || '—'}</dd>
                  </div>
                  <div className="flex min-w-0 gap-2">
                    <dt className="shrink-0 text-muted-foreground">Phone</dt>
                    <dd className="min-w-0 break-all">{row.phone || '—'}</dd>
                  </div>
                  <div className="flex min-w-0 gap-2 sm:col-span-2">
                    <dt className="shrink-0 text-muted-foreground">Message</dt>
                    <dd className="min-w-0 whitespace-pre-wrap break-words">
                      {row.message || '—'}
                    </dd>
                  </div>
                  <SubmissionConsent submission={row} />
                </dl>
                {remove && deletingId === row.id ? (
                  <div
                    role="group"
                    aria-label={`Delete the submission from ${row.name || row.email}`}
                    className="flex flex-wrap items-center gap-3 rounded-lg bg-destructive/5 px-3 py-2"
                  >
                    <p className="min-w-48 flex-1 text-sm">
                      Delete this submission? The contact it made stays in Kasturi. This cannot be
                      undone.
                    </p>
                    {failure && !pending ? (
                      <p role="alert" className="text-sm text-destructive">
                        {failure}
                      </p>
                    ) : null}
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => confirmDelete(row.id)}
                      disabled={pending}
                    >
                      <Trash2 className="size-4" />
                      {pending ? 'Deleting…' : 'Delete submission'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      // The question opens with the safe answer focused.
                      autoFocus
                      onClick={() => setDeletingId(null)}
                      disabled={pending}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    {row.contact_id ? (
                      <Button asChild variant="outline" size="xs">
                        <Link
                          href={`${CONTACTS_PATH}?contact=${row.contact_id}`}
                          aria-label={`Open ${row.name || row.email} in Kasturi contacts`}
                        >
                          <ExternalLink />
                          Contact in Kasturi
                        </Link>
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Its contact has been deleted.
                      </span>
                    )}
                    {remove ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="text-destructive hover:text-destructive"
                        aria-label={`Delete the submission from ${row.name || row.email}`}
                        onClick={() => {
                          setFailure(null);
                          setDeletingId(row.id);
                        }}
                      >
                        <Trash2 />
                        Delete
                      </Button>
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </BentoCard>
  );
}
