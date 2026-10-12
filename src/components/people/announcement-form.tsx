'use client';

import { Plus } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useId, useState, useTransition } from 'react';
import { saveAnnouncementAction } from '@/app/(app)/people/announcement-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { WRITE_FAILED } from '@/lib/people/capabilities';
import { ANNOUNCEMENT_CATEGORIES } from '@/lib/people/company';
import { ANNOUNCEMENT_BODY_MAX, ANNOUNCEMENT_TITLE_MAX, toAnnouncementInput } from '@/lib/people/performance-forms';
import { publishSentence } from '@/lib/people/reviews-announcements';

/** The announcement being edited. */
export type EditableAnnouncement = {
  id: string;
  title: string;
  body: string;
  category_key: string;
  draft: boolean;
};

const SELECT_CLASS =
  'h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30';

type Pressed = 'draft' | 'publish';

function AnnouncementFormBody({ announcement, onClose }: { announcement: EditableAnnouncement | null; onClose: () => void }) {
  const id = useId();
  const [title, setTitle] = useState(announcement?.title ?? '');
  const [body, setBody] = useState(announcement?.body ?? '');
  const [category, setCategory] = useState(announcement?.category_key ?? 'general');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // Which save button was pressed, so only that one says it is working.
  const [pressed, setPressed] = useState<Pressed | null>(null);
  // A published post stays published when it is saved; only a draft or a new post has the two choices.
  const published = announcement !== null && !announcement.draft;

  const clearing = <T,>(set: (value: T) => void) => (value: T) => {
    setError(null);
    set(value);
  };

  function save(publish: boolean) {
    const converted = toAnnouncementInput({ title, body, category });
    if (!converted.ok) {
      setError(converted.error);
      return;
    }
    setError(null);
    setPressed(publish ? 'publish' : 'draft');
    start(async () => {
      try {
        const result = await saveAnnouncementAction({
          ...(announcement ? { announcement_id: announcement.id } : {}),
          ...converted.input,
          publish,
        });
        if (result.ok) onClose();
        else setError(result.error);
      } catch {
        setError(WRITE_FAILED);
      } finally {
        setPressed(null);
      }
    });
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) save(false);
      }}
    >
      <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-title`}>
        Title
        <Input
          id={`${id}-title`}
          required
          maxLength={ANNOUNCEMENT_TITLE_MAX}
          disabled={pending}
          value={title}
          onChange={(event) => clearing(setTitle)(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-category`}>
        Category
        <select
          id={`${id}-category`}
          className={SELECT_CLASS}
          disabled={pending}
          value={category}
          onChange={(event) => clearing(setCategory)(event.target.value)}
        >
          {ANNOUNCEMENT_CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-body`}>
        Text
        <Textarea
          id={`${id}-body`}
          rows={6}
          maxLength={ANNOUNCEMENT_BODY_MAX}
          disabled={pending}
          value={body}
          onChange={(event) => clearing(setBody)(event.target.value)}
        />
      </label>
      {!published ? <p className="text-xs text-muted-foreground">Publishing: {publishSentence()}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        {published ? (
          <Button type="button" disabled={pending} onClick={() => save(false)}>
            {pending ? 'Working…' : 'Save changes'}
          </Button>
        ) : (
          <>
            <Button type="button" variant="outline" disabled={pending} onClick={() => save(false)}>
              {pending && pressed === 'draft' ? 'Working…' : 'Save as draft'}
            </Button>
            <Button type="button" disabled={pending} onClick={() => save(true)}>
              {pending && pressed === 'publish' ? 'Working…' : 'Publish'}
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

/** "New Announcement" (no `announcement`) or "Edit": a dialog around the form. Owners and admins outside the demo only. */
export function AnnouncementDialog({ announcement = null }: { announcement?: EditableAnnouncement | null }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        {announcement ? (
          <Button type="button" variant="outline" size="sm" aria-label={`Edit ${announcement.title}`}>
            Edit
          </Button>
        ) : (
          <Button type="button" size="sm">
            <Plus aria-hidden />
            New Announcement
          </Button>
        )}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-lg outline-none">
          <Dialog.Title className="text-base font-semibold">
            {announcement ? 'Edit announcement' : 'New Announcement'}
          </Dialog.Title>
          <Dialog.Description className="mb-4 text-sm text-muted-foreground">
            {announcement && !announcement.draft
              ? 'It stays published and is marked as edited.'
              : 'Save it as a draft to finish later, or publish it to your whole workspace.'}
          </Dialog.Description>
          <AnnouncementFormBody announcement={announcement} onClose={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
