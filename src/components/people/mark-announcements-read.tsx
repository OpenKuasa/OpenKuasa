'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { markAnnouncementsReadAction } from '@/app/(app)/people/announcement-actions';
import { markReadOnce } from '@/lib/people/reviews-announcements';

/**
 * Marks the signed-in person's unread announcements read, once, after the list has been drawn with its marks.
 * It runs in the browser (an effect), so a server render or a prefetch never marks anything; the page draws it only
 * for someone outside the demo with something unread. The call is made once per mount even though React runs
 * effects twice in development. When it succeeds the route is refreshed (a layout is not re-rendered by navigation, so this is what re-reads the navigation count); the marks
 * on the list stay for this view (see `UnreadMark`). A failure is silent: the marks simply stay unread.
 */
export function MarkAnnouncementsRead() {
  const router = useRouter();
  const fired = useRef(false);
  useEffect(() => {
    void markReadOnce(fired, () => markAnnouncementsReadAction(), () => router.refresh());
  }, [router]);
  return null;
}

/**
 * A post's "New" mark. It keeps what the server said when the post first appeared, so the refresh that follows
 * marking everything read does not wipe the marks before the person has looked at them.
 */
export function UnreadMark({ unread }: { unread: boolean }) {
  const [shown] = useState(unread);
  if (!shown) return null;
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold leading-none text-primary-foreground">
      New
    </span>
  );
}
