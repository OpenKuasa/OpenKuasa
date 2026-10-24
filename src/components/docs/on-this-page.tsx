import type { Guide } from '@/lib/docs/content';
import { cn } from '@/lib/utils';

export function OnThisPage({ headings }: { headings: Guide['headings'] }) {
  if (headings.length === 0) return null;
  return (
    <nav aria-labelledby="on-this-page" className="text-sm">
      <p id="on-this-page" className="font-semibold text-mk-fg">
        On this page
      </p>
      <ul className="mt-3 space-y-1 border-l border-mk-border">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              className={cn(
                '-ml-px block border-l border-transparent py-1 text-mk-muted transition-colors hover:border-mk-accent hover:text-mk-fg',
                h.depth === 3 ? 'pl-7' : 'pl-4',
              )}
            >
              {h.text.replace(/[*_`]/g, '')}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
