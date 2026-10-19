import Link from 'next/link';
import type { Metadata } from 'next';
import { AuthShell } from '@/components/auth/auth-shell';
import { MfaRecoverForm } from '@/components/auth/mfa-recover-form';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { MFA_VERIFY_PATH } from '@/lib/auth/mfa';
import { requireMfaChallenge } from '../guard';

export const metadata: Metadata = {
  title: 'Use a recovery code · OpenKuasa',
};

export default async function MfaRecoverPage() {
  await requireMfaChallenge();

  return (
    <AuthShell>
      <div className="space-y-1.5 text-center">
        <h1 className="text-3xl font-bold tracking-tight">
          Use a recovery code
        </h1>
        <p className="text-sm text-muted-foreground">
          Enter one of the recovery codes you saved when you set up two-factor
          authentication.
        </p>
      </div>

      <p
        role="note"
        className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground"
      >
        Using a recovery code turns two-factor authentication off and retires
        your other recovery codes. You will need to set it up again once you
        are signed in.
      </p>

      <MfaRecoverForm />

      <div className="space-y-2 text-center text-sm text-muted-foreground">
        <p>
          Have your phone after all?{' '}
          <Link
            href={MFA_VERIFY_PATH}
            className="font-semibold text-primary hover:underline"
          >
            Enter a code instead
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
