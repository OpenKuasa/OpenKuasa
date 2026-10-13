'use client';

import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { useFinanceAction } from '@/components/finance/use-finance-action';
import { Button } from '@/components/ui/button';
import { escapeClosesCard } from '@/lib/finance/receipt-inbox';
import { RECEIPT_READING_MESSAGES, type ReceiptKeyState, type ReceiptRead, readingBlocker, readingQuestion } from '@/lib/finance/receipt-reading';
import type { InboxReceiptRow } from '@/lib/finance/receipts';
import type { FinResult } from '@/lib/finance/result';

/** What someone who may edit needs to have a receipt read: the action, and what the server knows before the press. */
export type ReceiptReadingData = {
  read: (input: unknown) => Promise<FinResult<ReceiptRead>>;
  /** Whether this server names a model for receipts. */
  setUp: boolean;
  /** Whether the workspace has an AI key of its own. */
  keyState: ReceiptKeyState;
  /** True for an owner or admin: they are pointed at the page where a key is added. */
  canManageKey: boolean;
};

/**
 * The question before a receipt is sent to a model: what is sent, to whom, on
 * whose key and credit, and what happens to what comes back. Nothing is sent
 * until "Send to be read" is pressed, and the card does nothing by itself: it
 * has no effect, and the action is called from that one button. When a
 * reading cannot start (no key, a stored HEIC, a server with no model for
 * receipts) the card says why in place of the question and has no send
 * button. A refusal from the server shows under the buttons and the card
 * stays. The file's name is whatever the uploader's device called it, so it
 * is drawn as text.
 */
export function ReceiptReadCard({
  row,
  reading,
  onClose,
  onRead,
  onRefused,
}: {
  row: InboxReceiptRow;
  reading: ReceiptReadingData;
  onClose: () => void;
  /** Told what was read once it is stored: the screen opens the review card on it. */
  onRead: (read: ReceiptRead) => void;
  /** Told what the server refused with (or that the answer was lost), so the screen can say it if this card has gone by then. */
  onRefused: (message: string) => void;
}) {
  const sending = useFinanceAction();
  const blocker = readingBlocker(row, reading);
  const again = row.extracted_at !== null || row.extraction_failed;

  // The one place a receipt is sent from: this button's press.
  const send = () => {
    sending.run(async () => {
      try {
        const result = await reading.read({ id: row.id });
        if (!result.ok) onRefused(result.error);
        return result;
      } catch {
        // The answer never came back: not a failed save. The file may have been sent, so it is not told as one.
        onRefused(RECEIPT_READING_MESSAGES.lostAnswer);
        return { ok: false as const, error: RECEIPT_READING_MESSAGES.lostAnswer };
      }
    }, onRead);
  };

  return (
    <BentoCard
      title="Read with AI"
      subtitle={<span className="block whitespace-normal break-words">Have a model fill in the vendor, date, amount and SST for you to check</span>}
      icon={Sparkles}
      className="col-span-2 md:col-span-12"
    >
      <div
        role="group"
        aria-label="Read receipt with AI"
        className="space-y-3"
        // Only an Escape pressed inside the card closes it, and never while a file is on its way.
        onKeyDown={(event) => {
          if (!escapeClosesCard({ key: event.key, keyCode: event.keyCode, isComposing: event.nativeEvent.isComposing }, sending.pending)) return;
          event.stopPropagation();
          onClose();
        }}
      >
        <p className="whitespace-normal break-words text-sm font-medium">{row.file_name}</p>
        {blocker ? (
          <p className="max-w-prose whitespace-normal break-words text-sm text-muted-foreground">
            {blocker.message}
            {blocker.link ? (
              <>
                {' '}
                <Link href="/account/ai" className="font-medium text-primary underline-offset-4 hover:underline">
                  Add an AI key
                </Link>
                , then choose Read with AI again.
              </>
            ) : null}
          </p>
        ) : (
          <div className="max-w-prose space-y-2 text-sm text-muted-foreground">
            {readingQuestion(row).map((line, i) => (
              <p key={line} className={i === 0 ? 'whitespace-normal break-words text-foreground' : 'whitespace-normal break-words'}>
                {line}
              </p>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {blocker ? (
            <Button type="button" variant="outline" size="sm" autoFocus data-finance-focus onClick={onClose}>
              Close
            </Button>
          ) : (
            <>
              <Button type="button" size="sm" disabled={sending.pending} onClick={send}>
                {sending.pending ? 'Reading…' : again ? 'Send to be read again' : 'Send to be read'}
              </Button>
              {/* Focus lands on Cancel, not on the button that sends: a key held down from the menu must not send a file. */}
              <Button type="button" variant="outline" size="sm" autoFocus data-finance-focus onClick={onClose} disabled={sending.pending}>
                Cancel
              </Button>
            </>
          )}
          {sending.pending ? (
            <p role="status" className="text-sm text-muted-foreground">
              The file is being read. This can take up to a minute, and other actions on this page may wait until it is done.
            </p>
          ) : null}
          {sending.error ? (
            <p role="alert" className="max-w-prose whitespace-normal break-words text-sm text-destructive">
              {sending.error}
            </p>
          ) : null}
        </div>
      </div>
    </BentoCard>
  );
}
