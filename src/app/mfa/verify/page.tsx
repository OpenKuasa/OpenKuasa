import Link from 'next/link';
import type { Metadata } from 'next';
import { AuthShell } from '@/components/auth/auth-shell';
import { MfaVerifyForm } from '@/components/auth/mfa-verify-form';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { MFA_RECOVER_PATH, safeNextPath } from '@/lib/auth/mfa';
import { requireMfaChallenge } from '../guard';

export const metadata: Metadata = {
  title: 'Two-factor authentication · OpenKuasa',
};

export default async function MfaVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  // Where to go once the code is accepted, e.g. back to an invite link.
  const next = safeNextPath((await searchParams).next);
  await requireMfaChallenge(next);

  return (
    <AuthShell>
      <div className="space-y-1.5 text-center">
        <h1 className="text-3xl font-bold tracking-tight">Enter your code</h1>
        <p className="text-sm text-muted-foreground">
          Open your authenticator app and enter the 6-digit code for OpenKuasa
          OS.
        </p>
      </div>

      <MfaVerifyForm next={next} />

      <div className="space-y-2 text-center text-sm text-muted-foreground">
        <p>
          Lost your phone?{' '}
          <Link
            href={MFA_RECOVER_PATH}
            className="font-semibold text-primary hover:underline"
          >
            Use a recovery code
          </Link>
        </p>
        <div>
          <SignOutButton className="font-medium hover:text-foreground hover:underline">
            Sign out
          </SignOutButton>
        </div>
      </div>
    </AuthShell>
  );
}
