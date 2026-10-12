import { Fragment, type ReactNode } from 'react';
import { type Block, type Inline, parseLetter } from '@/lib/people/letter-marks';
import { LetterHead } from './letter-head';

/**
 * The letter's body, drawn from the parsed tree. The rule of this file: text a person typed is only ever put in as a
 * React text child (which React escapes). Every element below is written out here with a fixed class; nothing in the
 * text chooses a tag, an attribute or a class, and there is no link, no image and no HTML string.
 *
 * A body with no marks draws as it always did: each line break kept, each empty line one line tall, spaces kept
 * (`whitespace-pre-wrap`), no margins between blocks.
 */

/** The classes used for each heading level (fixed). */
export const HEADING_CLASS = {
  1: 'break-after-avoid text-[1.0625rem] font-bold',
  2: 'break-after-avoid text-base font-semibold',
  3: 'break-after-avoid text-sm font-semibold',
} as const;

function inline(content: Inline[]): ReactNode {
  return content.map((node, index) => {
    if (node.t === 'text') return node.text;
    if (node.t === 'bold') return <strong key={index}>{inline(node.children)}</strong>;
    return <em key={index}>{inline(node.children)}</em>;
  });
}

function heading(block: Extract<Block, { kind: 'heading' }>, key: number): ReactNode {
  switch (block.level) {
    case 1:
      return (
        <h3 key={key} className={HEADING_CLASS[1]}>
          {inline(block.content)}
        </h3>
      );
    case 2:
      return (
        <h4 key={key} className={HEADING_CLASS[2]}>
          {inline(block.content)}
        </h4>
      );
    default:
      return (
        <h4 key={key} className={HEADING_CLASS[3]}>
          {inline(block.content)}
        </h4>
      );
  }
}

function blockNode(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case 'heading':
      return heading(block, key);
    case 'gap':
      return (
        <p key={key} aria-hidden="true">
          <br />
        </p>
      );
    case 'paragraph':
      return (
        <p key={key} className="whitespace-pre-wrap">
          {block.lines.map((line, index) => (
            <Fragment key={index}>
              {index > 0 ? <br /> : null}
              {inline(line)}
            </Fragment>
          ))}
        </p>
      );
    case 'bullets':
      return (
        <ul key={key} className="list-disc pl-6">
          {block.items.map((item, index) => (
            <li key={index} className="break-inside-avoid">
              {inline(item)}
            </li>
          ))}
        </ul>
      );
    case 'numbers':
      return (
        <ol key={key} className="list-decimal pl-6">
          {block.items.map((item, index) => (
            // `value` is the number the parser read (one to three digits), never text.
            <li key={index} value={item.n} className="break-inside-avoid">
              {inline(item.content)}
            </li>
          ))}
        </ol>
      );
  }
}

/** The letter's text with its formatting. A placeholder left in the text is shown as typed. */
export function LetterBody({ body }: { body: string }) {
  return <div className="break-words text-sm leading-relaxed">{parseLetter(body).map(blockNode)}</div>;
}

/**
 * The letter as it will be issued: letterhead, title, body. Used by the editors' Preview and (with the date and
 * recipient lines) mirrors the view. Never printed: only the view prints.
 */
export function LetterPreview({ title, body }: { title: string; body: string }) {
  return (
    <article data-letter-noprint className="space-y-4 rounded-md border bg-white p-6 text-black">
      <LetterHead />
      <h2 className="text-lg font-semibold">{title}</h2>
      <LetterBody body={body} />
    </article>
  );
}
