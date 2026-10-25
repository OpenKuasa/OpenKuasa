import { toString } from 'mdast-util-to-string';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { uniqueIds } from './slug';

/**
 * The one Markdown parse every docs part shares: the loader's headings, GuideBody's heading ids, the search
 * split and the guide rules. GuideBody renders with react-markdown and these same remark plugins, so its tree
 * is this tree.
 */
export const GUIDE_REMARK_PLUGINS = [remarkGfm];

const parser = unified().use(remarkParse).use(GUIDE_REMARK_PLUGINS);

export type MdRoot = ReturnType<typeof parser.parse>;

/** The fields the docs code reads off a Markdown node. */
export type MdNode = {
  type: string;
  depth?: number;
  url?: string;
  alt?: string | null;
  identifier?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
};

export function parseMarkdown(body: string): MdRoot {
  return parser.parse(body);
}

/** Every node in the tree, in document order. */
export function walk(tree: MdRoot | MdNode, visit: (node: MdNode) => void): void {
  const node = tree as MdNode;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

export type GuideHeading = {
  depth: 2 | 3;
  text: string;
  id: string;
  /** Where the heading starts and ends in the body, so search can split passages at it. */
  start: number;
  end: number;
};

/**
 * A guide's headings: the non-empty level-2 and level-3 headings at the top level of the body (not inside a
 * list or a quote). Marks each heading node with its id, so the renderer that owns the tree shows the same ids.
 */
export function markHeadings(tree: MdRoot): GuideHeading[] {
  const nodes = (tree.children as MdNode[]).filter(
    (node) => node.type === 'heading' && (node.depth === 2 || node.depth === 3) && toString(node).trim() !== '',
  );
  const texts = nodes.map((node) => toString(node).trim());
  const ids = uniqueIds(texts);
  return nodes.map((node, i) => {
    node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: ids[i] } };
    return {
      depth: node.depth as 2 | 3,
      text: texts[i],
      id: ids[i],
      start: node.position?.start.offset ?? 0,
      end: node.position?.end.offset ?? 0,
    };
  });
}

/** A remark plugin that gives GuideBody's headings their ids. */
export function remarkHeadingIds() {
  return (tree: MdRoot) => {
    markHeadings(tree);
  };
}
