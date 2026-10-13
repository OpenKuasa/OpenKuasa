'use client';

import { useState, useTransition } from 'react';
import { Dialog } from 'radix-ui';
import Link from 'next/link';
import { ExternalLink, Pencil, Plus, Trash2, UserPlus } from 'lucide-react';
import type { Channel, Lead, LeadChannel, LeadStage } from '@/lib/reach/types';
import {
  createLeadAction,
  deleteLeadAction,
  promoteLeadToContactAction,
  setLeadStageAction,
  updateLeadAction,
} from '@/app/(app)/reach/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

const CHANNELS: readonly Channel[] = ['whatsapp', 'facebook', 'instagram', 'tiktok'];
const STAGES: readonly LeadStage[] = ['lead', 'contacted', 'qualified', 'booked', 'won'];

const CHANNEL_LABEL: Record<LeadChannel, string> = {
  whatsapp: 'WhatsApp',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  web: 'Website',
};
const STAGE_LABEL: Record<LeadStage, string> = {
  lead: 'Lead',
  contacted: 'Contacted',
  qualified: 'Qualified',
  booked: 'Booked',
  won: 'Won',
};

type FormValues = {
  name: string;
  channel: Channel;
  stage: LeadStage;
  source: string;
};

type ActionResult = { ok: boolean; error?: string };

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function LeadFunnelTable({ leads, canEdit }: { leads: Lead[]; canEdit: boolean }) {
  const [pending, start] = useTransition();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Lead | null>(null);
  const [creating, setCreating] = useState(false);

  function act(p: Promise<ActionResult>) {
    start(async () => {
      const res = await p;
      setError(res.ok ? null : (res.error ?? 'Something went wrong.'));
      if (res.ok) {
        setEditing(null);
        setCreating(false);
      }
    });
  }

  const formOpen = canEdit && (creating || editing !== null);

  return (
    <div className="space-y-3">
      {canEdit && (
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setError(null);
              setCreating(true);
            }}
            disabled={pending}
          >
            <Plus className="size-4" />
            New Lead
          </Button>
        </div>
      )}
      {error && !formOpen && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>Name</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Created</TableHead>
              {canEdit && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="whitespace-nowrap font-medium">{l.name}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {CHANNEL_LABEL[l.channel] ?? l.channel}
                </TableCell>
                <TableCell>
                  {/* A Kasturi contact's stage is its status there, changed in Kasturi. */}
                  {canEdit && l.origin !== 'crm' ? (
                    <Select
                      value={l.stage}
                      disabled={pending}
                      onValueChange={(v) => {
                        if (v === l.stage) return;
                        act(setLeadStageAction({ id: l.id, stage: v as LeadStage }));
                      }}
                    >
                      <SelectTrigger
                        aria-label={`Stage for ${l.name}`}
                        size="sm"
                        className="w-32"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STAGES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {STAGE_LABEL[s]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-sm">{STAGE_LABEL[l.stage] ?? l.stage}</span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">{l.source || '—'}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {formatDate(l.created_at)}
                </TableCell>
                {canEdit && l.origin === 'crm' && (
                  <TableCell>
                    <div className="flex justify-end">
                      <Button asChild variant="ghost" size="sm">
                        <Link href="/crm/contacts">
                          <ExternalLink className="size-4" />
                          Open in Kasturi
                        </Link>
                      </Button>
                    </div>
                  </TableCell>
                )}
                {canEdit && l.origin !== 'crm' && (
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {l.promoted_contact_id ? (
                        <Button type="button" variant="ghost" size="sm" disabled>
                          Promoted ✓
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => act(promoteLeadToContactAction({ id: l.id }))}
                        >
                          <UserPlus className="size-4" />
                          Promote
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setError(null);
                          setEditing(l);
                        }}
                        disabled={pending}
                      >
                        <Pencil className="size-4" />
                        Edit
                      </Button>
                      {confirmingId === l.id ? (
                        <>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={pending}
                            onClick={() => {
                              setConfirmingId(null);
                              act(deleteLeadAction({ id: l.id }));
                            }}
                          >
                            <Trash2 className="size-4" />
                            Confirm?
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => setConfirmingId(null)}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          disabled={pending}
                          aria-label="Delete"
                          onClick={() => setConfirmingId(l.id)}
                        >
                          <Trash2 className="size-4" />
                          Delete
                        </Button>
                      )}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {leads.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={canEdit ? 6 : 5}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  No leads yet
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog.Root
        open={formOpen}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setCreating(false);
            setEditing(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-background p-5 shadow-lg outline-none">
            <Dialog.Title className="text-base font-semibold">
              {editing ? 'Edit lead' : 'New lead'}
            </Dialog.Title>
            <Dialog.Description className="mb-4 text-sm text-muted-foreground">
              {editing ? 'Update this lead’s details.' : 'Add a lead to your funnel.'}
            </Dialog.Description>
            {formOpen && (
              <LeadForm
                key={editing?.id ?? 'new'}
                initial={editing}
                disabled={pending}
                error={error}
                onCancel={() => {
                  setCreating(false);
                  setEditing(null);
                }}
                onSubmit={(values) =>
                  act(
                    editing
                      ? updateLeadAction({ id: editing.id, ...values })
                      : createLeadAction(values),
                  )
                }
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function LeadForm({
  initial,
  disabled,
  error,
  onCancel,
  onSubmit,
}: {
  initial: Lead | null;
  disabled: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (v: FormValues) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [channel, setChannel] = useState<Channel>(
    initial && initial.channel !== 'web' ? initial.channel : 'whatsapp',
  );
  const [stage, setStage] = useState<LeadStage>(initial?.stage ?? 'lead');
  const [source, setSource] = useState(initial?.source ?? '');

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name, channel, stage, source });
      }}
    >
      <Field label="Name">
        <Input
          aria-label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Channel">
          <Select value={channel} onValueChange={(v) => setChannel(v as Channel)}>
            <SelectTrigger aria-label="Channel" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHANNELS.map((ch) => (
                <SelectItem key={ch} value={ch}>
                  {CHANNEL_LABEL[ch]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Stage">
          <Select value={stage} onValueChange={(v) => setStage(v as LeadStage)}>
            <SelectTrigger aria-label="Stage" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STAGES.map((s) => (
                <SelectItem key={s} value={s}>
                  {STAGE_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label="Source">
        <Input aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)} />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={disabled}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={disabled}>
          Save
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
