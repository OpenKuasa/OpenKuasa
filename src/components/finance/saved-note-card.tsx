'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';
import Link from 'next/link';
import { FileText } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { Button } from '@/components/ui/button';

/**
 * Says that something was saved which shows on another screen, and links
 * there: a credit note made from an invoice's row is on Credit Notes, and a
 * refund made from an invoice's or a credit note's row is on Refunds. Without
 * it the form would close and the page the person is on might show nothing
 * new. It opens at the top of the page, away from the row that was used, so
 * its link takes focus once, which also scrolls it into view (a note with
 * no link focuses its Close button instead). Nothing navigates by itself.
 */
export function SavedNoteCard({
  title,
  subtitle,
  children,
  href,
  linkLabel,
  onClose,
}: {
  title: string;
  subtitle: string;
  /** What was saved and what can be done with it there; the link follows it. */
  children: ReactNode;
  /** The screen that shows what was saved; absent when the note only explains what is on this screen. */
  href?: string;
  linkLabel?: string;
  onClose: () => void;
}) {
  const id = useId();
  const link = useRef<HTMLAnchorElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // With no link, Close takes focus instead, so the note scrolls into view and is read out with its text.
    (link.current ?? closeButton.current)?.focus();
  }, []);
  const linked = href && linkLabel;

  return (
    <BentoCard title={title} subtitle={subtitle} icon={FileText} className="col-span-2 md:col-span-12">
      <div className="flex flex-wrap items-center gap-3">
        <p id={id} role="status" className="min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {children}
          {linked ? (
            <>
              {' '}
              <Link
                ref={link}
                href={href}
                aria-describedby={id}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {linkLabel}
              </Link>
              .
            </>
          ) : null}
        </p>
        <Button
          ref={closeButton}
          type="button"
          variant="outline"
          size="sm"
          aria-describedby={linked ? undefined : id}
          onClick={onClose}
        >
          Close
        </Button>
      </div>
    </BentoCard>
  );
}
