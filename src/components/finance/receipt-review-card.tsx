'use client';

import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { canPreview, isHeif } from '@/lib/finance/receipt-files';
import {
  INBOX_READING_FAILED_REVIEW,
  type ReceiptLink,
  type ReceiptReviewForm,
  escapeClosesCard,
  reviewFormInput,
  reviewFormOf,
  reviewFormProblem,
} from '@/lib/finance/receipt-inbox';
import { INBOX_READING_NOTES, INBOX_TYPE_LABELS, fileSizeLabel, inboxReadingNote } from '@/lib/finance/receipt-views';
import type { InboxReceiptRow } from '@/lib/finance/receipts';
import type { FinResult } from '@/lib/finance/result';
import { previewUrlOf } from './receipt-upload';
import { useReceiptDownload } from './use-receipt-download';

export type ReviewReceipt = (input: unknown) => Promise<FinResult<{ id: string }>>;
export type ReceiptLinkOf = (input: unknown) => Promise<FinResult<ReceiptLink>>;

type Preview = { state: 'loading' } | { state: 'shown'; url: string } | { state: 'none'; why: string };

const NO_PREVIEW = 'The preview could not be shown. Download the file to view it.';

/**
 * The picture of a JPG or PNG receipt. The browser fetches the file through a
 * one-minute link, checks its first bytes, and draws its own copy: the image
 * element is never pointed at the stored file.
 */
