import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { z } from 'zod';
import { AuthShell } from '@/components/auth/auth-shell';
import { Button } from '@/components/ui/button';
import {
  InviteAcceptForm,
  InviteJoinButton,
} from '@/components/account/invite-accept-form';
import { getInvite, inviteProblem } from '@/lib/account/invites';
import { getMfaStatus, mfaVerifyHref } from '@/lib/auth/mfa';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { roleLabel } from '@/lib/auth/permissions';
import { createClient } from '@/lib/supabase/server';
import { signOutToInviteAction } from './actions';

export const metadata: Metadata = {
  title: 'Join a workspace · OpenKuasa',
};

function Heading({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5 text-center">
      <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function Unusable({ message }: { message: string }) {
  return (
    <AuthShell>
      <Heading title="Invite unavailable">{message}</Heading>
      <Button asChild className="w-full" size="lg">
        <Link href="/login">Go to sign in</Link>
      </Button>
    </AuthShell>
  );
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token: rawToken } = await params;
  // A malformed token would make the lookup itself fail.
  const token = z.uuid().safeParse(rawToken);
  if (!token.success || !hasSupabaseEnv()) {
    return <Unusable message="This invite link is not valid. Check that you copied the whole link." />;
  }

  // Not getViewer(): this page must also work signed-out.
  const supabase = await createClient();
  const [invite, auth] = await Promise.all([
    getInvite(supabase, token.data),
    supabase.auth.getUser(),
  ]);
  if (!invite) {
    return <Unusable message="This invite link is not valid. Check that you copied the whole link." />;
  }
  const problem = inviteProblem(invite.status);
  if (problem) return <Unusable message={problem} />;

  const user = auth.data.user;
  // A signed-in user with two-factor on must enter their code before joining;
  // the code prompt brings them back to this invite.
  if (user && (await getMfaStatus(supabase)).challengeRequired) {
    redirect(mfaVerifyHref(`/invite/${token.data}`));
  }
  const isGuest = user?.is_anonymous === true;
  const signedInAs = user && !isGuest ? (user.email ?? null) : null;
  const matches = signedInAs?.toLowerCase() === invite.email.toLowerCase();

  return (
    <AuthShell>
      <Heading title={`Join ${invite.orgName}`}>
        You have been invited to {invite.orgName} on OpenKuasa.
      </Heading>

      <dl className="divide-y rounded-lg border text-sm">
        <div className="flex items-center justify-between gap-4 px-4 py-2.5">
          <dt className="text-muted-foreground">Workspace</dt>
          <dd className="truncate font-medium">{invite.orgName}</dd>
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-2.5">
          <dt className="text-muted-foreground">Invited email</dt>
          <dd className="truncate font-medium">{invite.email}</dd>
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-2.5">
          <dt className="text-muted-foreground">Role</dt>
          <dd className="font-medium">{roleLabel(invite.role)}</dd>
        </div>
      </dl>

      {!user ? (
        <InviteAcceptForm
          token={token.data}
          email={invite.email}
          orgName={invite.orgName}
        />
      ) : matches ? (
        <InviteJoinButton token={token.data} orgName={invite.orgName} />
      ) : (
        <div className="space-y-4">
          <p
            role="note"
            className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground"
          >
            {isGuest
              ? `You are browsing as a demo guest. Sign out of the demo, then sign in or create an account as ${invite.email} to join.`
              : `You are signed in as ${signedInAs ?? 'another account'}, but this invite is for ${invite.email}. Sign out, then open it again with that email.`}
          </p>
          <form action={signOutToInviteAction}>
            <input type="hidden" name="token" value={token.data} />
            <Button type="submit" variant="outline" className="w-full" size="lg">
              Sign out
            </Button>
          </form>
        </div>
      )}
    </AuthShell>
  );
}
