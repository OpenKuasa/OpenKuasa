/**
 * The nav parser shared by the route-file generator (gen-screen-routes.mjs) and
 * the route smoke test (smoke-routes.mjs). Both need the product/item routes
 * declared in `src/config/nav.ts`; sharing one parser stops them drifting and
 * keeps the line-ending fix in a single place.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Parses nav source text into `[{ key, slugs }]`, one entry per top-level nav
 * block, in file order.
 *
 * Line endings are normalised to LF first. On Windows these files arrive as
 * CRLF, which defeats the LF-anchored split below: without the normalise the
 * split matches nothing and this returns `[]`, so the generator deletes every
 * page it thinks is an orphan and the smoke test checks zero routes and passes
 * vacuously. Normalising keeps both honest on a CRLF checkout.
 */
export function parseNavSource(source) {
  const normalised = source.replace(/\r\n/g, '\n');
  const entries = [];
  for (const block of normalised.split(/\n  \{\n    key: '/).slice(1)) {
    const key = block.slice(0, block.indexOf("'"));
    if (!key) continue;
    const slugs = [...block.matchAll(/slug: '([^']+)'/g)].map((match) => match[1]);
    entries.push({ key, slugs });
  }
  return entries;
}

/** Reads `src/config/nav.ts` under `root` and parses it into `[{ key, slugs }]`. */
export function navEntries(root) {
  return parseNavSource(readFileSync(join(root, 'src/config/nav.ts'), 'utf8'));
}
