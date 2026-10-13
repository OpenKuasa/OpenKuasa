import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChartStyle, type ChartConfig } from '@/components/ui/chart';
import { isSafeCssColor, isSafeCssKey } from '@/components/ui/chart-style';

const HOSTILE = '</style><script>alert(1)</script>';

describe('ChartStyle', () => {
  it('writes the colour of a plain key', () => {
    const html = renderToStaticMarkup(
      <ChartStyle id="chart-a" config={{ leads: { label: 'Leads', color: 'var(--chart-2)' } }} />,
    );
    expect(html).toContain('[data-chart=chart-a]');
    expect(html).toContain('--color-leads: var(--chart-2);');
  });

  it('leaves out a key that is not a plain identifier', () => {
    const config: ChartConfig = {
      [HOSTILE]: { label: HOSTILE, color: 'var(--chart-1)' },
      'a b': { color: 'var(--chart-1)' },
      'x;} body{display:none': { color: 'var(--chart-1)' },
      ok: { color: 'var(--chart-3)' },
    };
    const html = renderToStaticMarkup(<ChartStyle id="chart-a" config={config} />);
    expect(html.match(/<\/style/g)).toHaveLength(1);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('display:none');
    expect(html).not.toContain('--color-a');
    expect(html).toContain('--color-ok: var(--chart-3);');
  });

  it('leaves out a colour that is not a colour', () => {
    const config: ChartConfig = {
      a: { color: `red;}${HOSTILE}` },
      b: { color: 'red; } body { display: none' },
      c: { theme: { light: HOSTILE, dark: '#0f0' } },
      d: { color: 'url(https://example.com/x)' },
    };
    const html = renderToStaticMarkup(<ChartStyle id="chart-a" config={config} />);
    expect(html.match(/<\/style/g)).toHaveLength(1);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('display');
    expect(html).not.toContain('url(');
    expect(html).not.toContain('--color-a');
    expect(html).toContain('--color-c: #0f0;');
  });

  it('draws nothing when the chart id is not a plain identifier', () => {
    const html = renderToStaticMarkup(
      <ChartStyle id={`x]{}${HOSTILE}`} config={{ ok: { color: 'var(--chart-1)' } }} />,
    );
    expect(html).toBe('');
  });
});

describe('chart style guards', () => {
  it('accepts the key shapes the charts use', () => {
    for (const key of ['s0', 'value', 'new_leads', 'in-progress']) {
      expect(isSafeCssKey(key), key).toBe(true);
    }
    for (const key of ['', 'a b', 'a.b', 'a;b', 'a}', '<a>', 'a:b', 'é', 'a\n']) {
      expect(isSafeCssKey(key), key).toBe(false);
    }
  });

  it('accepts the colour syntaxes the app passes and the common ones', () => {
    for (const color of [
      'var(--chart-1)',
      'var(--muted-foreground)',
      '#fff',
      '#0F172A',
      '#0f172a80',
      'rgb(15 23 42)',
      'rgba(15, 23, 42, 0.5)',
      'hsl(220 13% 91% / 0.4)',
      'hsl(var(--chart-1))',
      'oklch(0.72 0.11 178)',
      'oklch(0.72 0.11 178 / 50%)',
      'currentColor',
      'transparent',
    ]) {
      expect(isSafeCssColor(color), color).toBe(true);
    }
  });

  it('refuses anything that could end the declaration, the rule or the element', () => {
    for (const color of [
      '',
      'red;',
      'red}',
      'red; --x: 1',
      'var(--a)}',
      'var(--a, </style>)',
      '</style>',
      'url(//example.com)',
      'rgb(url(x))',
      'rgb(0 0 0) } *{',
      'expression(1)',
      'red /* */',
      'red\\3c ',
      '"red"',
      'var(--a)\nb',
      'red\n',
    ]) {
      expect(isSafeCssColor(color), JSON.stringify(color)).toBe(false);
    }
  });
});
