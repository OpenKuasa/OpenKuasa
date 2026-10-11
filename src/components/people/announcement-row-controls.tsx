'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import {
  deleteAnnouncementAction,
  publishAnnouncementAction,
  unpublishAnnouncementAction,
} from '@/app/(app)/people/announcement-actions';
import { Button } from '@/components/ui/button';
import { type CapResult, WRITE_FAILED } from '@/lib/people/capabilities';
import {
  deleteAnnouncementSentence,
  publishSentence,
  pullBackAnnouncementSentence,
} from '@/lib/people/reviews-announcements';
import { AnnouncementDialog, type EditableAnnouncement } from './announcement-form';
import { RowPrompt } from './request-row';

type Step = 'idle' | 'publishing' | 'pulling' | 'deleting';

async function settle<T>(call: () => Promise<CapResult<T>>): Promise<CapResult<T>> {
  try {
    return await call();
  } catch {
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * What an owner or admin can do with one announcement. A draft: Edit, Publish and Delete. A published one: Edit, Pull
 * back to draft and Delete. Publish, Pull back and Delete each take a second step that says what will happen. Every
 * button is disabled while a call is in flight and only the one pressed says "Working…". A refusal clears when the
 * question changes or the post changes state; pressing the button of a question already open leaves it open.
 */
export function AnnouncementRowControls({ announcement }: { announcement: EditableAnnouncement }) {
  const [pending, start] = useTransition();
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<Step | null>(null);
  const refocus = useRef<HTMLButtonElement | null>(null);
  const triggers = useRef<Partial<Record<Step, HTMLButtonElement | null>>>({});

  const key = `${announcement.id}:${announcement.draft}`;
  const [shownFor, setShownFor] = useState(key);
  if (shownFor !== key) {
    setShownFor(key);
    setStep('idle');
    setError(null);
    setWorking(null);
  }
  useEffect(() => {
    if (step !== 'idle' || pending || !refocus.current) return;
    refocus.current.focus();
    refocus.current = null;
  }, [step, pending]);

  const close = () => {
    refocus.current = step === 'idle' ? null : (triggers.current[step] ?? null);
    setStep('idle');
    setError(null);
  };
  const open = (next: Exclude<Step, 'idle'>) => {
    if (step === next) return;
    setError(null);
    setStep(next);
  };

  const sentence =
    step === 'publishing'
      ? publishSentence()
      : step === 'pulling'
        ? pullBackAnnouncementSentence()
        : step === 'deleting'
          ? deleteAnnouncementSentence(announcement.title)
          : '';

  function confirm() {
    const input = { announcement_id: announcement.id };
    const call =
      step === 'publishing'
        ? () => publishAnnouncementAction(input)
        : step === 'pulling'
          ? () => unpublishAnnouncementAction(input)
          : step === 'deleting'
            ? () => deleteAnnouncementAction(input)
            : null;
    if (!call) return;
    setError(null);
    setWorking(step);
    start(async () => {
      const result = await settle(call);
      setWorking(null);
      if (result.ok) {
        refocus.current = null;
        setStep('idle');
      } else setError(result.error);
    });
  }

  const trigger = (which: Exclude<Step, 'idle'>, label: string, name: string) => (
    <Button
      key={which}
      ref={(node) => {
        triggers.current[which] = node;
      }}
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      aria-expanded={step === which}
      aria-label={name}
      onClick={() => open(which)}
    >
      {label}
    </Button>
  );

  const confirmLabel = step === 'publishing' ? 'Publish' : step === 'pulling' ? 'Pull back' : 'Delete';

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <AnnouncementDialog announcement={announcement} />
        {announcement.draft
          ? trigger('publishing', 'Publish', `Publish ${announcement.title}`)
          : trigger('pulling', 'Pull back to draft', `Pull ${announcement.title} back to draft`)}
        {trigger('deleting', 'Delete', `Delete ${announcement.title}`)}
      </div>
      {step !== 'idle' ? (
        <RowPrompt focusKey={step} onEscape={close}>
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm">
              {sentence}
            </p>
            <Button
              type="button"
              size="sm"
              variant={step === 'deleting' ? 'destructive' : 'default'}
              disabled={pending}
              onClick={confirm}
            >
              {pending && working === step ? 'Working…' : confirmLabel}
            </Button>
            <Button type="button" variant="ghost" size="sm" data-autofocus disabled={pending} onClick={close}>
              Keep
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </RowPrompt>
      ) : null}
    </div>
  );
}
