import { AppShell } from '@/components/app/app-shell';
import { ViewerProvider } from '@/components/app/viewer-context';
import { NavBadgesProvider, type NavBadges } from '@/components/app/nav-badges-context';
import { getViewer } from '@/lib/auth/viewer';
import { createClient } from '@/lib/supabase/server';
import { countPendingProposals } from '@/lib/agents/proposals';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const viewer = await getViewer();

  // A live pending-proposals count for the AI Agents nav badge. A failed count must
  // never break the app shell, so it falls back to zero.
  const badges: NavBadges = { pendingProposals: 0, unreadAnnouncements: 0, awaitingAcknowledgement: 0 };
  if (!viewer.isDemo && viewer.orgId) {
    try {
      const supabase = await createClient();
      badges.pendingProposals = await countPendingProposals(supabase, viewer.orgId);
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
