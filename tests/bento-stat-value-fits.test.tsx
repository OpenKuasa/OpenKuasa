import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { BentoStat } from '@/components/bento/bento';

const spanClassesAt = (html: string, index: number) => {
  const all = [...html.matchAll(/<span class="([^"]*)"/g)].map((m) => m[1]);
  return (all[index] ?? '').split(/\s+/);
};
const firstSpanClasses = (html: string) => spanClassesAt(html, 0);

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

  it('wraps a long delta/label chip instead of clipping it at the tile edge', () => {
    const html = renderToStaticMarkup(
      <BentoStat label="Deductions" value="RM 15,261.81" delta="EPF, SOCSO, EIS, PCB, other" />,
    );
    const chip = spanClassesAt(html, 1); // second span is the delta chip
    expect(chip).not.toContain('whitespace-nowrap');
    expect(chip).toContain('break-words');
    expect(chip).toContain('min-w-0');
  });

  it('keeps a caller-supplied valueClassName as an escape hatch', () => {
    const html = renderToStaticMarkup(
      <BentoStat label="X" value="123" valueClassName="text-emerald-600" />,
    );
    expect(firstSpanClasses(html)).toContain('text-emerald-600');
  });
});
