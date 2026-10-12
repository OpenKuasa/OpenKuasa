'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Check, Copy, Download, FileText, Megaphone, Pencil, Plus, Trash2, Users } from 'lucide-react';
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
} from '@/lib/crm/broadcasts';
import { formatDay } from '@/lib/crm/deal-stats';
import type { CrmFormAction } from '@/lib/crm/form-state';
import { useCrmForm } from './crm-form';

type Actions = { save: CrmFormAction; remove: CrmFormAction };

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

function BroadcastFormCard({
  action,
  editing,
  contacts,
  tagOptions,
  onSaved,
  onClose,
}: {
  action: CrmFormAction;
  /** The broadcast being edited; null to write a new one. */
  editing: Broadcast | null;
  contacts: AudienceContact[];
  tagOptions: string[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const { formAction, pending, error } = useCrmForm(action, onSaved);
  // Held here so the recipient count follows the choices, and a rejected save keeps them.
  const [name, setName] = useState(editing?.name ?? '');
  const [subject, setSubject] = useState(editing?.subject ?? '');
  const [body, setBody] = useState(editing?.body ?? '');
  const [audience, setAudience] = useState<BroadcastAudience>(editing?.audience ?? { statuses: [], tags: [] });

  const recipients = useMemo(() => audienceFor(contacts, audience), [contacts, audience]);
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
      <form action={formAction} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
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
                No contact matches. Archived contacts and contacts with no email are never included.
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
      <TableCell colSpan={colSpan}>
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
  actions,
}: {
  broadcasts: Broadcast[];
  contacts: AudienceContact[];
  /** False when the workspace has more contacts than an audience is worked out over. */
  contactsComplete: boolean;
  /** Present only when the signed-in person may change broadcasts. */
  actions?: Actions;
}) {
  // One thing is open at a time: the form, or a delete question.
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Broadcast | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const tagOptions = useMemo(() => audienceTagOptions(contacts), [contacts]);
  const everyone = useMemo(() => audienceFor(contacts, { statuses: [], tags: [] }), [contacts]);
  const rows = useMemo(
    () => broadcasts.map((broadcast) => ({ broadcast, recipients: audienceFor(contacts, broadcast.audience) })),
    [broadcasts, contacts],
  );
  const closeForm = () => {
    setAdding(false);
    setEditing(null);
  };

  return (
    <ScreenContainer>
      <PageHeader
        title="Broadcast"
        subtitle="Write a message once for a chosen set of contacts."
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
              New broadcast
            </Button>
          ) : null
        }
      />

      <BentoGrid>
        {actions && (adding || editing) ? (
          <BroadcastFormCard
            // A fresh form for each broadcast, and for adding.
            key={editing?.id ?? 'new'}
            action={actions.save}
            editing={editing}
            contacts={contacts}
            tagOptions={tagOptions}
            onSaved={closeForm}
            onClose={closeForm}
          />
        ) : null}

        <BentoCard tone="primary" className="col-span-1 md:col-span-4">
          <BentoStat label="Broadcasts" value={String(broadcasts.length)} delta="drafts" onPrimary />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-4">
          <BentoStat label="Contacts you can reach" value={everyone.length.toLocaleString('en-MY')} />
        </BentoCard>
        <BentoCard className="col-span-2 md:col-span-4">
          <BentoStat label="Tags in use" value={String(tagOptions.length)} />
        </BentoCard>

        <BentoCard
          title="My broadcasts"
          subtitle="Sending is not connected yet: export the recipients or copy the message."
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
                    <TableHead className="whitespace-nowrap">Last changed</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
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
                    ) : (
                      <TableRow key={broadcast.id}>
                        <TableCell className="max-w-64">
                          <p className="truncate font-medium">{broadcast.name}</p>
                          <p className="truncate text-xs text-muted-foreground">{broadcast.subject}</p>
                        </TableCell>
                        <TableCell className="max-w-64 truncate">{audienceSummary(broadcast.audience)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {recipients.length.toLocaleString('en-MY')}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatDay(broadcast.updatedDay)}
                        </TableCell>
                        <TableCell>
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
                            {actions ? (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Edit ${broadcast.name}`}
                                  onClick={() => {
                                    setAdding(false);
                                    setDeletingId(null);
                                    setEditing(broadcast);
                                  }}
                                >
                                  <Pencil className="size-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Delete ${broadcast.name}`}
                                  onClick={() => {
                                    closeForm();
                                    setDeletingId(broadcast.id);
                                  }}
                                >
                                  <Trash2 className="size-4 text-destructive" />
                                </Button>
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
