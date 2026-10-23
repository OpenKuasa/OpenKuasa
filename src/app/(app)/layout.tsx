import { AppShell } from '@/components/app/app-shell';
import { ViewerProvider } from '@/components/app/viewer-context';
import { NavBadgesProvider, type NavBadges } from '@/components/app/nav-badges-context';
import { getViewer } from '@/lib/auth/viewer';
import { can } from '@/lib/auth/permissions';
import { createClient } from '@/lib/supabase/server';
import { countPendingProposals } from '@/lib/agents/proposals';
import { readMyTeam } from '@/lib/people/my-team';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let viewer = await getViewer();

  // Each product's AI Agents nav item gets its own live pending-suggestions count. A failed
  // count must never break the app shell, so it falls back to zero.
  const badges: NavBadges = {
    pendingProposals: 0,
    pendingCrmProposals: 0,
    unreadAnnouncements: 0,
    awaitingAcknowledgement: 0,
    waitingLeave: 0,
    waitingTimeOff: 0,
    waitingClaims: 0,
    waitingOvertime: 0,
    waitingSwaps: 0,
    waitingSwapReplies: 0,
  };
  if (!viewer.isDemo && viewer.orgId) {
    try {
      const supabase = await createClient();
      // Lekiu: does this member manage a team? That decides which approval pages the nav shows them. Owners and
      // admins see those pages by role. A failed read is "no team" (readMyTeam never throws).
      const [pending, pendingCrm, team] = await Promise.all([
        countPendingProposals(supabase, viewer.orgId, 'reach').catch(() => 0),
        countPendingProposals(supabase, viewer.orgId, 'crm').catch(() => 0),
        can(viewer.role, 'approve') ? Promise.resolve([] as string[]) : readMyTeam(supabase, viewer.orgId),
      ]);
      badges.pendingProposals = pending;
      badges.pendingCrmProposals = pendingCrm;
      if (team.length > 0) viewer = { ...viewer, managesTeam: true };
    } catch {
      // keep the defaults
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
