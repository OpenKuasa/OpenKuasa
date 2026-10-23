import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { loadCrmConnections, type CrmConnections } from '@/lib/crm/connections';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/screen/page-header';
import { ScreenContainer } from '@/components/screen/screen-container';
import SamplePluginsScreen from './plugins';
import { PLUGINS_SUBTITLE, PLUGINS_TITLE, PluginsView } from './plugins-view';

/**
 * Kasturi's Plugins screen: the workspace's own connections and their state.
 * Falls back to the sample screen only when no database is configured; once
 * one is, a failed load says so instead.
 */
export default async function CrmPluginsPage() {
  if (!hasSupabaseEnv()) return <SamplePluginsScreen />;

  // The layout already loaded the viewer for this request; this reuses it.
  const { orgId } = await getViewer();
  const supabase = await createClient();

  let connections: CrmConnections | null = null;
  try {
    connections = await loadCrmConnections(supabase, orgId);
  } catch (error) {
    // Never a made-up state in place of the workspace's own.
    console.error('[crm/plugins] could not load the connections', error);
  }

  if (!connections) {
    return (
      <ScreenContainer>
        <PageHeader title={PLUGINS_TITLE} subtitle={PLUGINS_SUBTITLE} />
        <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
          Couldn&apos;t load your connections — please refresh
        </p>
      </ScreenContainer>
    );
  }
  return <PluginsView connections={connections} />;
}
