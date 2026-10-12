import { SetNavBadge } from '@/components/app/nav-badges-context';
import { getViewer } from '@/lib/auth/viewer';
import { unreadAnnouncements } from '@/lib/people/announcement-writes';
import { awaitingAcknowledgementCount } from '@/lib/people/awaiting-count';
import { shouldReadAwaiting } from '@/lib/people/documents-screens';
import { shouldReadUnread } from '@/lib/people/reviews-announcements';
import { createClient } from '@/lib/supabase/server';

/**
 * Every Lekiu page. It reads the signed-in person's unread announcements and the count of their documents and
 * letters awaiting acknowledgement, only for a member of a real workspace and only here, so other products' pages
 * never pay for it. Both are read on every request and never cached across people. Each reader never throws (0 on
 * any failure); the guard keeps even a surprise from breaking a page. The counts reach the sidebar after hydration
 * and return to 0 when the person leaves Lekiu.
 */
export default async function PeopleLayout({ children }: { children: React.ReactNode }) {
  let unread = 0;
  let awaiting = 0;
  try {
    const viewer = await getViewer();
    const readUnread = shouldReadUnread({ isDemo: viewer.isDemo, orgId: viewer.orgId });
    const readAwaiting = shouldReadAwaiting({ isDemo: viewer.isDemo, orgId: viewer.orgId });
    if (readUnread || readAwaiting) {
      const client = await createClient();
      const ctx = { client, orgId: viewer.orgId };
      [unread, awaiting] = await Promise.all([
        readUnread ? unreadAnnouncements(ctx) : 0,
        readAwaiting ? awaitingAcknowledgementCount(ctx, viewer.userId) : 0,
      ]);
    }
  } catch {
    unread = 0;
    awaiting = 0;
  }
  return (
    <>
      <SetNavBadge name="unreadAnnouncements" value={unread} />
      <SetNavBadge name="awaitingAcknowledgement" value={awaiting} />
      {children}
    </>
  );
}
