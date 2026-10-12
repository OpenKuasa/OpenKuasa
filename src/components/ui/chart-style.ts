/**
 * Guards for the stylesheet `ChartStyle` writes (see ./chart.tsx).
 *
 * That stylesheet is built as a string and set as raw HTML, so nothing in it
 * is escaped. Anything that goes into it has to be checked here first: a chart
 * id or key must be a plain identifier, and a colour must be one of the colour
 * syntaxes below. Whatever fails is left out of the stylesheet.
 *
 * Kept outside chart.tsx, which is a shadcn/ui file, so an update of that file
 * only has to re-apply three short lines.
 */

const IDENT = /^[\w-]+$/;

const VAR = String.raw`var\(--[\w-]+\)`;
const COLOR = new RegExp(
  '^(?:' +
    [
      // #rgb, #rgba, #rrggbb, #rrggbbaa
      String.raw`#[0-9a-f]{3,8}`,
      // var(--token)
      VAR,
      // rgb(), hsl(), oklch()…: numbers, units and separators, or a var(--token)
      String.raw`(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((?:[\d .,%/+-]|[a-z]|${VAR})*\)`,
      // a named colour or keyword: red, transparent, currentColor
      String.raw`[a-z]{1,32}`,
    ].join('|') +
    ')$',
  'i',
);

/** A chart id or config key that is safe as part of a selector or property name. */
export const isSafeCssKey = (key: string): boolean => IDENT.test(key) && !key.endsWith('\n');

/** A colour value that cannot end its declaration, its rule or the style element. */
export const isSafeCssColor = (color: string): boolean =>
  color.length <= 128 && COLOR.test(color) && !color.endsWith('\n');
