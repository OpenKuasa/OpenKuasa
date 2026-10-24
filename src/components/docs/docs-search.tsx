'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Search } from 'lucide-react';
import { searchIndex, type DocsIndexEntry } from '@/lib/docs/search-core';

export function DocsSearch({ index }: { index: DocsIndexEntry[] }) {
  const [query, setQuery] = useState('');
  const router = useRouter();
  const inputId = useId();
  const results = query.trim() ? searchIndex(index, query) : [];

  return (
    <div>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (results[0]) router.push(results[0].url);
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Search the docs
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-mk-subtle" />
          <input
            id={inputId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the docs, e.g. “add my key”"
            autoComplete="off"
            className="h-13 w-full rounded-2xl border border-mk-border bg-mk-surface pr-4 pl-12 text-base text-mk-fg shadow-sm transition-colors outline-none placeholder:text-mk-subtle focus:border-mk-accent focus:ring-3 focus:ring-mk-accent/20 [&::-webkit-search-cancel-button]:appearance-none"
          />
        </div>
      </form>
      {query.trim() ? (
        results.length > 0 ? (
          <ul className="mt-3 overflow-hidden rounded-2xl border border-mk-border bg-mk-surface">
            {results.map((r, i) => (
              <li key={r.url} className={i > 0 ? 'border-t border-mk-border' : undefined}>
                <Link
                  href={r.url}
                  className="group flex items-start justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-mk-surface-2"
                >
                  <span className="min-w-0">
                    <span className="block font-medium text-mk-fg">{r.title}</span>
                    <span className="mt-0.5 block text-sm text-mk-muted">{r.description}</span>
                  </span>
                  <ArrowRight className="mt-1 size-4 shrink-0 text-mk-subtle transition-colors group-hover:text-mk-accent" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 px-1 text-sm text-mk-muted" role="status">
            No guides match that yet. Try other words.
          </p>
        )
      ) : null}
    </div>
  );
}
