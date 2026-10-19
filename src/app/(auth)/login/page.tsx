import Link from 'next/link';
import type { Metadata } from 'next';
import { Logo } from '@/components/brand/logo';
import { DemoButton } from '@/components/auth/demo-button';
import { GoogleNotEnabledButton } from '@/components/auth/google-not-enabled-button';
import { LoginForm } from '@/components/auth/login-form';

export const metadata: Metadata = {
  title: 'Sign in · OpenKuasa',
};

const NOTICES: Record<string, string> = {
  reset_expired: 'Your reset link has expired. Request a new one below.',
  link_invalid: 'That link is invalid or has already been used.',
  session_expired: 'Your session expired. Please sign in again.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const { notice } = await searchParams;
  const message = notice ? NOTICES[notice] : undefined;

  return (
    <div className="flex min-h-dvh w-full">
      {/* form pane */}
      <div className="flex flex-1 flex-col px-6 py-8 sm:px-10 lg:px-16">
        <Logo />

        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm space-y-6">
            <div className="space-y-1.5 text-center">
              <h1 className="text-3xl font-bold tracking-tight">Sign in</h1>
              <p className="text-sm text-muted-foreground">
                Welcome back! Please sign in to continue.
              </p>
            </div>

            {message ? (
              <p
                role="status"
                className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-center text-sm text-muted-foreground"
              >
                {message}
              </p>
            ) : null}

            <GoogleNotEnabledButton>
              <GoogleMark />
              Sign in with Google
            </GoogleNotEnabledButton>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-background px-2 text-muted-foreground">
                  Continue with Email
                </span>
              </div>
            </div>

            <LoginForm />

            {process.env.NEXT_PUBLIC_DEMO_ENABLED === '1' ? (
              <DemoButton />
            ) : null}

            <p className="text-center text-sm text-muted-foreground">
              Don&apos;t have an account?{' '}
              <Link
                href="/onboarding"
                className="font-semibold text-primary hover:underline"
              >
                Sign up
              </Link>
            </p>
          </div>
        </div>
      </div>

      {/* visual pane */}
      <div className="relative hidden w-[46%] overflow-hidden bg-primary lg:block">
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(120% 120% at 20% 10%, oklch(0.62 0.13 164) 0%, oklch(0.42 0.12 168) 45%, oklch(0.26 0.07 180) 100%)',
          }}
        />
        <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(white_1px,transparent_1px)] [background-size:22px_22px]" />
        <div className="relative flex h-full flex-col justify-end p-12 text-white">
          <blockquote className="max-w-md space-y-3">
            <p className="text-2xl font-semibold italic leading-snug">
              &ldquo;Takkan Melayu hilang di dunia.&rdquo;
            </p>
            <footer className="text-sm text-white/70">
              — Hang Tuah, Laksamana of Melaka
            </footer>
          </blockquote>
        </div>
      </div>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z"
      />
    </svg>
  );
}
