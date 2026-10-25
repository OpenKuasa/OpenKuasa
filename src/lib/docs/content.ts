import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DOC_SECTIONS, type DocSectionKey } from './sections';
import { markHeadings, parseMarkdown, type GuideHeading } from './markdown';

export type Guide = {
  section: DocSectionKey;
  slug: string;
  title: string;
  description: string;
  order: number;
  /** The ready question for Ask Sari, at most 300 characters. */
  ask: string;
  /** In-app path the guide covers, e.g. '/people/payroll'. */
  screen?: string;
  /** For screens not built yet. */
  status?: 'coming-soon';
  /** Markdown after the header block. */
  body: string;
  /** Taken from the parsed Markdown, the same parse GuideBody renders. */
  headings: GuideHeading[];
  /** `/docs/${section}/${slug}` */
  url: string;
};

const SLUG = /^[a-z0-9-]+$/;

const headerSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().min(1),
    order: z.string().regex(/^-?\d+$/, 'order must be a whole number').transform(Number),
    ask: z.string().min(1).max(300),
    screen: z.string().min(1).optional(),
    status: z.literal('coming-soon').optional(),
  })
  .strict();

function splitHeader(fileName: string, raw: string): { header: Record<string, string>; body: string } {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') throw new Error(`${fileName}: the file must start with a --- header block`);
  const end = lines.indexOf('---', 1);
  if (end === -1) throw new Error(`${fileName}: the header block is not closed with ---`);
  const header: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon === -1) throw new Error(`${fileName}: header line "${line}" is not "key: value"`);
    const key = line.slice(0, colon).trim();
    if (key in header) throw new Error(`${fileName}: header key "${key}" appears twice`);
    const value = line.slice(colon + 1).trim();
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) {
      throw new Error(`${fileName}: header "${key}" is wrapped in quotes; write the value without quote marks`);
    }
    header[key] = value;
  }
  return { header, body: lines.slice(end + 1).join('\n') };
}

export function parseGuide(fileName: string, raw: string, section: DocSectionKey, slug: string): Guide {
  const { header, body } = splitHeader(fileName, raw);
  const parsed = headerSchema.safeParse(header);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
    throw new Error(`${fileName}: ${where}${issue.message}`);
  }
  return {
    section,
    slug,
    ...parsed.data,
    body,
    headings: markHeadings(parseMarkdown(body)),
    url: `/docs/${section}/${slug}`,
  };
}

const ROOT = path.join(process.cwd(), 'content/docs');
/** content/docs/held holds the held-topic lists (see rules.ts), not guides. */
const HELD_FOLDER = 'held';
/** Screenshot recipes live beside the guides but are not guides. */
const SHOTS_FOLDER = 'shots';
export const HELD_DIR = path.join(ROOT, HELD_FOLDER);
const SECTION_KEYS = new Set<string>(DOC_SECTIONS.map((s) => s.key));
let cache: Guide[] | null = null;

function loadAll(): Guide[] {
  const guides: Guide[] = [];
  for (const dir of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name === HELD_FOLDER || dir.name === SHOTS_FOLDER) continue;
    if (!SECTION_KEYS.has(dir.name)) throw new Error(`${dir.name}: not a known docs section`);
    const section = dir.name as DocSectionKey;
    for (const file of fs.readdirSync(path.join(ROOT, dir.name)).sort()) {
      if (!file.endsWith('.md')) continue;
      const slug = file.slice(0, -3);
      const fileName = `${dir.name}/${file}`;
      if (!SLUG.test(slug)) throw new Error(`${fileName}: the file name must use a-z, 0-9 and hyphens`);
      if (slug === 'ask') throw new Error(`${fileName}: "ask" is reserved and cannot be a guide name`);
      guides.push(parseGuide(fileName, fs.readFileSync(path.join(ROOT, dir.name, file), 'utf8'), section, slug));
    }
  }
  const rank = (s: DocSectionKey) => DOC_SECTIONS.findIndex((x) => x.key === s);
  return guides.sort(
    (a, b) => rank(a.section) - rank(b.section) || a.order - b.order || a.title.localeCompare(b.title),
  );
}

export function getAllGuides(): Guide[] {
  cache ??= loadAll();
  return cache;
}

export function getGuide(section: string, slug: string): Guide | null {
  return getAllGuides().find((g) => g.section === section && g.slug === slug) ?? null;
}
