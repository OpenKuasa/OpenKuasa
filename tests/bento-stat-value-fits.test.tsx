import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { BentoStat } from '@/components/bento/bento';

const firstSpanClasses = (html: string) => {
  const match = html.match(/<span class="([^"]*)"/);
  return (match?.[1] ?? '').split(/\s+/);
};

describe('BentoStat value', () => {
  it('scales the figure to its tile and wraps a long money value instead of clipping it', () => {
    const html = renderToStaticMarkup(
      <BentoStat label="Gross payroll" value="RM 108,118.74" />,
    );
    const value = firstSpanClasses(html);

    // Not a fixed oversized figure a narrow tile would clip.
    expect(value).not.toContain('text-2xl');
    expect(value).not.toContain('whitespace-nowrap');

    // Wrap safety net: money is always shown in full, never truncated.
    expect(value).toContain('min-w-0');
    expect(value).toContain('break-words');

    // Fluid, container-query-driven size, with the tile as the query container
    // so the container-query units resolve to the tile's width.
    expect(value.join(' ')).toMatch(/text-\[clamp\([^\]]*cqi[^\]]*\)\]/);
    expect(html).toContain('@container');
  });

  it('keeps a caller-supplied valueClassName as an escape hatch', () => {
    const html = renderToStaticMarkup(
      <BentoStat label="X" value="123" valueClassName="text-emerald-600" />,
    );
    expect(firstSpanClasses(html)).toContain('text-emerald-600');
  });
});
