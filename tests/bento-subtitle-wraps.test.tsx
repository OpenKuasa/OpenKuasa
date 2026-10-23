import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { BentoCard } from '@/components/bento/bento';

const classesOf = (html: string, tag: string) => {
  const match = html.match(new RegExp(`<${tag} class="([^"]*)"`));
  return (match?.[1] ?? '').split(/\s+/);
};

describe('BentoCard subtitle', () => {
  it('wraps the subtitle instead of truncating it, and keeps the title truncated', () => {
    const html = renderToStaticMarkup(<BentoCard title="T" subtitle="A long subtitle" />);
    expect(classesOf(html, 'p')).not.toContain('truncate');
    expect(classesOf(html, 'h3')).toContain('truncate');
  });
});
