import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ACCOUNT_SECTIONS } from '@/config/account-nav';
import { LIVE_SCREENS } from '@/config/live-screens';
import { PRODUCTS } from '@/config/nav';
import { HELD_DIR } from './content';
import { parseMarkdown, walk, type MdNode, type MdRoot } from './markdown';
import { DOC_SECTIONS } from './sections';

/** In-app paths a guide's `screen` may name: every live nav screen, Tuah, and every account page. */
export function liveScreenPaths(): Set<string> {
  const paths = new Set<string>(['/command']);
  for (const product of PRODUCTS) {
    for (const section of product.sections) {
      for (const item of section.items) {
        if (LIVE_SCREENS.has(`${product.key}/${item.slug}`)) paths.add(`/${product.key}/${item.slug}`);
      }
    }
  }
  for (const section of ACCOUNT_SECTIONS) for (const item of section.items) paths.add(item.href);
  return paths;
}

/** Reference-style targets (`[name]: /url`), by their normalised label. */
function definitions(tree: MdRoot): Map<string, string> {
  const found = new Map<string, string>();
  walk(tree, (node) => {
    if (node.type === 'definition' && node.identifier && node.url !== undefined && !found.has(node.identifier)) {
      found.set(node.identifier, node.url);
    }
  });
  return found;
}

/** Where a link or image node points, following a reference to its definition. */
function target(node: MdNode, defs: Map<string, string>): string | undefined {
  if (node.type === 'link' || node.type === 'image') return node.url;
  if ((node.type === 'linkReference' || node.type === 'imageReference') && node.identifier) return defs.get(node.identifier);
  return undefined;
}

/** Every image in a guide body, in order, as the page renders it. */
export function guideImages(body: string): { alt: string; src: string }[] {
  const tree = parseMarkdown(body);
  const defs = definitions(tree);
  const images: { alt: string; src: string }[] = [];
  walk(tree, (node) => {
    if (node.type !== 'image' && node.type !== 'imageReference') return;
    images.push({ alt: node.alt ?? '', src: target(node, defs) ?? '' });
  });
  return images;
}

/** Every link in a guide body to another guide (`/docs/<section>/<slug>`), with any `#heading` split off. */
export function guideLinks(body: string): { href: string; path: string; hash: string | null }[] {
  const tree = parseMarkdown(body);
  const defs = definitions(tree);
  const links: { href: string; path: string; hash: string | null }[] = [];
  walk(tree, (node) => {
    const href = target(node, defs);
    if (href === undefined || node.type === 'image' || node.type === 'imageReference') return;
    const linkPath = href.split(/[?#]/)[0];
    if (!/^\/docs\/[^/]+\/.+/.test(linkPath)) return;
    const hashAt = href.indexOf('#');
    links.push({ href, path: linkPath, hash: hashAt === -1 ? null : href.slice(hashAt + 1) });
  });
  return links;
}

const SECTION_KEYS = new Set<string>(DOC_SECTIONS.map((s) => s.key));
const heldFile = z.array(z.string().regex(/^[a-z0-9-]+$/, 'each entry must be a guide slug (a-z, 0-9 and hyphens)'));

/**
 * The held topics: one `<section>.json` per docs section in the folder, each a JSON array of that section's
 * guide slugs. Returns them as `${section}/${slug}`. A missing folder holds nothing. A bad file throws, naming it.
 */
export function loadHeldSlugs(dir: string): Set<string> {
  const held = new Set<string>();
  if (!fs.existsSync(dir)) return held;
  for (const file of fs.readdirSync(dir).sort()) {
    const fileName = path.relative(process.cwd(), path.join(dir, file));
    if (!file.endsWith('.json')) throw new Error(`${fileName}: the held folder takes only <section>.json files`);
    const section = file.slice(0, -'.json'.length);
    if (!SECTION_KEYS.has(section)) throw new Error(`${fileName}: "${section}" is not a docs section`);
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (error) {
      throw new Error(`${fileName}: not valid JSON (${(error as Error).message})`);
    }
    const parsed = heldFile.safeParse(data);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue.path.length ? `entry ${issue.path.join('.')}: ` : '';
      throw new Error(`${fileName}: must be a JSON array of guide slugs; ${where}${issue.message}`);
    }
    for (const slug of parsed.data) held.add(`${section}/${slug}`);
  }
  return held;
}

/** `${section}/${slug}` of every held guide, read from content/docs/held/<section>.json. */
export const HELD_SLUGS: ReadonlySet<string> = loadHeldSlugs(HELD_DIR);
