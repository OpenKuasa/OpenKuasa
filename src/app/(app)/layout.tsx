import { headers } from 'next/headers';
import { AppShell } from '@/components/app/app-shell';
import { ViewerProvider } from '@/components/app/viewer-context';
import { NavBadgesProvider, type NavBadges } from '@/components/app/nav-badges-context';
import { getViewer } from '@/lib/auth/viewer';
import { createClient } from '@/lib/supabase/server';
import { countPendingProposals } from '@/lib/agents/proposals';
import { unreadAnnouncements } from '@/lib/people/announcement-writes';
import { shouldCountUnread } from '@/lib/people/reviews-announcements';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const viewer = await getViewer();

  // A live pending-proposals count for the AI Agents nav badge. A failed count must
  // never break the app shell, so it falls back to zero.
  const badges: NavBadges = { pendingProposals: 0, unreadAnnouncements: 0 };
  if (!viewer.isDemo && viewer.orgId) {
    try {
      const supabase = await createClient();
      badges.pendingProposals = await countPendingProposals(supabase, viewer.orgId);
    } catch {
      // keep the default zero
    }
    // Lekiu's Announcements count: per person and never cached across requests (a person who still owes a second
    // factor is told 0 for now). `unreadAnnouncements` answers 0 on any failure and never throws; the extra guard
    // keeps even a surprise from breaking the shell. It is read only while Lekiu's navigation is shown. The path
    // comes from the optional `x-pathname` request header; without it the count is read on every product's page.
    try {
      const pathname = (await headers()).get('x-pathname');
      if (shouldCountUnread({ isDemo: viewer.isDemo, orgId: viewer.orgId, pathname })) {
        const client = await createClient();
        badges.unreadAnnouncements = await unreadAnnouncements({ client, orgId: viewer.orgId });
      }
    } catch {
      // keep the default zero
    }
  }

  return (
    <ViewerProvider viewer={viewer}>
      <NavBadgesProvider badges={badges}>
        <AppShell>{children}</AppShell>
      </NavBadgesProvider>
    </ViewerProvider>
  );
}