function ReceiptPreview({ row, linkOf }: { row: InboxReceiptRow; linkOf: ReceiptLinkOf }) {
  const [preview, setPreview] = useState<Preview>({ state: 'loading' });
  // A page refresh hands down a new function each time; the picture must not be fetched again for that.
  const link = useRef(linkOf);
  useEffect(() => {
    link.current = linkOf;
  });

  useEffect(() => {
    let made: string | null = null;
    let left = false;
    // Closing the card, or opening another receipt, stops a fetch still in flight.
    const stop = new AbortController();
    void (async () => {
      let next: Preview = { state: 'none', why: NO_PREVIEW };
      try {
        const answer = await link.current({ id: row.id });
        if (!answer.ok) next = { state: 'none', why: answer.error };
        else if (answer.data.preview) {
          const url = await previewUrlOf(answer.data.url, answer.data.type, stop.signal);
          if (url) {
            made = url;
            next = { state: 'shown', url };
          }
        }
      } catch {
        // The sentence above stands.
      }
      if (left) {
        if (made) URL.revokeObjectURL(made);
        return;
      }
      setPreview(next);
    })();
    return () => {
      left = true;
      stop.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [row.id]);

  if (preview.state === 'shown') {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- an object URL of bytes this page fetched and checked; next/image cannot take one.
      <img src={preview.url} alt="The uploaded receipt" className="max-h-96 w-full rounded-lg border bg-muted object-contain" />
    );
  }
  return (
    <p className="grid min-h-24 place-items-center rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
      {preview.state === 'loading' ? 'Loading the preview…' : preview.why}
    </p>
  );
}

/**
 * The review card: the receipt's file beside the four details a person types
 * (vendor, date, amount with its SST inside it, SST). Saving takes a receipt
 * out of "To review". Every box may be left empty. A PDF and a stored HEIC
 * are not previewed: they are downloads.
 */
export function ReceiptReviewCard({
  row,
  today,
  review,
  linkOf,
  blocked,
  onClose,
  onSaved,
}: {
  row: InboxReceiptRow;
  /** Why this receipt can no longer be saved (someone else deleted or matched it), or null. The card stays, with what was typed. */
  blocked: string | null;
  /** The person's own date: a receipt is not dated after it. */
  today: string;
  review: ReviewReceipt;
  linkOf: ReceiptLinkOf;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const id = useId();
  const [form, setForm] = useState<ReceiptReviewForm>(() => reviewFormOf(row));
  const save = useFinanceAction();
  const download = useReceiptDownload(linkOf);
  const note = inboxReadingNote(row);

  const edit = (change: Partial<ReceiptReviewForm>) => {
    save.clear();
    setForm((f) => ({ ...f, ...change }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    // Handled here rather than as a form action, so a refused form keeps what was typed.
    event.preventDefault();
    if (blocked) return;
    const problem = reviewFormProblem(row.id, form, today);
    if (problem) {
      save.fail(problem);
      return;
    }
    save.run(
      () => review(reviewFormInput(row.id, form)),
      (saved) => onSaved(saved.id),
    );
  };


  return (
    <BentoCard
      title={row.status === 'review' ? 'Review receipt' : 'Edit receipt details'}
      subtitle="Type what the receipt shows. Leave a box empty if it does not say."
      icon={FileText}
      className="col-span-2 md:col-span-12"
    >
      <div
        role="group"
        aria-label="Review receipt"
        className="grid gap-4 md:grid-cols-12"
        // Only an Escape pressed inside the card closes it: the page's search box keeps its own.
        onKeyDown={(event) => {
          if (!escapeClosesCard({ key: event.key, keyCode: event.keyCode, isComposing: event.nativeEvent.isComposing }, save.pending)) return;
          event.stopPropagation();
          onClose();
        }}
      >
        <div className="space-y-2 md:col-span-5">
          <div>
            <p className="whitespace-normal break-words text-sm font-medium">{row.file_name}</p>
            <p className="text-xs text-muted-foreground">
              {row.has_file ? `${INBOX_TYPE_LABELS[row.mime_type]} · ${fileSizeLabel(row.size_bytes)}` : 'Sample receipt, no file'}
            </p>
          </div>
          {row.has_file ? (
            <>
              {canPreview(row.mime_type) ? (
                <ReceiptPreview row={row} linkOf={linkOf} />
              ) : (
                <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                  {isHeif(row.mime_type)
                    ? 'A HEIC photo cannot be shown in the browser. Download it to view it.'
                    : 'A PDF is not shown here. Download it to view it.'}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" size="sm" onClick={() => void download.start(row.id, row.file_name)} disabled={download.busyWith !== null}>
                  <Download className="size-4" />
                  {download.busyWith !== null ? 'Preparing…' : canPreview(row.mime_type) ? 'Download' : 'Download to view'}
                </Button>
                {download.error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {download.error}
                  </p>
                ) : null}
              </div>
            </>
          ) : null}
        </div>

        <form onSubmit={submit} noValidate className="grid content-start gap-3 md:col-span-7 md:grid-cols-6">
          {note ? (
            <p className="text-sm text-muted-foreground md:col-span-6">
              {note === 'failed' ? INBOX_READING_FAILED_REVIEW : INBOX_READING_NOTES[note]}
            </p>
          ) : null}
          <div className="space-y-1.5 md:col-span-6">
            <Label htmlFor={`${id}-vendor`}>Vendor</Label>
            <Input
              id={`${id}-vendor`}
              value={form.vendor}
              maxLength={200}
              autoComplete="off"
              placeholder="Who was paid"
              autoFocus
              data-finance-focus
              onChange={(e) => edit({ vendor: e.target.value })}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor={`${id}-date`}>Receipt date</Label>
            <Input id={`${id}-date`} type="date" max={today} value={form.date} onChange={(e) => edit({ date: e.target.value })} />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor={`${id}-amount`}>Amount (RM), SST included</Label>
            {/* A text box, not a number box: a number box hands back nothing at all for "1,200.50", and an empty amount is allowed here. */}
            <Input
              id={`${id}-amount`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              className="text-right tabular-nums"
              value={form.amount}
              onChange={(e) => edit({ amount: e.target.value })}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor={`${id}-sst`}>SST (RM)</Label>
            <Input
              id={`${id}-sst`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              className="text-right tabular-nums"
              value={form.sst}
              onChange={(e) => edit({ sst: e.target.value })}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3 md:col-span-6">
            <Button type="submit" size="sm" disabled={save.pending || blocked !== null}>
              {save.pending ? 'Saving…' : row.status === 'review' ? 'Save and mark reviewed' : 'Save'}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={save.pending}>
              {blocked ? 'Close' : 'Cancel'}
            </Button>
            {(blocked ?? save.error) ? (
              <p role="alert" className="text-sm text-destructive">
                {blocked ?? save.error}
              </p>
            ) : null}
          </div>
        </form>
      </div>
    </BentoCard>
  );
}
