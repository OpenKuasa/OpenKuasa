'use client';

import { type DragEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Camera, CircleAlert, CircleCheck, FolderOpen, LoaderCircle, Plus, RotateCcw, X } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { Button } from '@/components/ui/button';
import {
  RECEIPT_FILE_MESSAGES,
  UPLOAD_STEP_LABELS,
  type UploadItem,
  queueAdd,
  queueBusy,
  queueNext,
  queueSet,
  queueSummary,
  queueWithoutDone,
  retryPlan,
  tooManyLeftOut,
} from '@/lib/finance/receipt-files';
import { RECEIPT_INBOX_MESSAGES } from '@/lib/finance/receipt-inbox';
import { fileSizeLabel } from '@/lib/finance/receipt-views';
import type { FinResult } from '@/lib/finance/result';
import { cn } from '@/lib/utils';
import { prepareReceipt, storeReceipt } from './receipt-upload';

export type RegisterReceipt = (input: unknown) => Promise<FinResult<{ id: string }>>;

/** What the file picker offers. What a file really is, is read from its bytes afterwards. */
const BROWSE_ACCEPT = 'image/jpeg,image/png,application/pdf,image/heic,image/heif,.jpg,.jpeg,.png,.pdf,.heic,.heif';

/**
 * The upload area: drop files, browse for them, or take a photo on a phone.
 * Files are worked through one at a time, each with its own state and its own
 * sentence when it fails: checked, converted from HEIC when the browser can,
 * uploaded straight to the private bucket, then added to the inbox by the
 * server. A file that was uploaded but not added is retried without being
 * uploaded again. Drawn only for someone who may add receipts.
 */
