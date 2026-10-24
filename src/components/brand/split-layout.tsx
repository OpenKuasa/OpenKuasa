import { type ReactNode } from 'react';
import Link from 'next/link';
import { Logo } from './logo';
import { cn } from '@/lib/utils';

type SplitLayoutProps = {
  heading: ReactNode;
  subheading?: ReactNode;
  /** optional content pinned to the bottom of the brand panel (e.g. progress) */
  footer?: ReactNode;
  /** width override for the right-hand content container */
  contentClassName?: string;
  children: ReactNode;
};

/**
 * Two-pane auth/onboarding layout: a light brand panel on the left and the
 * working content on the right.
 */
export function SplitLayout({
  heading,
  subheading,
  footer,
  contentClassName,
  children,
}: SplitLayoutProps) {
  return (
    <div className="flex min-h-dvh w-full flex-col lg:flex-row">
      <div className="flex flex-col gap-10 border-b bg-muted/60 p-8 lg:w-[42%] lg:border-b-0 lg:border-r lg:p-12">
        <Link href="/" aria-label="OpenKuasa home" className="w-fit">
          <Logo />
        </Link>
        <div className="flex flex-1 flex-col justify-center">
          <div className="max-w-sm">
            <h1 className="text-4xl font-bold leading-[1.05] tracking-tight text-foreground lg:text-5xl">
              {heading}
            </h1>
            {subheading ? (
              <p className="mt-5 text-base leading-relaxed text-muted-foreground">
                {subheading}
              </p>
            ) : null}
          </div>
        </div>
        {footer ? <div className="mt-auto">{footer}</div> : null}
      </div>

      <div className="flex flex-1 items-center justify-center p-8 lg:p-14">
        <div className={cn('w-full max-w-md', contentClassName)}>{children}</div>
      </div>
    </div>
  );
}
