import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { AuthShell } from '@/components/auth/auth-shell';
import { Button } from '@/components/ui/button';
import { currentOrgFor } from '@/lib/auth/current-org';
import { hasSupabaseEnv } from '@/lib/auth/preview-mode';
import { logFailure } from '@/lib/mcp/shared';
import { ConsentForm } from './consent-form';
import { EXPIRED, FAILED, NOT_VALID, NO_WORKSPACE, OTHER_ACCOUNT, answeringPerson, authorizationIdOf } from './consent';

export const metadata: Metadata = {
  title: 'Connect an AI tool · OpenKuasa',
};

function Refused({ message }: { message: string }) {
  return (
    <AuthShell>
      <div className="space-y-1.5 text-center">
        <h1 className="text-3xl font-bold tracking-tight">Can&apos;t connect</h1>
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
      <Button asChild variant="outline" className="w-full" size="lg">
        <Link href="/command">Go to OpenKuasa</Link>
      </Button>
    </AuthShell>
  );
}

/** The host a client sends people back to, when its address has one (a desktop app's may not). */
function hostOf(uri: string): string | null {
  try {
    return new URL(uri).host || null;
  } catch {
    return null;
  }
}

/**
 * "Sign in with OpenKuasa": Supabase's OAuth server sends people here with `authorization_id` when an AI tool
 * (Claude, Cursor, Codex…) connects. It names the tool, the workspace the person has open and the person, and asks
 * Allow or Don't allow. Allow binds the connection to that workspace (see `actions.ts`).
 */
export default async function OAuthConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string | string[] }>;
}) {
  const authorizationId = authorizationIdOf((await searchParams).authorization_id);
  if (!authorizationId || !hasSupabaseEnv()) return <Refused message={NOT_VALID} />;

  const gate = await answeringPerson(authorizationId);
  if (gate.kind === 'redirect') redirect(gate.to);
  if (gate.kind === 'refuse') return <Refused message={gate.message} />;
  const { supabase, user } = gate;

  const { data: details, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error || !details) return <Refused message={EXPIRED} />;
  // Already allowed earlier: the auth server sends the person straight back.
  if (!('authorization_id' in details)) redirect(details.redirect_url);
  if (details.user.id !== user.id) return <Refused message={OTHER_ACCOUNT} />;

  let current: Awaited<ReturnType<typeof currentOrgFor>>;
  try {
    current = await currentOrgFor(supabase, user.id);
  } catch (readError) {
    logFailure('oauth-consent', 'read workspace', readError);
    return <Refused message={FAILED} />;
  }
  if (!current) return <Refused message={NO_WORKSPACE} />;

  const [{ data: org }, { data: profile }] = await Promise.all([
    supabase.from('orgs').select('name').eq('id', current.orgId).maybeSingle(),
    supabase.from('profiles').select('full_name').eq('user_id', user.id).maybeSingle(),
  ]);
  const workspace = (org as { name?: string } | null)?.name?.trim() || 'your workspace';
  // The name the person set, else their email's first part, as the app shows them.
  const fullName = (profile as { full_name?: string | null } | null)?.full_name?.trim();
  const person = fullName || user.email?.split('@')[0] || 'you';
  const client = details.client.name?.trim() || 'An AI tool';
  const returnsTo = hostOf(details.redirect_uri);

  return (
    <AuthShell>
      <div className="space-y-1.5 text-center">
        <h1 className="text-2xl font-bold tracking-tight">{`Allow ${client} to access ${workspace} as ${person}?`}</h1>
        <p className="text-sm text-muted-foreground">
          It can look things up and make changes in this workspace, as you.
        </p>
      </div>

      <dl className="divide-y rounded-lg border text-sm">
        <div className="flex items-center justify-between gap-4 px-4 py-2.5">
          <dt className="text-muted-foreground">Workspace</dt>
          <dd className="truncate font-medium">{workspace}</dd>
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-2.5">
          <dt className="text-muted-foreground">Signed in as</dt>
          <dd className="truncate font-medium">{user.email ?? person}</dd>
        </div>
        {returnsTo ? (
          <div className="flex items-center justify-between gap-4 px-4 py-2.5">
            <dt className="text-muted-foreground">Sends you back to</dt>
            <dd className="truncate font-medium">{returnsTo}</dd>
          </div>
        ) : null}
      </dl>

      <ConsentForm authorizationId={authorizationId} orgId={current.orgId} />
    </AuthShell>
  );
}
