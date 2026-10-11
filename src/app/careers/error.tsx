'use client';

import { PublicCareersShell } from '@/components/hire/public-careers-shell';
import { Button } from '@/components/ui/button';

/**
 * The last net under /careers: anything thrown while a board or a job page is
 * drawn lands here, in place of the framework's own error screen. It says the
 * same thing whatever went wrong and shows nothing of the error. Nothing is
 * logged from here either: the server has already logged what it threw.
 *
 * The apply form does not rely on this. It catches a failed post itself, so
 * that what was typed is kept.
 */
export default function CareersError({
  retry,
}: {
  error: Error & { digest?: string };
  /** Fetches the page again and draws it in place of this message. */
  retry: () => void;
}) {
  return (
    <PublicCareersShell>
      <main
        id="main"
        tabIndex={-1}
        className="rounded-xl border bg-card p-6 text-card-foreground shadow-sm outline-none sm:p-8"
      >
        <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="mt-2 text-muted-foreground">This page couldn&apos;t be shown. Please try again.</p>
        <Button
          type="button"
          size="lg"
          onClick={() => retry()}
          className="mt-4 h-11 text-base motion-reduce:transition-none"
        >
          Try again
        </Button>
      </main>
    </PublicCareersShell>
  );
}
