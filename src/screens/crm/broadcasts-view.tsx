'use client';

import { useActionState, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Check,
  Copy,
  Download,
  FileText,
  Megaphone,
  Pencil,
  RotateCcw,
  Plus,
  Send,
  Settings,
  Trash2,
  Users,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
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
import { Textarea } from '@/components/ui/textarea';
import {
  AUDIENCE_CONTACTS_MAX,
  AUDIENCE_STATUSES,
  AUDIENCE_STATUS_LABELS,
  BROADCAST_BODY_MAX,
  BROADCAST_RECIPIENTS_MAX,
  BROADCAST_STATUS_LABELS,
  BROADCAST_NAME_MAX,
  BROADCAST_SUBJECT_MAX,
  audienceFor,
  audienceSummary,
  audienceTagOptions,
  recipientsCsv,
  type AudienceContact,
  type AudienceStatus,
  type Broadcast,
  type BroadcastAudience,
  type RetryState,
} from '@/lib/crm/broadcasts';
import { formatDay } from '@/lib/crm/deal-stats';
import type { CrmFormAction, CrmFormState } from '@/lib/crm/form-state';
import { cn } from '@/lib/utils';
import { useCrmForm } from './crm-form';

type Actions = { save: CrmFormAction; remove: CrmFormAction };
type KeyActions = { save: CrmFormAction; remove: CrmFormAction };
type SendActions = { send: CrmFormAction; test: CrmFormAction; resume: CrmFormAction };
/** What members may know about the workspace's email key. */
type EmailKey = { keyHint: string; senderEmail: string; senderName: string };

/** Runs an action and keeps what it answered, so a success message can be shown as well as a refusal. */
function useAnswer(action: CrmFormAction) {
  const [state, formAction, pending] = useActionState<CrmFormState, FormData>(action, undefined);
  return {
    formAction,
    pending,
    error: state && !state.ok && !pending ? state.error : null,
    message: state?.ok && !pending ? (state.message ?? null) : null,
  };
}

/** How many recipients the form's preview names. */
const PREVIEW_LISTED = 8;

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function people(count: number) {
  return `${count.toLocaleString('en-MY')} ${count === 1 ? 'recipient' : 'recipients'}`;
}

/** A file name a browser will keep: 'raya-promo-recipients.csv'. */
function csvName(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug || 'broadcast'}-recipients.csv`;
}

function downloadCsv(name: string, recipients: AudienceContact[]) {
  // The BOM makes a spreadsheet read names with accents or Chinese characters correctly.
  const blob = new Blob(['﻿', recipientsCsv(recipients)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = csvName(name);
  link.click();
  URL.revokeObjectURL(url);
}

function CopyMessageButton({ broadcast }: { broadcast: Broadcast }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${broadcast.subject}\n\n${broadcast.body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard access: the message is still there to open and copy by hand.
    }
  };
  return (
    <Button variant="ghost" size="icon" onClick={copy} aria-label={`Copy the message of ${broadcast.name}`}>
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </Button>
  );
}

/** Owner and admin only: the workspace's Resend key and the sender its broadcasts go out as. */
function EmailSettingsCard({
  emailKey,
  actions,
  onClose,
}: {
  emailKey: EmailKey | null;
  actions: KeyActions;
  onClose: () => void;
}) {
  const save = useAnswer(actions.save);
  const remove = useAnswer(actions.remove);
  return (
    <BentoCard
      title="Email settings"
      subtitle={
        emailKey
          ? `Sending as ${emailKey.senderName} <${emailKey.senderEmail}> with key ${emailKey.keyHint}`
          : 'Connect your own Resend account to send broadcasts'
      }
      icon={FileText}
      className="col-span-2 md:col-span-12"
    >
      <form action={save.formAction} className="grid gap-3 md:grid-cols-12">
        <div className="space-y-1.5 md:col-span-4">
          <Label htmlFor="email-key">Resend API key</Label>
          <Input
            id="email-key"
            name="apiKey"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={emailKey ? `Saved (${emailKey.keyHint}). Enter a key to replace it.` : 're_…'}
            aria-describedby="email-key-hint"
            required
          />
          <p id="email-key-hint" className="text-xs text-muted-foreground">
            Stored sealed on the server. It is never shown again, and emails are billed to your Resend account.
          </p>
        </div>
        <div className="space-y-1.5 md:col-span-4">
          <Label htmlFor="email-sender-name">Sender name</Label>
          <Input
            id="email-sender-name"
            name="senderName"
            placeholder="Rimba Ventures"
            defaultValue={emailKey?.senderName}
            maxLength={80}
            required
          />
        </div>
        <div className="space-y-1.5 md:col-span-4">
          <Label htmlFor="email-sender-email">Sender email</Label>
          <Input
            id="email-sender-email"
            name="senderEmail"
            type="email"
            placeholder="hello@yourdomain.com"
            defaultValue={emailKey?.senderEmail}
            aria-describedby="email-sender-hint"
            required
          />
          <p id="email-sender-hint" className="text-xs text-muted-foreground">
            On a domain you have verified with Resend.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" disabled={save.pending}>
            <Check className="size-4" />
            {save.pending ? 'Checking…' : 'Save settings'}
          </Button>
          <Button type="button" variant="outline" onClick={onClose} disabled={save.pending}>
            Close
          </Button>
          {save.error ? (
            <p role="alert" className="text-sm text-destructive">
              {save.error}
            </p>
          ) : null}
          {save.message ? (
            <p role="status" className="text-sm text-emerald-600">
              {save.message}
            </p>
          ) : null}
        </div>
      </form>
      {emailKey ? (
        <form action={remove.formAction} className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            Removing the key stops broadcasts from being sent. Broadcasts already sent are kept.
          </p>
          {remove.error ? (
            <p role="alert" className="text-sm text-destructive">
              {remove.error}
            </p>
          ) : null}
          <Button type="submit" variant="outline" size="sm" disabled={remove.pending}>
            <Trash2 className="size-4 text-destructive" />
            {remove.pending ? 'Removing…' : 'Remove key'}
          </Button>
        </form>
      ) : null}
    </BentoCard>
  );
}

/** Replaces a broadcast's row while asking whether to really send it. */
function SendBroadcastRow({
  broadcast,
  recipients,
  emailKey,
  testAddress,
  actions,
  colSpan,
  onClose,
}: {
  broadcast: Broadcast;
  /** How many it would go to as of this page; the server counts again when it sends. */
  recipients: number;
  emailKey: EmailKey;
  testAddress: string | null;
  actions: SendActions;
  colSpan: number;
  onClose: () => void;
}) {
  const send = useAnswer(actions.send);
  const test = useAnswer(actions.test);
  const tooMany = recipients > BROADCAST_RECIPIENTS_MAX;
  const busy = send.pending || test.pending;
  return (
    <TableRow className="bg-primary/5 hover:bg-primary/5">
      {/* Table cells do not wrap by default; a question this long has to. */}
      <TableCell colSpan={colSpan} className="whitespace-normal">
        <div className="space-y-3 py-2">
          <p className="text-sm">
            Send <span className="font-medium">{broadcast.name}</span> to about{' '}
            <span className="font-medium">{people(recipients)}</span> as {emailKey.senderName} &lt;
            {emailKey.senderEmail}&gt;? Each email carries an unsubscribe link. A send cannot be undone, and
            the broadcast cannot be edited or sent again afterwards.
          </p>
          {tooMany ? (
            <p className="text-sm text-destructive">
              A broadcast can go to at most {BROADCAST_RECIPIENTS_MAX} recipients. Narrow the audience first.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <form action={send.formAction}>
              <input type="hidden" name="broadcastId" value={broadcast.id} />
              {/* The version on screen: the server refuses to send any other. */}
              <input type="hidden" name="revision" value={broadcast.revision} />
              <Button type="submit" size="sm" disabled={busy || tooMany || recipients === 0}>
                <Send className="size-4" />
                {send.pending ? 'Sending…' : `Send to ${people(recipients)}`}
              </Button>
            </form>
            <form action={test.formAction}>
              <input type="hidden" name="broadcastId" value={broadcast.id} />
              <Button type="submit" variant="outline" size="sm" disabled={busy || !testAddress}>
                {test.pending ? 'Sending test…' : testAddress ? `Send a test to ${testAddress}` : 'Send a test to me'}
              </Button>
            </form>
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          </div>
          {send.error || test.error ? (
            <p role="alert" className="text-sm text-destructive">
              {send.error ?? test.error}
            </p>
          ) : null}
          {test.message ? (
            <p role="status" className="text-sm text-emerald-600">
              {test.message}
            </p>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

/** Replaces a broadcast's row while asking whether to finish or retry its send. */
function ResumeBroadcastRow({
  broadcast,
  action,
  colSpan,
  onClose,
}: {
  broadcast: Broadcast;
  action: CrmFormAction;
  colSpan: number;
  onClose: () => void;
}) {
  const resume = useAnswer(action);
  const interrupted = broadcast.status === 'sending';
  return (
    <TableRow className="bg-primary/5 hover:bg-primary/5">
      {/* Table cells do not wrap by default; a question this long has to. */}
      <TableCell colSpan={colSpan} className="whitespace-normal">
        <div className="space-y-3 py-2">
          <p className="text-sm">
            {interrupted ? (
              <>
                The send of <span className="font-medium">{broadcast.name}</span> was cut short. Finish it?
              </>
            ) : (
              <>
                Try again for the {people(broadcast.failedCount)} of{' '}
                <span className="font-medium">{broadcast.name}</span> that could not be sent?
              </>
            )}{' '}
            This repeats the original request to the email provider, which recognises what it has
            already sent, so people who received it should not get it again. It works for 23 hours after
            the first attempt, and only while the email settings are unchanged.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <form action={resume.formAction}>
              <input type="hidden" name="broadcastId" value={broadcast.id} />
              <Button type="submit" size="sm" disabled={resume.pending}>
                <RotateCcw className="size-4" />
                {resume.pending ? 'Sending…' : interrupted ? 'Finish sending' : 'Retry failed'}
              </Button>
            </form>
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={resume.pending}>
              Cancel
            </Button>
          </div>
          {resume.error ? (
            <p role="alert" className="text-sm text-destructive">
              {resume.error}
            </p>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

function BroadcastFormCard({
  action,
  editing,
  contacts,
  optedOut,
  tagOptions,
  onSaved,
  onClose,
}: {
  action: CrmFormAction;
  /** The broadcast being edited; null to write a new one. */
  editing: Broadcast | null;
  contacts: AudienceContact[];
  optedOut: ReadonlySet<string>;
  tagOptions: string[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const { onSubmit, pending, error } = useCrmForm(action, onSaved);
  // Held here so the recipient count follows the choices, and a rejected save keeps them.
  const [name, setName] = useState(editing?.name ?? '');
  const [subject, setSubject] = useState(editing?.subject ?? '');
  const [body, setBody] = useState(editing?.body ?? '');
  const [audience, setAudience] = useState<BroadcastAudience>(editing?.audience ?? { statuses: [], tags: [] });

  const recipients = useMemo(() => audienceFor(contacts, audience, optedOut), [contacts, audience, optedOut]);
  // A tag the broadcast was saved with stays ticked even if no contact carries it now.
  const tags = useMemo(() => {
    const known = new Set(tagOptions.map((tag) => tag.toLowerCase()));
    return [...tagOptions, ...audience.tags.filter((tag) => !known.has(tag.toLowerCase()))];
  }, [tagOptions, audience.tags]);

  const toggleStatus = (status: AudienceStatus) =>
    setAudience((current) => ({
      ...current,
      statuses: current.statuses.includes(status)
        ? current.statuses.filter((s) => s !== status)
        : [...current.statuses, status],
    }));
  const toggleTag = (tag: string) =>
    setAudience((current) => ({
      ...current,
      tags: current.tags.some((t) => t.toLowerCase() === tag.toLowerCase())
        ? current.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase())
        : [...current.tags, tag],
    }));

  return (
    <BentoCard
      title={editing ? 'Edit broadcast' : 'New broadcast'}
      subtitle={editing ? `Changing ${editing.name}` : 'Write a message and choose who it is for'}
      // The card's icon chip only draws icons from the animated set.
      icon={editing ? FileText : Plus}
      className="col-span-2 md:col-span-12"
    >
      <form onSubmit={onSubmit} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        {editing ? <input type="hidden" name="broadcastId" value={editing.id} /> : null}
        <div className="grid content-start gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="broadcast-name">Name</Label>
            <Input
              id="broadcast-name"
              name="name"
              placeholder="Raya promo, customers"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={BROADCAST_NAME_MAX}
              aria-describedby="broadcast-name-hint"
              autoFocus
              required
            />
            <p id="broadcast-name-hint" className="text-xs text-muted-foreground">
              Only you see this.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="broadcast-subject">Subject</Label>
            <Input
              id="broadcast-subject"
              name="subject"
              placeholder="Diskaun Raya untuk pelanggan setia"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              maxLength={BROADCAST_SUBJECT_MAX}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="broadcast-body">Message</Label>
            <Textarea
              id="broadcast-body"
              name="body"
              rows={8}
              placeholder="Write the message as plain text."
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={BROADCAST_BODY_MAX}
              required
            />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Button type="submit" className="w-full md:w-auto" disabled={pending}>
              {editing ? <Check className="size-4" /> : <Plus className="size-4" />}
              {pending ? 'Saving…' : editing ? 'Save changes' : 'Save broadcast'}
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
        </div>

        <div className="space-y-4">
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Status</legend>
            <p className="text-xs text-muted-foreground">Tick none for every status.</p>
            <ul className="space-y-1">
              {AUDIENCE_STATUSES.map((status) => (
                <li key={status}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="statuses"
                      value={status}
                      checked={audience.statuses.includes(status)}
                      onChange={() => toggleStatus(status)}
                      className="size-4 accent-primary"
                    />
                    {AUDIENCE_STATUS_LABELS[status]}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Tags</legend>
            {tags.length === 0 ? (
              <p className="text-xs text-muted-foreground">None of your contacts has a tag yet.</p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Tick none to ignore tags; otherwise a contact needs at least one.
                </p>
                <ul className="max-h-36 space-y-1 overflow-y-auto rounded-md border p-2">
                  {tags.map((tag) => (
                    <li key={tag}>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="tags"
                          value={tag}
                          checked={audience.tags.some((t) => t.toLowerCase() === tag.toLowerCase())}
                          onChange={() => toggleTag(tag)}
                          className="size-4 accent-primary"
                        />
                        <span className="min-w-0 truncate">{tag}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </fieldset>
          <div className="space-y-1.5 rounded-lg border bg-muted/40 p-3" aria-live="polite">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Users className="size-4" />
              {people(recipients.length)}
            </p>
            {recipients.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No contact matches. Archived contacts, contacts with no email and people who have
                unsubscribed are never included.
              </p>
            ) : (
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {recipients.slice(0, PREVIEW_LISTED).map((contact) => (
                  <li key={contact.id} className="truncate">
                    {contact.name} · {contact.email}
                  </li>
                ))}
                {recipients.length > PREVIEW_LISTED ? (
                  <li>and {(recipients.length - PREVIEW_LISTED).toLocaleString('en-MY')} more</li>
                ) : null}
              </ul>
            )}
          </div>
        </div>
      </form>
    </BentoCard>
  );
}

function DeleteBroadcastRow({
  broadcast,
  action,
  colSpan,
  onClose,
}: {
  broadcast: Broadcast;
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
          <input type="hidden" name="broadcastId" value={broadcast.id} />
          <p className="min-w-0 flex-1 text-sm">
            Delete <span className="font-medium">{broadcast.name}</span>? Its message is lost. Your contacts are
            not changed. This cannot be undone.
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="destructive" size="sm" disabled={pending}>
            <Trash2 className="size-4" />
            {pending ? 'Deleting…' : 'Delete broadcast'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
        </form>
      </TableCell>
    </TableRow>
  );
}

/** Kasturi's broadcasts, with the form to write and edit them. */
export function BroadcastsView({
  broadcasts,
  contacts,
  contactsComplete,
  optOuts,
  emailKey,
  testAddress,
  actions,
  keyActions,
  sendActions,
  retry,
}: {
  broadcasts: Broadcast[];
  contacts: AudienceContact[];
  /** False when the workspace has more contacts than an audience is worked out over. */
  contactsComplete: boolean;
  /** Addresses that have unsubscribed, lower case. */
  optOuts: string[];
  /** Null when the workspace has not connected an email key. */
  emailKey: EmailKey | null;
  /** Where "Send a test" goes: the signed-in person's own address. */
  testAddress: string | null;
  /** Present only when the signed-in person may change broadcasts. */
  actions?: Actions;
  /** Present only for an owner or admin. */
  keyActions?: KeyActions;
  sendActions?: SendActions;
  /** Whether each broadcast's send can be finished or retried, by id. */
  retry?: Record<string, RetryState>;
}) {
  // One thing is open at a time: a form, the settings, or a question about one row.
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Broadcast | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const optedOut = useMemo(() => new Set(optOuts), [optOuts]);
  const tagOptions = useMemo(() => audienceTagOptions(contacts), [contacts]);
  const everyone = useMemo(() => audienceFor(contacts, { statuses: [], tags: [] }, optedOut), [contacts, optedOut]);
  const rows = useMemo(
    () =>
      broadcasts.map((broadcast) => ({
        broadcast,
        recipients: audienceFor(contacts, broadcast.audience, optedOut),
      })),
    [broadcasts, contacts, optedOut],
  );
  const closeForm = () => {
    setAdding(false);
    setEditing(null);
  };
  const closeRows = () => {
    setDeletingId(null);
    setSendingId(null);
    setResumingId(null);
  };

  return (
    <ScreenContainer>
      <PageHeader
        title="Broadcast"
        subtitle="Write a message once for a chosen set of contacts, and send it by email."
        actions={
          <>
            {keyActions ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  closeForm();
                  closeRows();
                  setSettingsOpen((open) => !open);
                }}
              >
                <Settings className="size-4" />
                Email settings
              </Button>
            ) : null}
            {actions ? (
              <Button
                size="sm"
                onClick={() => {
                  setEditing(null);
                  closeRows();
                  setSettingsOpen(false);
                  setAdding(true);
                }}
              >
                <Plus className="size-4" />
                New broadcast
              </Button>
            ) : null}
          </>
        }
      />

      <BentoGrid>
        {keyActions && settingsOpen ? (
          <EmailSettingsCard emailKey={emailKey} actions={keyActions} onClose={() => setSettingsOpen(false)} />
        ) : null}
        {actions && (adding || editing) ? (
          <BroadcastFormCard
            // A fresh form for each broadcast, and for adding.
            key={editing?.id ?? 'new'}
            action={actions.save}
            editing={editing}
            contacts={contacts}
            optedOut={optedOut}
            tagOptions={tagOptions}
            onSaved={closeForm}
            onClose={closeForm}
          />
        ) : null}

        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Broadcasts"
            value={String(broadcasts.length)}
            delta={`${broadcasts.filter((broadcast) => broadcast.status === 'sent').length} sent`}
            onPrimary
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Contacts you can reach" value={everyone.length.toLocaleString('en-MY')} />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Emails sent"
            value={broadcasts.reduce((total, broadcast) => total + broadcast.sentCount, 0).toLocaleString('en-MY')}
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat label="Unsubscribed" value={optOuts.length.toLocaleString('en-MY')} />
        </BentoCard>

        <BentoCard
          title="My broadcasts"
          subtitle={
            emailKey
              ? `Sent as ${emailKey.senderName} <${emailKey.senderEmail}>`
              : keyActions
                ? 'To send by email, connect your Resend account under "Email settings".'
                : 'Email sending is not set up. Ask an owner or admin to connect it.'
          }
          icon={Megaphone}
          className="col-span-2 md:col-span-12"
        >
          {!contactsComplete ? (
            <p className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
              This workspace has more than {AUDIENCE_CONTACTS_MAX.toLocaleString('en-MY')} contacts. Recipient
              counts and exports cover the first {AUDIENCE_CONTACTS_MAX.toLocaleString('en-MY')} only.
            </p>
          ) : null}
          {broadcasts.length === 0 ? (
            <Muted>
              {contacts.length === 0 ? (
                <>
                  No broadcasts yet, and no contacts to write to.{' '}
                  <Link href="/crm/contacts" className="font-medium text-primary underline-offset-4 hover:underline">
                    Add contacts first
                  </Link>
                  .
                </>
              ) : actions ? (
                'No broadcasts yet. Choose "New broadcast" to write your first.'
              ) : (
                'No broadcasts yet.'
              )}
            </Muted>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Broadcast</TableHead>
                    <TableHead>Audience</TableHead>
                    <TableHead className="text-right">Recipients</TableHead>
                    <TableHead>Status</TableHead>
                    {/* Pinned to the right edge, so the buttons stay in reach when the table is wider than its card. */}
                    <TableHead className="sticky right-0 bg-muted text-right shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.2)]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(({ broadcast, recipients }) =>
                    actions && deletingId === broadcast.id ? (
                      <DeleteBroadcastRow
                        key={broadcast.id}
                        broadcast={broadcast}
                        action={actions.remove}
                        colSpan={5}
                        onClose={() => setDeletingId(null)}
                      />
                    ) : sendActions && emailKey && sendingId === broadcast.id && broadcast.status === 'draft' ? (
                      <SendBroadcastRow
                        key={broadcast.id}
                        broadcast={broadcast}
                        recipients={recipients.length}
                        emailKey={emailKey}
                        testAddress={testAddress}
                        actions={sendActions}
                        colSpan={5}
                        onClose={() => setSendingId(null)}
                      />
                    ) : sendActions && emailKey && resumingId === broadcast.id && retry?.[broadcast.id] === 'ready' ? (
                      <ResumeBroadcastRow
                        key={broadcast.id}
                        broadcast={broadcast}
                        action={sendActions.resume}
                        colSpan={5}
                        onClose={() => setResumingId(null)}
                      />
                    ) : (
                      <TableRow key={broadcast.id}>
                        <TableCell className="max-w-64">
                          <p className="truncate font-medium">{broadcast.name}</p>
                          <p className="truncate text-xs text-muted-foreground">{broadcast.subject}</p>
                        </TableCell>
                        <TableCell className="max-w-64 truncate">{audienceSummary(broadcast.audience)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {/* Once sent, who it went to is a record, not a rule worked out again. */}
                          {broadcast.status === 'draft'
                            ? recipients.length.toLocaleString('en-MY')
                            : (broadcast.sentCount + broadcast.failedCount).toLocaleString('en-MY')}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
                              // Green only when it reached everyone; some or all failing is not a plain "Sent".
                              broadcast.status === 'sent' && broadcast.failedCount === 0
                                ? 'bg-emerald-500/15 text-emerald-600'
                                : broadcast.status === 'sent' && broadcast.sentCount === 0
                                  ? 'bg-red-500/15 text-red-600'
                                  : broadcast.status === 'draft'
                                    ? 'bg-muted text-muted-foreground'
                                    : 'bg-amber-500/15 text-amber-600',
                            )}
                          >
                            {broadcast.status === 'sent' && broadcast.failedCount > 0
                              ? broadcast.sentCount === 0
                                ? 'Not sent'
                                : 'Partly sent'
                              : BROADCAST_STATUS_LABELS[broadcast.status]}
                          </span>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {broadcast.status === 'sent' && broadcast.sentDay
                              ? `${formatDay(broadcast.sentDay)} · ${broadcast.sentCount.toLocaleString('en-MY')} sent` +
                                (broadcast.failedCount > 0
                                  ? `, ${broadcast.failedCount.toLocaleString('en-MY')} failed`
                                  : '')
                              : broadcast.status === 'sending'
                                ? retry?.[broadcast.id] === 'wait'
                                  ? 'Sending now, or cut short a moment ago.'
                                  : retry?.[broadcast.id] === 'too-old'
                                    ? 'Cut short, and too old to finish safely.'
                                    : 'Cut short before it finished.'
                                : `Changed ${formatDay(broadcast.updatedDay)}`}
                            {broadcast.status === 'sent' && retry?.[broadcast.id] === 'too-old'
                              ? ' · too old to retry'
                              : ''}
                          </p>
                        </TableCell>
                        <TableCell className="sticky right-0 bg-card shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.2)]">
                          <div className="flex items-center justify-end gap-1">
                            <CopyMessageButton broadcast={broadcast} />
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Export the recipients of ${broadcast.name}`}
                              disabled={recipients.length === 0}
                              onClick={() => downloadCsv(broadcast.name, recipients)}
                            >
                              <Download className="size-4" />
                            </Button>
                            {sendActions && emailKey && retry?.[broadcast.id] === 'ready' ? (
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={
                                  broadcast.status === 'sending'
                                    ? `Finish sending ${broadcast.name}`
                                    : `Retry the failed recipients of ${broadcast.name}`
                                }
                                onClick={() => {
                                  closeForm();
                                  setSettingsOpen(false);
                                  closeRows();
                                  setResumingId(broadcast.id);
                                }}
                              >
                                <RotateCcw className="size-4 text-primary" />
                              </Button>
                            ) : null}
                            {sendActions && emailKey && broadcast.status === 'draft' ? (
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Send ${broadcast.name}`}
                                onClick={() => {
                                  closeForm();
                                  setSettingsOpen(false);
                                  setDeletingId(null);
                                  setSendingId(broadcast.id);
                                }}
                              >
                                <Send className="size-4 text-primary" />
                              </Button>
                            ) : null}
                            {actions ? (
                              <>
                                {broadcast.status === 'draft' ? (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Edit ${broadcast.name}`}
                                    onClick={() => {
                                      setAdding(false);
                                      closeRows();
                                      setSettingsOpen(false);
                                      setEditing(broadcast);
                                    }}
                                  >
                                    <Pencil className="size-4" />
                                  </Button>
                                ) : null}
                                {/* A sent broadcast is a record of who was emailed; it stays. */}
                                {broadcast.status === 'draft' ? (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Delete ${broadcast.name}`}
                                  onClick={() => {
                                    closeForm();
                                    setSendingId(null);
                                    setDeletingId(broadcast.id);
                                  }}
                                >
                                  <Trash2 className="size-4 text-destructive" />
                                </Button>
                                ) : null}
                              </>
                            ) : null}
                          </div>
                        </TableCell>
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
