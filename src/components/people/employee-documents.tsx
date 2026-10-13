'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { BellOff, BellRing, FilePen, Plus, Replace, Trash2 } from 'lucide-react';
import {
  addDocumentForAction,
  removeDocumentAction,
  replaceDocumentFileAction,
  requestDocumentAckAction,
  updateDocumentAction,
} from '@/app/(app)/people/document-actions';
import { Button } from '@/components/ui/button';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import type { EmployeeDocumentRow } from '@/lib/people/documents';
import { ackDetail, removeForSentence, requestAckSentence, withdrawAckSentence } from '@/lib/people/documents-screens';
import { DocumentDownload } from './document-download';
import { DocumentForm, type SaveDocument } from './document-form';

type Editing = { kind: 'add' } | { kind: 'edit' | 'replace'; id: string } | null;

/**
 * One employee's documents for an owner or admin (opened from the Employees screen): who uploaded each, whether it
 * was acknowledged, and Add document, Edit, Replace file, Remove (a second step) and Request / Withdraw. The
 * screen draws this only for an owner or admin outside the demo (`showsEmployeeDocumentsAction`); the actions and
 * the database check again. A refusal shows beside the control used. After a change the route is refreshed, so the
 * list (and the employee's own navigation count, when they next load a page) comes from the server.
 */
export function EmployeeDocuments({
  orgId,
  employeeId,
  name,
  rows,
}: {
  orgId: string;
  employeeId: string;
  name: string;
  rows: EmployeeDocumentRow[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<Editing>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  // Focus follows the Remove confirmation: to Keep when it opens, back to Remove when it is dismissed.
  const keepRef = useRef<HTMLButtonElement>(null);
  const removeRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const lastConfirmed = useRef<string | null>(null);
  useEffect(() => {
    if (confirming !== null) {
      lastConfirmed.current = confirming;
      keepRef.current?.focus();
    } else if (lastConfirmed.current !== null) {
      const id = lastConfirmed.current;
      lastConfirmed.current = null;
      removeRefs.current[id]?.focus();
    }
  }, [confirming]);

  const run = (id: string, call: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => {
    setError(null);
    start(async () => {
      try {
        const result = await call();
        if (result.ok) {
          after?.();
          router.refresh();
        } else setError({ id, text: result.error ?? WRITE_FAILED });
      } catch {
        setError({ id, text: WRITE_FAILED });
      }
    });
  };

  const saveFor =
    (mode: 'add' | 'edit' | 'replace', documentId?: string): SaveDocument =>
    (input) => {
      if (mode === 'add') return addDocumentForAction({ ...input, employee_id: employeeId });
      if (mode === 'edit') return updateDocumentAction({ ...input, document_id: documentId });
      return replaceDocumentFileAction({ ...input, document_id: documentId });
    };

  return (
    <div className="space-y-3">
      {editing?.kind === 'add' ? (
        <div className="rounded-lg border p-3">
          <DocumentForm
            mode="add"
            orgId={orgId}
            employeeId={employeeId}
            owner
            initial={null}
            save={saveFor('add')}
            onDone={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        </div>
      ) : (
        <Button type="button" size="sm" disabled={pending} onClick={() => setEditing({ kind: 'add' })}>
          <Plus aria-hidden />
          Add document for {name}
        </Button>
      )}
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">{name} has no documents yet.</p> : null}
      <ul className="space-y-3">
        {rows.map((row) => {
          const ack = ackDetail(row.ack_label);
          const details = [row.type_label, row.file_label ?? row.no_file_label, row.expiry_label, row.added_by_label].filter(
            (part): part is string => Boolean(part),
          );
          const here = editing && editing.kind !== 'add' && editing.id === row.id ? editing.kind : null;
          return (
            <li key={row.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{row.title}</p>
                  <p className="text-xs text-muted-foreground">{details.join(' · ')}</p>
                  {ack ? <p className="text-xs text-muted-foreground">{ack}</p> : null}
                </div>
                {row.expiry !== 'none' ? (
                  <span className="shrink-0 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-600">
                    {row.expiry === 'expired' ? 'Expired' : 'Expiring soon'}
                  </span>
                ) : null}
              </div>

              {here ? (
                <DocumentForm
                  key={`${row.id}-${here}`}
                  mode={here}
                  orgId={orgId}
                  employeeId={employeeId}
                  owner
                  initial={row}
                  save={saveFor(here, row.id)}
                  onDone={() => setEditing(null)}
                  onCancel={() => setEditing(null)}
                />
              ) : confirming === row.id ? (
                <div className="space-y-1.5">
                  <p className="text-xs">{removeForSentence(row.title)}</p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={pending}
                      onClick={() => run(row.id, () => removeDocumentAction({ document_id: row.id }), () => setConfirming(null))}
                    >
                      {pending ? 'Removing…' : 'Remove document'}
                    </Button>
                    <Button ref={keepRef} type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setConfirming(null)}>
                      Keep
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-1">
                  {row.can_download ? <DocumentDownload documentId={row.id} title={row.title} /> : null}
                  <Button type="button" variant="ghost" size="sm" disabled={pending} aria-label={`Edit ${row.title}`} onClick={() => setEditing({ kind: 'edit', id: row.id })}>
                    <FilePen aria-hidden />
                    Edit
                  </Button>
                  <Button type="button" variant="ghost" size="sm" disabled={pending} aria-label={`Replace the file of ${row.title}`} onClick={() => setEditing({ kind: 'replace', id: row.id })}>
                    <Replace aria-hidden />
                    Replace file
                  </Button>
                  {row.can_request_ack ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      aria-label={`Request acknowledgement of ${row.title}`}
                      aria-describedby={`ack-request-${row.id}`}
                      onClick={() => run(row.id, () => requestDocumentAckAction({ document_id: row.id, requested: true }))}
                    >
                      <BellRing aria-hidden />
                      Request acknowledgement
                    </Button>
                  ) : null}
                  {row.can_withdraw_ack ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      aria-label={`Withdraw the request on ${row.title}`}
                      aria-describedby={`ack-withdraw-${row.id}`}
                      onClick={() => run(row.id, () => requestDocumentAckAction({ document_id: row.id, requested: false }))}
                    >
                      <BellOff aria-hidden />
                      Withdraw request
                    </Button>
                  ) : null}
                  <Button
                    ref={(element) => {
                      removeRefs.current[row.id] = element;
                    }}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={pending}
                    aria-label={`Remove ${row.title}`}
                    onClick={() => {
                      setError(null);
                      setConfirming(row.id);
                    }}
                  >
                    <Trash2 aria-hidden />
                    Remove
                  </Button>
                </div>
              )}
              {!here && confirming !== row.id && row.can_request_ack ? (
                <p id={`ack-request-${row.id}`} className="text-xs text-muted-foreground">
                  {requestAckSentence(name)}
                </p>
              ) : null}
              {!here && confirming !== row.id && row.can_withdraw_ack ? (
                <p id={`ack-withdraw-${row.id}`} className="text-xs text-muted-foreground">
                  {withdrawAckSentence()}
                </p>
              ) : null}
              {error?.id === row.id ? (
                <p role="alert" className="text-xs text-destructive">
                  {error.text}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
