import { headers } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Zap } from 'lucide-react';
import { BentoCard, BentoGrid } from '@/components/bento/bento';
import { ApiKeysCard, WorkspaceKeysCard, type KeyListing } from '@/components/account/api-keys-card';
import { ConnectedAppsCard, type ConnectedApp } from '@/components/account/connected-apps-card';
import { McpSetupCard } from '@/components/account/mcp-setup-card';
import { originFromHeaders } from '@/lib/account/invites';
import { getMfaStatus } from '@/lib/auth/mfa';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv, type Viewer } from '@/lib/auth/viewer';
import { logFailure } from '@/lib/mcp/shared';
import { createClient } from '@/lib/supabase/server';

type KeyRow = { id: string; user_id: string; name: string; created_at: string; last_used_at: string | null };
type ProfileRow = { user_id: string; full_name: string | null; email: string | null };
type BindingRow = { client_id: string; org_id: string };

const log = (operation: string, error: unknown) => logFailure('developers', operation, error);

/** The workspace's live keys the person may see (their own; every one for owners and admins: RLS decides). */
async function loadKeys(supabase: SupabaseClient, viewer: Viewer): Promise<KeyListing[] | null> {
  const { data, error } = await supabase
    .from('mcp_api_keys_public')
    .select('id, user_id, name, created_at, last_used_at')
    .eq('org_id', viewer.orgId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (error) {
    log('read keys', error);
    return null;
  }
  const rows = (data ?? []) as KeyRow[];
  const others = [...new Set(rows.map((r) => r.user_id).filter((id) => id !== viewer.userId))];
  const names = new Map<string, string>();
  if (others.length > 0) {
    // RLS shows a person's profile only to the people they share a workspace with.
    const { data: profiles } = await supabase.from('profiles').select('user_id, full_name, email').in('user_id', others);
    for (const p of (profiles ?? []) as ProfileRow[]) {
      const name = p.full_name?.trim() || p.email?.split('@')[0];
      if (name) names.set(p.user_id, name);
    }
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    owner: r.user_id === viewer.userId ? viewer.name : (names.get(r.user_id) ?? 'A former member'),
    isYours: r.user_id === viewer.userId,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

/** The person's sign-in connections and the workspace each acts in. Null when the auth server could not say. */
async function loadApps(supabase: SupabaseClient, viewer: Viewer): Promise<ConnectedApp[] | null> {
  let grants;
  try {
    const { data, error } = await supabase.auth.oauth.listGrants();
    if (error || !data) {
      log('list grants', error);
      return null;
    }
    grants = data;
  } catch (error) {
    log('list grants', error);
    return null;
  }
  if (grants.length === 0) return [];

  const { data: bindings } = await supabase
    .from('mcp_oauth_bindings')
    .select('client_id, org_id')
    .eq('user_id', viewer.userId);
  const boundTo = new Map(((bindings ?? []) as BindingRow[]).map((b) => [b.client_id, b.org_id]));
  const orgIds = [...new Set(boundTo.values())];
  const orgNames = new Map<string, string>();
  if (orgIds.length > 0) {
    const { data: orgs } = await supabase.from('orgs').select('id, name').in('id', orgIds);
    for (const o of (orgs ?? []) as { id: string; name: string }[]) orgNames.set(o.id, o.name);
  }

  return grants.map((grant) => {
    const orgId = boundTo.get(grant.client.id);
    return {
      clientId: grant.client.id,
      name: grant.client.name?.trim() || 'An AI tool',
      grantedAt: grant.granted_at,
      workspace: orgId ? (orgNames.get(orgId) ?? 'a workspace you left') : null,
    };
  });
}

/**
 * Account → Developers, open to every member: their own API keys, the workspace's keys for owners and admins,
 * the AI tools they connected by sign-in, and how to set each tool up. The demo shows the page read-only.
 */
export default async function DevelopersPage() {
  const viewer = await getViewer();
  const live = hasSupabaseEnv() && !viewer.isDemo;
  const serverUrl = `${originFromHeaders(await headers()).replace(/\/+$/, '')}/api/mcp`;
  const seesWorkspace = live && can(viewer.role, 'manage-developers');

  let keys: KeyListing[] | null = [];
  let apps: ConnectedApp[] | null = [];
  let needsCode = false;
  if (live) {
    const supabase = await createClient();
    [keys, apps, needsCode] = await Promise.all([
      loadKeys(supabase, viewer),
      loadApps(supabase, viewer),
      // A person with an authenticator gives its code when making a key; `getViewer` already made this session aal2.
      getMfaStatus(supabase).then((status) => status.factors.length > 0),
    ]);
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Developers</h1>
        <p className="text-sm text-muted-foreground">
          Connect AI tools such as Claude, Cursor and Codex to {viewer.orgName}.
        </p>
      </div>

      <BentoGrid>
        <ApiKeysCard
          keys={keys === null ? null : keys.filter((key) => key.isYours)}
          needsCode={needsCode}
          readOnly={!live}
        />
        {seesWorkspace ? <WorkspaceKeysCard keys={keys} /> : null}
        <ConnectedAppsCard apps={apps} readOnly={!live} />
        <McpSetupCard serverUrl={serverUrl} />
        <BentoCard
          title="Webhooks"
          subtitle="Send workspace events to your own systems"
          icon={Zap}
          className="col-span-2 md:col-span-12"
        >
          <p className="text-sm text-muted-foreground">Coming soon.</p>
        </BentoCard>
      </BentoGrid>
    </div>
  );
}
