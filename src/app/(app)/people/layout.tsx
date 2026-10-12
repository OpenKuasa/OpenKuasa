import { SetNavBadge } from '@/components/app/nav-badges-context';
import { getViewer } from '@/lib/auth/viewer';
import { unreadAnnouncements } from '@/lib/people/announcement-writes';
import { shouldReadUnread } from '@/lib/people/reviews-announcements';
import { createClient } from '@/lib/supabase/server';

/**
 * Every Lekiu page. It reads the signed-in person's unread announcements, only for a member of a real workspace
 * and only here, so other products' pages never pay for it. It is read on every request and never cached across
 * people. `unreadAnnouncements` never throws (0 on any failure); the guard keeps even a surprise from breaking a page.
 * The count reaches the sidebar after hydration and returns to 0 when the person leaves Lekiu.
 */
export default async function PeopleLayout({ children }: { children: React.ReactNode }) {
  let unread = 0;
  try {
    const viewer = await getViewer();
    if (shouldReadUnread({ isDemo: viewer.isDemo, orgId: viewer.orgId })) {
      const client = await createClient();
      unread = await unreadAnnouncements({ client, orgId: viewer.orgId });
    }
  } catch {
    unread = 0;
  }
  return (
    <>
      <SetNavBadge name="unreadAnnouncements" value={unread} />
      {children}
    </>
  );
}
