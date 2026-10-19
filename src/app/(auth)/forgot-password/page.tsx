import Link from 'next/link';
import type { Metadata } from 'next';
import { AuthShell } from '@/components/auth/auth-shell';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';

export const metadata: Metadata = {
  title: 'Reset password · OpenKuasa',
};

export default function ForgotPasswordPage() {
  return (
    <AuthShell>
      <div className="space-y-1.5 text-center">
        <h1 className="text-3xl font-bold tracking-tight">
          Reset your password
        </h1>
        <p className="text-sm text-muted-foreground">
          Enter your email and we&apos;ll send you a link to set a new one.
        </p>
      </div>

      <ForgotPasswordForm />

      <p className="text-center text-sm text-muted-foreground">
        Remembered it?{' '}
        <Link
          href="/login"
          className="font-semibold text-primary hover:underline"
        >
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
