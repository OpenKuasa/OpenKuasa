'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { FileText, Trash2 } from 'lucide-react';
import { removeMyDocumentAction } from '@/app/(app)/people/document-actions';
import { Button } from '@/components/ui/button';
import { LiveDot } from '@/components/ui/live-dot';
import { TableCell, TableRow } from '@/components/ui/table';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import type { MyDocumentRow } from '@/lib/people/documents';
import { ackDetail, downloadSlot, myRowStatus, removeMineSentence } from '@/lib/people/documents-screens';
import { cn } from '@/lib/utils';
import { AcknowledgeButton } from './acknowledge-button';
import { DocumentDownload } from './document-download';

const TONE_CLASS = {
  good: 'bg-emerald-500/15 text-emerald-600',
  pending: 'bg-amber-500/15 text-amber-600',
  bad: 'bg-red-500/15 text-red-600',
  neutral: 'bg-muted text-muted-foreground',
} as const;

/**
 * One line of My Documents: a document, an issued letter or a paid payslip. What it offers is what the model said
 * (`can_download`, `can_acknowledge`, `can_remove`), all false in the sample company, where a document reads
 * "Sample document, no file". Remove is for the employee's own uploads only and takes a second step. Letters and
 * payslips link to the page where they live. This file names only the employee's own actions.
 */
export function DocumentRow({ row }: { row: MyDocumentRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Focus follows the Remove confirmation: to Keep when it opens, back to Remove when it is dismissed.
  const keepRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
    else if (wasConfirming.current) removeRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  const status = myRowStatus(row);
  const slot = downloadSlot(row);
  const ack = ackDetail(row.acknowledged_label, row.awaiting_acknowledgement);
  const details = [row.file_label, row.expiry_label, row.added_by_label].filter((part): part is string => Boolean(part));

  const remove = () => {
    setError(null);
    start(async () => {
      try {
        const result = await removeMyDocumentAction({ document_id: row.id });
        if (result.ok) {
          setConfirming(false);
          router.refresh();
        } else setError(result.error);
      } catch {
        setError(WRITE_FAILED);
      }
    });
  };

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <FileText className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium">{row.title}</span>
              {row.awaiting_acknowledgement ? <LiveDot active /> : null}
            </span>
            {details.length > 0 ? <p className="truncate text-xs text-muted-foreground">{details.join(' · ')}</p> : null}
            {ack ? <p className="text-xs text-muted-foreground">{ack}</p> : null}
          </div>
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">{row.type_label}</TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">{row.date_label}</TableCell>
      <TableCell>
        <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', TONE_CLASS[status.tone])}>
          {status.label}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex flex-col items-end gap-1.5">
          {row.can_acknowledge ? <AcknowledgeButton id={row.id} kind={row.kind === 'letter' ? 'letter' : 'document'} /> : null}
          {slot === 'download' ? <DocumentDownload documentId={row.id} title={row.title} /> : null}
          {slot === 'no-file' ? <span className="text-xs text-muted-foreground">{row.no_file_label}</span> : null}
          {row.href ? (
            <Link href={row.href} className="text-sm text-primary underline-offset-4 hover:underline">
              {row.kind === 'letter' ? 'Open in Letters' : 'Open in My Payslips'}
            </Link>
          ) : null}
          {row.can_remove ? (
            confirming ? (
              <div className="flex flex-col items-end gap-1">
                <p className="max-w-56 text-xs">{removeMineSentence(row.title)}</p>
                <div className="flex gap-1">
                  <Button type="button" variant="destructive" size="sm" disabled={pending} onClick={remove}>
                    {pending ? 'Removing…' : 'Remove'}
                  </Button>
                  <Button ref={keepRef} type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setConfirming(false)}>
                    Keep
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                ref={removeRef}
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={pending}
                aria-label={`Remove ${row.title}`}
                onClick={() => {
                  setError(null);
                  setConfirming(true);
                }}
              >
                <Trash2 aria-hidden />
                Remove
              </Button>
            )
          ) : null}
          {error ? (
            <p role="alert" className="max-w-56 text-right text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}
