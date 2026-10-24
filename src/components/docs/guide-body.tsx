import Link from 'next/link';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Guide } from '@/lib/docs/content';
import { cn } from '@/lib/utils';

type MdNode = {
  type: string;
  depth?: number;
  children?: unknown[];
  position?: { start: { column: number; offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
};

/**
 * Gives each ## / ### heading the id the loader worked out, in the same order.
 * Same rule as the loader: a non-empty `##`/`###` line that starts at column 0
 * (such a line is always top-level; fenced code is skipped by the parser).
 */
function headingIds(ids: string[]) {
  return () => (tree: { children: MdNode[] }, file: { value: unknown }) => {
    const source = String(file.value);
    let i = 0;
    for (const node of tree.children) {
      if (node.type !== 'heading' || (node.depth !== 2 && node.depth !== 3)) continue;
      const start = node.position?.start;
      if (!start || start.column !== 1 || source[start.offset ?? -1] !== '#') continue;
      if (!node.children?.length) continue;
      const id = ids[i++];
      if (!id) continue;
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id } };
    }
  };
}

const HEADING = 'scroll-mt-24 font-semibold tracking-tight text-mk-fg';

const components: Components = {
  h1: ({ children }) => <h2 className={cn(HEADING, 'mt-12 text-2xl')}>{children}</h2>,
  h2: ({ children, id }) => (
    <h2 id={id} className={cn(HEADING, 'mt-12 border-t border-mk-border pt-8 text-2xl first:mt-0 first:border-0 first:pt-0')}>
      {children}
    </h2>
  ),
  h3: ({ children, id }) => (
    <h3 id={id} className={cn(HEADING, 'mt-8 text-lg')}>
      {children}
    </h3>
  ),
  h4: ({ children }) => <h4 className={cn(HEADING, 'mt-6 text-base')}>{children}</h4>,
  p: ({ children }) => <p className="mt-4 leading-7">{children}</p>,
  a: ({ href = '', children }) => {
    const className =
      'font-medium text-mk-accent underline decoration-mk-accent/40 underline-offset-4 transition-colors hover:decoration-mk-accent';
    if (href.startsWith('http')) {
      return (
        <a href={href} target="_blank" rel="noreferrer" className={className}>
          {children}
        </a>
      );
    }
    if (href.startsWith('/')) {
      return (
        <Link href={href} className={className}>
          {children}
        </Link>
      );
    }
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  },
  ul: ({ children }) => <ul className="mt-4 list-disc space-y-2 pl-6 marker:text-mk-subtle">{children}</ul>,
  ol: ({ children }) => (
    <ol className="mt-4 list-decimal space-y-2 pl-6 marker:font-medium marker:text-mk-accent">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-1 leading-7">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-mk-fg">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="mt-6 rounded-r-lg border-l-4 border-mk-accent bg-mk-accent/5 py-1 pr-4 pl-4 text-mk-fg [&>p]:mt-2 [&>p:first-child]:mt-2">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-10 border-mk-border" />,
  code: ({ children, className }) => (
    <code
      className={cn(
        'rounded-md border border-mk-border bg-mk-surface-2 px-1.5 py-0.5 font-mono text-[0.875em] text-mk-fg',
        className,
      )}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="mt-6 overflow-x-auto rounded-xl border border-mk-border bg-mk-surface-2 p-4 text-sm leading-6 [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  img: ({ src, alt }) => (
    // eslint-disable-next-line @next/next/no-img-element -- guide images can come from any host.
    <img
      src={typeof src === 'string' ? src : undefined}
      alt={alt ?? ''}
      loading="lazy"
      className="mt-6 h-auto max-w-full rounded-xl border border-mk-border"
    />
  ),
  table: ({ children }) => (
    <div className="mt-6 overflow-x-auto rounded-xl border border-mk-border">
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-mk-surface-2 text-mk-fg">{children}</thead>,
  th: ({ children, style }) => (
    <th style={style} className="border-b border-mk-border px-4 py-2.5 font-semibold">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-b border-mk-border px-4 py-2.5 align-top [tr:last-child_&]:border-b-0">
      {children}
    </td>
  ),
};

/** A guide's Markdown. Raw HTML in the source is not rendered. */
export function GuideBody({ guide }: { guide: Pick<Guide, 'body' | 'headings'> }) {
  return (
    <div className="text-[1.0625rem] break-words text-mk-fg/85">
      <Markdown
        remarkPlugins={[remarkGfm, headingIds(guide.headings.map((h) => h.id))]}
        components={components}
      >
        {guide.body}
      </Markdown>
    </div>
  );
}