export function ReceiptUploadCard({
  orgId,
  register,
  onAdded,
}: {
  /** The workspace whose folder the files go into. From the server, never typed. */
  orgId: string;
  register: RegisterReceipt;
  /** Told the id of each receipt as it is added. */
  onAdded: (id: string) => void;
}) {
  const id = useId();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  /** The picked files, by queue key. Kept out of state: a File is not something to compare or copy. */
  const files = useRef(new Map<string, File>());
  const running = useRef(false);
  const browse = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);

  /** The queue as it is this instant; the state follows it. The loop below reads this, not a render's copy. */
  const queue = useRef<UploadItem[]>([]);
  const update = useCallback((change: (current: UploadItem[]) => UploadItem[]) => {
    queue.current = change(queue.current);
    setItems(queue.current);
  }, []);
  const patch = useCallback(
    (key: string, change: Partial<Omit<UploadItem, 'key'>>) => update((current) => queueSet(current, key, change)),
    [update],
  );

  const work = useCallback(
    async (item: UploadItem) => {
      const file = files.current.get(item.key);
      if (!file) {
        patch(item.key, { step: 'failed', error: RECEIPT_FILE_MESSAGES.unreadable });
        return;
      }
      let path = item.path;
      let name = item.name;
      if (retryPlan(item, Date.now()) === 'upload') {
        patch(item.key, { step: 'checking', error: null, path: null, storedAt: null });
        const prepared = await prepareReceipt(file, () => patch(item.key, { step: 'converting' }));
        if (!prepared.ok) {
          patch(item.key, { step: 'failed', error: prepared.error });
          return;
        }
        name = prepared.data.name;
        // The size shown from here on is the file that goes up: a converted JPG is usually larger than the HEIC it came from.
        patch(item.key, { step: 'uploading', name, size: prepared.data.body.size });
        const stored = await storeReceipt(orgId, prepared.data);
        if (!stored.ok) {
          patch(item.key, { step: 'failed', error: stored.error });
          return;
        }
        path = stored.path;
        patch(item.key, { step: 'saving', path, storedAt: Date.now() });
      } else {
        patch(item.key, { step: 'saving', error: null });
      }
      try {
        const saved = await register({ path, name });
        if (saved.ok) {
          files.current.delete(item.key);
          patch(item.key, { step: 'done', error: null });
          onAdded(saved.data.id);
          return;
        }
        // The database no longer takes this file: the next try uploads it again.
        const fileGone = saved.error === RECEIPT_INBOX_MESSAGES.fileGone;
        patch(item.key, { step: 'failed', error: saved.error, ...(fileGone ? { path: null, storedAt: null } : {}) });
      } catch {
        // The answer was lost. The file is in the bucket; trying again adds it, or finds it already added.
        patch(item.key, { step: 'failed', error: RECEIPT_FILE_MESSAGES.notSaved });
      }
    },
    [orgId, register, onAdded, patch],
  );

  /** Works through the waiting files, one at a time. Called whenever one is added or sent round again. */
  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (let next = queueNext(queue.current); next; next = queueNext(queue.current)) await work(next);
    } finally {
      running.current = false;
    }
  }, [work]);

  const add = (picked: File[]) => {
    if (picked.length === 0) return;
    const entries = picked.map((file) => ({ key: crypto.randomUUID(), file }));
    const next = queueAdd(
      queue.current,
      entries.map((e) => ({ key: e.key, name: e.file.name, size: e.file.size })),
    );
    const kept = new Set(next.items.map((i) => i.key));
    for (const e of entries) if (kept.has(e.key)) files.current.set(e.key, e.file);
    setNotice(next.refused > 0 ? tooManyLeftOut(next.refused) : null);
    update(() => next.items);
    void pump();
  };

  const retry = (key: string) => {
    patch(key, { step: 'waiting', error: null });
    void pump();
  };

  // Leaving while a file is on its way loses it: the browser asks first.
  const busy = queueBusy(items) || items.some((i) => i.step === 'waiting');
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    add(Array.from(event.dataTransfer.files));
  };

  const remove = (key: string) => {
    files.current.delete(key);
    update((current) => current.filter((i) => i.key !== key));
  };

  const summary = queueSummary(items);
  const anyDone = items.some((i) => i.step === 'done');

  return (
    <BentoCard
      title="Add receipts"
      subtitle="JPG, PNG, PDF or HEIC, up to 10 MB each"
      icon={Plus}
      className="col-span-2 md:col-span-12"
    >
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={cn(
          'flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-6 text-center transition-colors',
          over ? 'border-primary bg-primary/5' : 'border-border',
        )}
      >
        <p className="text-sm text-muted-foreground">Drop receipts here, or choose them from your device.</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" size="sm" onClick={() => browse.current?.click()}>
            <FolderOpen className="size-4" />
            Browse files
          </Button>
          {/* A phone opens its camera for this one; a computer would only open the same file picker, so it is not drawn there. */}
          <Button type="button" size="sm" variant="outline" className="md:hidden" onClick={() => camera.current?.click()}>
            <Camera className="size-4" />
            Take photo
          </Button>
        </div>
        <input
          ref={browse}
          id={`${id}-browse`}
          type="file"
          multiple
          accept={BROWSE_ACCEPT}
          aria-label="Choose receipt files"
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            add(Array.from(event.target.files ?? []));
            // So the same file can be chosen again after a failure.
            event.target.value = '';
          }}
        />
        <input
          ref={camera}
          id={`${id}-camera`}
          type="file"
          accept="image/*"
          capture="environment"
          aria-label="Take a photo of a receipt"
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            add(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      </div>

      {notice ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {notice}
        </p>
      ) : null}

      {items.length > 0 ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p role="status" aria-live="polite" className="text-sm font-medium">
              {summary}
            </p>
            {anyDone ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => update(queueWithoutDone)}>
                Clear finished
              </Button>
            ) : null}
          </div>
          <ul className="divide-y rounded-lg border">
            {items.map((item) => {
              const failed = item.step === 'failed';
              const done = item.step === 'done';
              const idle = failed || item.step === 'waiting';
              return (
                <li key={item.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2 text-sm">
                  <span className="mt-0.5 shrink-0">
                    {done ? (
                      <CircleCheck className="size-4 text-emerald-600" />
                    ) : failed ? (
                      <CircleAlert className="size-4 text-destructive" />
                    ) : (
                      <LoaderCircle className={cn('size-4 text-muted-foreground', item.step !== 'waiting' && 'animate-spin')} />
                    )}
                  </span>
                  <div className="min-w-40 flex-1">
                    <p className="whitespace-normal break-words font-medium">{item.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {fileSizeLabel(item.size)} · {UPLOAD_STEP_LABELS[item.step]}
                    </p>
                    {item.error ? (
                      <p role="alert" className="mt-1 whitespace-normal text-destructive">
                        {item.error}
                      </p>
                    ) : null}
                  </div>
                  {idle ? (
                    <div className="flex shrink-0 items-center gap-1">
                      {failed ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => retry(item.key)}
                        >
                          <RotateCcw className="size-4" />
                          Try again
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${item.name} from the list`}
                        onClick={() => remove(item.key)}
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </BentoCard>
  );
}
