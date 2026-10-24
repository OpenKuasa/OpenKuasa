import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function AskSariBox({ question }: { question: string }) {
  return (
    <aside className="rounded-2xl border border-mk-border bg-mk-surface p-6 sm:p-7">
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-mk-accent/10 text-mk-accent">
          <Sparkles className="size-4" />
        </span>
        <h2 className="text-lg font-semibold tracking-tight">Still stuck? Ask Sari</h2>
      </div>
      <p className="mt-4 text-mk-muted">&ldquo;{question}&rdquo;</p>
      <Button asChild size="lg" className="mt-5 rounded-full px-5">
        <Link href={`/docs/ask?q=${encodeURIComponent(question)}`}>Ask Sari</Link>
      </Button>
      <p className="mt-4 text-xs text-mk-subtle">
        Asking Sari needs a free account. You&apos;ll sign in first if you&apos;re not already.
      </p>
    </aside>
  );
}
