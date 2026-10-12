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
 * its link takes focus once, which also scrolls it into view. Nothing
 * navigates by itself.
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
  /** The screen that shows what was saved. */
  href: string;
  linkLabel: string;
  onClose: () => void;
}) {
  const id = useId();
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    link.current?.focus();
  }, []);

  return (
    <BentoCard title={title} subtitle={subtitle} icon={FileText} className="col-span-2 md:col-span-12">
      <div className="flex flex-wrap items-center gap-3">
        <p id={id} role="status" className="text-sm text-muted-foreground">
          {children}{' '}
          <Link
            ref={link}
            href={href}
            aria-describedby={id}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {linkLabel}
          </Link>
          .
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </BentoCard>
  );
}
