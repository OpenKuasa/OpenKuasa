import Link from 'next/link';
import { memo, type ReactNode } from 'react';
// The letters' parser, used as it is: a pure function from text to a small tree, linear in the text. It lives with
// the HR letters for now; it belongs somewhere shared (it is not HR-specific), and this is the only chat import of it.
import { parseLetter, type Block, type Inline } from '@/lib/people/letter-marks';

/**
 * The words of a chat message.
 *
 * `TypedText` is the person's own message: exactly what they typed, nothing read into it.
 *
 * `ReplyText` is an assistant's reply. The assistants are told to write plain text, and mostly do; but a model will
 * now and then write a heading, a bold phrase, a list or a rule (and a person may ask for one), and drawn as typed
 * those show as stray `**`, `#` and `---`. So a reply may carry the same few marks a letter may, and they are drawn:
 * "# " headings (three levels), `**bold**`, `*italic*`, "- " bullets, "1. " numbered lines (the number typed is
 * kept), and a line of three or more hyphens as a thin rule. Everything else is text.
 *
 * The rules of this file:
 * - Text is only ever put in as a React text child, which React escapes. Every element is written out below by
 *   name with fixed classes. Nothing in the text chooses an element or a class, and there is no picture and no
 *   markup made from a string. The one link is a path to a docs guide ("/docs/<section>/<slug>", maybe "#id"),
 *   matched by `DOCS_PATH` and nothing looser; any other address, a full https:// one included, stays text.
 * - A reply with no marks is drawn exactly as every reply was before: one pre-wrapped block holding the text as it
 *   came. Only a reply that holds a mark takes the other path, where each line break and each empty line is still
 *   kept as it was.
 * - While a reply is arriving it is drawn again as it grows. A mark that has not closed yet is text (the parser
 *   needs it closed on its own line), so nothing jumps except the moment a mark completes. The parse is linear and
 *   each message is memoised on its text, so only the message still arriving is parsed again.
 */

const TEXT_CLASS = 'whitespace-pre-wrap leading-relaxed text-primary-foreground';

/** A docs guide path at the start of the text or after a space, not run on into more of a path or a word. */
const DOCS_PATH = /(^|\s)(\/docs\/[a-z0-9-]+\/[a-z0-9-]+(?:#[a-z0-9-]+)?)(?![\w/#-])/g;

/** Text with each docs guide path drawn as a link to it. Text without one comes back as the same string. */
function withDocsLinks(text: string, links: boolean, key: string | number = 0): ReactNode {
  if (!links || !text.includes('/docs/')) return text;
  const out: ReactNode[] = [];
  let from = 0;
  for (const match of text.matchAll(DOCS_PATH)) {
    const start = match.index + match[1].length;
    const path = match[2];
    if (start > from) out.push(text.slice(from, start));
    out.push(
      <Link key={`${key}-${start}`} href={path} prefetch={false} className="underline underline-offset-2">
        {path}
      </Link>,
    );
    from = start + path.length;
  }
  if (out.length === 0) return text;
  if (from < text.length) out.push(text.slice(from));
  return out;
}

/** The person's own words, as typed. */
export function TypedText({ text }: { text: string }) {
  return <div className={TEXT_CLASS}>{text}</div>;
}

export type ReplyBlock = Block | { kind: 'rule' };

/** A line that is only hyphens, three or more: a rule. */
const isRule = (line: string): boolean => /^[ \t]*-{3,}[ \t]*$/.test(line);

/** Cheap first look: without any of these characters at these places a reply has no mark and is not parsed. */
const MAY_HOLD_MARKS = /[*#]|^(?:- |\d{1,3}\. |[ \t]*-{3,}[ \t]*$)/m;

/**
 * The reply as blocks: the letters' blocks, plus `rule` for a line of hyphens. The empty lines directly above and
 * below a rule are the rule's own space and are not drawn as empty lines too.
 */
export function replyBlocks(text: string): ReplyBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReplyBlock[] = [];
  let segment: string[] = [];
  let afterRule = false;
  const close = (beforeRule: boolean) => {
    let from = 0;
    let to = segment.length;
    if (afterRule) while (from < to && segment[from] === '') from += 1;
    if (beforeRule) while (to > from && segment[to - 1] === '') to -= 1;
    if (to > from) for (const block of parseLetter(segment.slice(from, to).join('\n'))) blocks.push(block);
    segment = [];
  };
  for (const line of lines) {
    if (isRule(line)) {
      close(true);
      blocks.push({ kind: 'rule' });
      afterRule = true;
    } else {
      segment.push(line);
    }
  }
  close(false);
  return blocks;
}

const isPlain = (blocks: ReplyBlock[]): boolean =>
  blocks.every(
    (block) =>
      block.kind === 'gap' ||
      (block.kind === 'paragraph' && block.lines.every((line) => line.every((node) => node.t === 'text'))),
  );

function inline(content: Inline[], links: boolean): ReactNode[] {
  return content.map((node, index) => {
    if (node.t === 'text') return withDocsLinks(node.text, links, index);
    if (node.t === 'bold') {
      return (
        <strong key={index} className="font-semibold">
          {inline(node.children, links)}
        </strong>
      );
    }
    return <em key={index}>{inline(node.children, links)}</em>;
  });
}

/** A paragraph's lines as one run of children, each line break a "\n" in the text (the paragraph is pre-wrapped). */
function paragraphChildren(lines: Inline[][], links: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  const push = (node: ReactNode) => {
    const last = out.length - 1;
    if (typeof node === 'string' && typeof out[last] === 'string') out[last] = `${out[last]}${node}`;
    else out.push(node);
  };
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) push('\n');
    line.forEach((node, nodeIndex) => {
      if (node.t === 'text') push(node.text);
      else if (node.t === 'bold') {
        push(
          <strong key={`${lineIndex}-${nodeIndex}`} className="font-semibold">
            {inline(node.children, links)}
          </strong>,
        );
      } else push(<em key={`${lineIndex}-${nodeIndex}`}>{inline(node.children, links)}</em>);
    });
  });
  // Strings are joined above first, so a path is never split across two of them.
  return out.map((node, index) => (typeof node === 'string' ? withDocsLinks(node, links, index) : node));
}

