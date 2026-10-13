'use client';

import { Paperclip } from 'lucide-react';
import type { ReceiptLink } from '@/lib/finance/receipt-inbox';
import type { AttachedReceipt } from '@/lib/finance/receipt-match';
import type { FinResult } from '@/lib/finance/result';
import { useReceiptDownload } from './use-receipt-download';

/** Makes a one-minute link to a receipt's file, for anyone who can see the receipt. */
export type AttachedReceiptLinkOf = (input: unknown) => Promise<FinResult<ReceiptLink>>;

/**
 * The receipts tied to one expense or one bill, drawn in that document's row:
 * a paperclip and the file's name for each. Pressing one downloads the file
 * the way the Receipts Inbox does: a one-minute link signed as the person,
 * handed out only after the server has read the file's first bytes, saved
 * from bytes this page fetched. Nothing is opened in the page. A file name is
 * whatever the uploader's device called the file, so it is only ever drawn as
 * text. A receipt with no file (the demo's samples), or a screen with no
 * database behind it, shows the name alone. Draws nothing for a document
 * with no receipt.
 */
export function AttachedReceipts({ receipts, linkOf }: { receipts: AttachedReceipt[] | undefined; linkOf?: AttachedReceiptLinkOf }) {
  const download = useReceiptDownload(async (input) => (linkOf ? linkOf(input) : { ok: false, error: '' }));
  if (!receipts || receipts.length === 0) return null;
  return (
    <div className="mt-1 space-y-0.5 text-xs font-normal text-muted-foreground">
      {receipts.map((receipt) =>
        linkOf && receipt.has_file ? (
          <button
            key={receipt.id}
            type="button"
            className="flex max-w-56 items-start gap-1 text-left underline-offset-2 hover:underline disabled:opacity-60"
            aria-label={`Download the receipt ${receipt.file_name}`}
            disabled={download.busyWith !== null}
            onClick={() => void download.start(receipt.id, receipt.file_name)}
          >
            <Paperclip className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span className="whitespace-normal break-words">{receipt.file_name}</span>
          </button>
        ) : (
          <p key={receipt.id} className="flex max-w-56 items-start gap-1">
            <Paperclip className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span className="whitespace-normal break-words">{receipt.file_name} (sample receipt, no file)</span>
          </p>
        ),
      )}
      {download.busyWith !== null ? <p role="status">Preparing the download…</p> : null}
      {download.error ? (
        <p role="alert" className="max-w-56 whitespace-normal text-destructive">
          {download.error}
        </p>
      ) : null}
    </div>
  );
}
