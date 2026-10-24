import type { ReactNode } from 'react';
import Link from 'next/link';
import { Logo } from '@/components/brand/logo';

/**
 * Two-pane auth layout (form on the left, brand panel on the right) shared by
 * the password-recovery screens, matching the sign-in page.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh w-full">
      {/* form pane */}
      <div className="flex flex-1 flex-col px-6 py-8 sm:px-10 lg:px-16">
        <Link href="/" aria-label="OpenKuasa home" className="w-fit">
          <Logo />
        </Link>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm space-y-6">{children}</div>
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