function blockNode(block: ReplyBlock, key: number, links: boolean): ReactNode {
  switch (block.kind) {
    case 'heading':
      // Modest on purpose: a bold line, the first level a touch larger. A chat bubble is not a page.
      return block.level === 1 ? (
        <h3 key={key} className="text-[0.9375rem] font-semibold">
          {inline(block.content, links)}
        </h3>
      ) : (
        <h4 key={key} className="font-semibold">
          {inline(block.content, links)}
        </h4>
      );
    case 'gap':
      return (
        <p key={key} aria-hidden="true">
          <br />
        </p>
      );
    case 'paragraph':
      return (
        <p key={key} className="whitespace-pre-wrap">
          {paragraphChildren(block.lines, links)}
        </p>
      );
    case 'bullets':
      return (
        <ul key={key} className="list-disc pl-5">
          {block.items.map((item, index) => (
            <li key={index}>{inline(item, links)}</li>
          ))}
        </ul>
      );
    case 'numbers':
      return (
        <ol key={key} className="list-decimal pl-5">
          {block.items.map((item, index) => (
            // `value` is the number the parser read (one to three digits), never text.
            <li key={index} value={item.n}>
              {inline(item.content, links)}
            </li>
          ))}
        </ol>
      );
    case 'rule':
      return <hr key={key} className="my-2 border-primary-foreground/25" />;
  }
}

/**
 * The blocks of a reply that is still arriving. Stars at the very end may be half of a mark whose other half is in
 * the next piece ("**bold*" one moment, "**bold**" the next), and read now they would flash as italic. So they are
 * held back as text until something follows them or the reply is complete.
 */
function arrivingBlocks(text: string): ReplyBlock[] {
  let end = text.length;
  while (end > 0 && text[end - 1] === '*') end -= 1;
  if (end === text.length) return replyBlocks(text);
  const blocks = replyBlocks(text.slice(0, end));
  const stars: Inline = { t: 'text', text: text.slice(end) };
  const last = blocks[blocks.length - 1];
  // The stars belong to the last line, which is the last block unless the text before them ended a line.
  if (end > 0 && text[end - 1] !== '\n' && last) {
    if (last.kind === 'paragraph') return [...blocks.slice(0, -1), { ...last, lines: [...last.lines.slice(0, -1), [...last.lines[last.lines.length - 1], stars]] }];
    // A heading and a list item are read without the spaces at their ends: the ones before the stars are put back.
    let spaces = end;
    while (spaces > 0 && (text[spaces - 1] === ' ' || text[spaces - 1] === '\t')) spaces -= 1;
    const held: Inline = { t: 'text', text: text.slice(spaces) };
    if (last.kind === 'heading') return [...blocks.slice(0, -1), { ...last, content: [...last.content, held] }];
    if (last.kind === 'bullets') return [...blocks.slice(0, -1), { ...last, items: [...last.items.slice(0, -1), [...last.items[last.items.length - 1], held]] }];
    if (last.kind === 'numbers') {
      const item = last.items[last.items.length - 1];
      return [...blocks.slice(0, -1), { ...last, items: [...last.items.slice(0, -1), { ...item, content: [...item.content, held] }] }];
    }
  }
  return [...blocks, { kind: 'paragraph', lines: [[stars]] }];
}

/**
 * An assistant's words, with the few marks a reply may carry drawn. `arriving` is set for the piece of the reply
 * that is still being written.
 */
export const ReplyText = memo(function ReplyText({ text, arriving = false }: { text: string; arriving?: boolean }) {
  // A docs path is drawn as a link only once the reply is complete: while it arrives, a path may be half written.
  const links = !arriving;
  if (!MAY_HOLD_MARKS.test(text)) return <div className={TEXT_CLASS}>{withDocsLinks(text, links)}</div>;
  const blocks = arriving ? arrivingBlocks(text) : replyBlocks(text);
  if (isPlain(blocks)) return <div className={TEXT_CLASS}>{withDocsLinks(text, links)}</div>;
  return (
    <div className="break-words leading-relaxed text-primary-foreground">
      {blocks.map((block, key) => blockNode(block, key, links))}
    </div>
  );
});
