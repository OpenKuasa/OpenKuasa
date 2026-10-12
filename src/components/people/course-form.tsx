'use client';

import { useId, useState, useTransition } from 'react';
import { Dialog } from 'radix-ui';
import { Plus } from 'lucide-react';
import { saveTrainingAction } from '@/app/(app)/people/performance-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { COURSE_TAG_MAX, COURSE_TITLE_MAX, toTrainingInput } from '@/lib/people/performance-forms';

export type CourseValues = {
  id: string;
  title: string;
  category_value: string | null;
  provider: string | null;
  starts_on: string | null;
  ends_on: string | null;
};

/**
 * Add or edit a course (owners and admins): title, category and provider (optional), and both dates. A refusal
 * shows under the form and clears as soon as a field changes.
 */
export function CourseForm({
  initial,
  onDone,
  onCancel,
}: {
  initial: CourseValues | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [busy, start] = useTransition();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [category, setCategory] = useState(initial?.category_value ?? '');
  const [provider, setProvider] = useState(initial?.provider ?? '');
  const [startsOn, setStartsOn] = useState(initial?.starts_on ?? '');
  const [endsOn, setEndsOn] = useState(initial?.ends_on ?? '');
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const field = (set: (value: string) => void) => (event: { target: { value: string } }) => {
    setError(null);
    set(event.target.value);
  };

  function submit() {
    const converted = toTrainingInput({ title, category, provider, starts_on: startsOn, ends_on: endsOn });
    if (!converted.ok) {
      setError(converted.error);
      return;
    }
    setError(null);
    start(async () => {
      try {
        const result = await saveTrainingAction(initial ? { training_id: initial.id, ...converted.input } : converted.input);
        if (result.ok) onDone();
        else setError(result.error);
      } catch {
        setError(WRITE_FAILED);
      }
    });
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${ids}-title`}>
        Title
        <Input id={`${ids}-title`} data-autofocus autoFocus required maxLength={COURSE_TITLE_MAX} disabled={busy} value={title} onChange={field(setTitle)} />
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${ids}-category`}>
          Category (optional)
          <Input id={`${ids}-category`} maxLength={COURSE_TAG_MAX} className="w-44" disabled={busy} value={category} onChange={field(setCategory)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${ids}-provider`}>
          Provider (optional)
          <Input id={`${ids}-provider`} maxLength={COURSE_TAG_MAX} className="w-44" disabled={busy} value={provider} onChange={field(setProvider)} />
        </label>
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${ids}-start`}>
          First day
          <Input id={`${ids}-start`} type="date" required className="w-40" disabled={busy} value={startsOn} onChange={field(setStartsOn)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${ids}-end`}>
          Last day
          <Input id={`${ids}-end`} type="date" required className="w-40" disabled={busy} value={endsOn} onChange={field(setEndsOn)} />
        </label>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Working…' : initial ? 'Save course' : 'Add course'}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The "Add course" button and its dialog, for owners and admins. */
export function AddCourse() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button type="button" size="sm">
          <Plus aria-hidden />
          Add course
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg outline-none">
          <Dialog.Title className="text-base font-semibold">Add a course</Dialog.Title>
          <Dialog.Description className="mb-4 text-sm text-muted-foreground">
            Employees can enrol themselves until the last day.
          </Dialog.Description>
          <CourseForm initial={null} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
