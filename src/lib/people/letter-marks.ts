/**
 * Formatting for letters, as pure functions: a parser from the plain-text body to a small tree, the toolbar's effect
 * on the text, the letterhead's lines, and a marks-free preview. The body stays plain text in the database. Nothing
 * here makes markup: the parser returns data (text lives only in `text` nodes), and the renderer
 * (`letter-body.tsx`) maps node kinds to a fixed set of elements.
 *
 * What the parser recognises (everything else is ordinary text):
 * - Lines. The body is split on "\n". One empty line is one `gap` block (so blank lines render exactly as they did
 *   when the body was shown as pre-wrapped text); one terminal "\n" is ignored. A line with text in it is not
 *   "empty" even if it is only spaces.
 * - Headings: a line that starts with `#`, `##` or `###`, then ONE space, then something other than spaces. `#tag`,
 *   `# ` alone and `####` are text.
 * - Bullet list: a line that starts with `- ` (dash, space) followed by something other than spaces. `-5`, `- `
 *   alone and a dash inside a sentence are text. Numbered list: one to three digits, `. ` (dot, space), then
 *   something other than spaces: `1.5 million` and `2026. ` followed by nothing are text. A list is the run of
 *   consecutive lines of one kind; a line indented before the marker is text. The number typed is kept (0 to 999) on
 *   screen.
 * - Paragraph: the other consecutive non-empty lines, line breaks kept.
 * - Inline, one line at a time: `**bold**` and `*italic*`. Bold may contain italic and italic may contain bold;
 *   nothing deeper. A mark must close on the same line, must not start or end with a space and must hold something
 *   besides stars and spaces; otherwise its characters stay text. `{placeholders}` are never marks.
 *
 * - A star inside a word or number is text: an opening mark directly after a letter or digit, and a closing mark
 *   directly before one, do not count (`a*b*c`, `2*3*4`). `\r\n` and a lone `\r` are read as `\n`.
 *
 * Linear in the length of the input: no backtracking pattern, every closing search is paid for from a budget
 * proportional to the line (the budget is tested before each step of a search, so a long run of stars is not
 * rescanned once it is spent), and a line that runs out of budget keeps the rest as text.
 */

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'bold'; children: Inline[] }
  | { t: 'italic'; children: Inline[] };

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; content: Inline[] }
  | { kind: 'paragraph'; lines: Inline[][] }
  | { kind: 'bullets'; items: Inline[][] }
  /** `n` is the number as typed (one to three digits), kept so a list split by blank lines still reads 1, 2, 3. */
  | { kind: 'numbers'; items: { n: number; content: Inline[] }[] }
  /** One empty line of the body. */
  | { kind: 'gap' };

type MarkKind = 'bold' | 'italic';

const isSpace = (ch: string): boolean => ch.trim() === '';

/** A letter or digit (any script): a star touching one is part of a word or number, not a mark. */
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

// ---- Inline ---------------------------------------------------------------------------

/** Whether `content` may sit inside a mark: no space at either end, and more than stars and spaces. */
function validContent(content: string): boolean {
  if (content === '' || isSpace(content[0]) || isSpace(content[content.length - 1])) return false;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] !== '*' && !isSpace(content[i])) return true;
  }
  return false;
}

/**
 * Where the mark that opened just before `from` closes: for bold the index of the last two stars of the first run of
 * two or more stars; for italic the index of the first lone star (runs of two or more are bold marks and are
 * skipped). -1 when there is none, or the budget is spent.
 */
function findClose(s: string, from: number, kind: MarkKind, budget: { left: number }): number {
  let p = from;
  for (;;) {
    if (budget.left < 0) return -1;
    const q = s.indexOf('*', p);
    if (q < 0) return -1;
    budget.left -= q - p + 1;
    let r = q;
    while (r < s.length && s[r] === '*' && budget.left >= 0) {
      r += 1;
      budget.left -= 1;
    }
    if (budget.left < 0) return -1;
    const run = r - q;
    if (kind === 'bold') {
      if (run >= 2 && !isWordChar(s[r])) return r - 2;
    } else if (run === 1 && !isWordChar(s[r])) {
      return q;
    }
    p = r;
  }
}

function parseInline(s: string, allowed: readonly MarkKind[], budget: { left: number }): Inline[] {
  const out: Inline[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer !== '') out.push({ t: 'text', text: buffer });
    buffer = '';
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '*' && !isWordChar(s[i - 1])) {
      const double = s[i + 1] === '*';
      const kind: MarkKind | null = double
        ? allowed.includes('bold')
          ? 'bold'
          : null
        : allowed.includes('italic')
          ? 'italic'
          : null;
      if (kind) {
        const width = kind === 'bold' ? 2 : 1;
        const from = i + width;
        const close = findClose(s, from, kind, budget);
        if (close > from) {
          const content = s.slice(from, close);
          if (validContent(content)) {
            flush();
            out.push({ t: kind, children: parseInline(content, allowed.filter((m) => m !== kind), budget) });
            i = close + width;
            continue;
          }
        }
      }
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return out;
}

/** One line's inline content. */
export function parseInlineLine(line: string): Inline[] {
  return parseInline(line, ['bold', 'italic'], { left: 8 * line.length + 64 });
}

// ---- Blocks ---------------------------------------------------------------------------

export type LinePrefix =
  | { kind: 'heading'; level: 1 | 2 | 3; length: number }
  | { kind: 'bullet'; length: number }
  | { kind: 'number'; length: number };

/**
 * The block marker a line starts with. With `requireContent` (the parser) something other than spaces must follow
 * it; without (the toolbar, which also toggles a marker that has nothing after it yet) it need not.
 */
export function linePrefix(line: string, requireContent = true): LinePrefix | null {
  const found = ((): LinePrefix | null => {
    let hashes = 0;
    while (hashes < 4 && line[hashes] === '#') hashes += 1;
    if (hashes >= 1 && hashes <= 3 && line[hashes] === ' ') {
      return { kind: 'heading', level: hashes as 1 | 2 | 3, length: hashes + 1 };
    }
    if (line.startsWith('- ')) return { kind: 'bullet', length: 2 };
    let digits = 0;
    while (digits < 4 && line[digits] >= '0' && line[digits] <= '9') digits += 1;
    if (digits >= 1 && digits <= 3 && line[digits] === '.' && line[digits + 1] === ' ') {
      return { kind: 'number', length: digits + 2 };
    }
    return null;
  })();
  if (!found) return null;
  if (requireContent && line.slice(found.length).trim() === '') return null;
  return found;
}

export function parseLetter(body: string): Block[] {
  if (body === '') return [];
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

  const blocks: Block[] = [];
  let paragraph: Inline[][] = [];
  let list: Extract<Block, { kind: 'bullets' | 'numbers' }> | null = null;
  const closeParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', lines: paragraph });
    paragraph = [];
  };
  const closeList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  for (const line of lines) {
    if (line === '') {
      closeParagraph();
      closeList();
      blocks.push({ kind: 'gap' });
      continue;
    }
    const prefix = linePrefix(line);
    if (prefix?.kind === 'heading') {
      closeParagraph();
      closeList();
      blocks.push({ kind: 'heading', level: prefix.level, content: parseInlineLine(line.slice(prefix.length).trim()) });
      continue;
    }
    if (prefix) {
      closeParagraph();
      const kind = prefix.kind === 'bullet' ? 'bullets' : 'numbers';
      if (list && list.kind !== kind) closeList();
      const content = parseInlineLine(line.slice(prefix.length).trim());
      if (kind === 'bullets') {
        if (!list) list = { kind, items: [] };
        (list as Extract<Block, { kind: 'bullets' }>).items.push(content);
      } else {
        if (!list) list = { kind, items: [] };
        (list as Extract<Block, { kind: 'numbers' }>).items.push({ n: Number(line.slice(0, prefix.length - 2)), content });
      }
      continue;
    }
    closeList();
    paragraph.push(parseInlineLine(line));
  }
  closeParagraph();
  closeList();
  return blocks;
}

/** The characters of some inline content with the marks taken off. */
export function inlineText(content: Inline[]): string {
  return content.map((node) => (node.t === 'text' ? node.text : inlineText(node.children))).join('');
}

/**
 * The letter as plain lines with the marks taken off (headings as their text, list items with a "• " or "n. "),
 * for places that show a few lines of a body (the template lists). For a body with no marks this is the body.
 */
export function plainPreview(body: string): string {
  const lines: string[] = [];
  for (const block of parseLetter(body)) {
    if (block.kind === 'gap') lines.push('');
    else if (block.kind === 'heading') lines.push(inlineText(block.content));
    else if (block.kind === 'paragraph') for (const line of block.lines) lines.push(inlineText(line));
    else if (block.kind === 'bullets') for (const item of block.items) lines.push(`• ${inlineText(item)}`);
    else for (const item of block.items) lines.push(`${item.n}. ${inlineText(item.content)}`);
  }
  return lines.join('\n');
}

// ---- The letterhead's lines -------------------------------------------------------------

export type LetterheadDetails = {
  name: string;
  registration_no: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
};

export type LetterheadLines = {
  /** The name, trimmed; empty when there is none. */
  name: string;
  /** Under the name, in order: "(Reg. No. …)" on its own line, then the address on one line. Blank parts left out. */
  details: string[];
};

const commaParts = (value: string | null): string[] =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .filter((part) => part !== '');

/** The lines a letterhead draws. The address is "<address>, <postcode> <city>, <state>" without empty parts or stray commas. */
export function letterHeadLines(details: LetterheadDetails): LetterheadLines {
  const lines: string[] = [];
  const registration = (details.registration_no ?? '').trim().replace(/\s+/g, ' ');
  if (registration !== '') lines.push(`(Reg. No. ${registration})`);
  const area = [...commaParts(details.postcode), ...commaParts(details.city)].join(' ');
  const address = [...commaParts(details.address), ...(area === '' ? [] : [area]), ...commaParts(details.state)].join(', ');
  if (address !== '') lines.push(address);
  return { name: details.name.trim().replace(/\s+/g, ' '), details: lines };
}

// ---- The toolbar ---------------------------------------------------------------------

export type Mark = 'bold' | 'italic' | 'heading' | 'bullet' | 'number';

export type MarkResult = { ok: true; text: string; selStart: number; selEnd: number } | { ok: false; error: string };

const tooLong = (max: number): MarkResult => ({ ok: false, error: `That would make the letter text longer than ${max} characters.` });

type Span = { start: number; end: number };

/** The lines of `text`, each as [start, end) without its "\n". */
function lineSpans(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  for (;;) {
    const end = text.indexOf('\n', start);
    if (end < 0) {
      spans.push({ start, end: text.length });
      return spans;
    }
    spans.push({ start, end });
    start = end + 1;
  }
}

/** Whether `part` already holds the mark's own characters (a run of two or more stars for bold, an odd run for italic). */
function holdsMark(part: string, mark: 'bold' | 'italic'): boolean {
  let i = 0;
  while (i < part.length) {
    if (part[i] !== '*') {
      i += 1;
      continue;
    }
    let j = i;
    while (j < part.length && part[j] === '*') j += 1;
    if (mark === 'bold' ? j - i >= 2 : (j - i) % 2 === 1) return true;
    i = j;
  }
  return false;
}

function wrapSelection(text: string, a: number, b: number, mark: 'bold' | 'italic', max: number): MarkResult {
  const m = mark === 'bold' ? '**' : '*';
  const segments: Span[] = [];
  for (const line of lineSpans(text)) {
    if (line.end < a || line.start > b) continue;
    let s = Math.max(a, line.start);
    let e = Math.min(b, line.end);
    // A selection that starts at the start of a line leaves the line's list or heading marker outside the mark.
    if (s === line.start) s += linePrefix(text.slice(line.start, line.end), false)?.length ?? 0;
    while (s < e && isSpace(text[s])) s += 1;
    while (e > s && isSpace(text[e - 1])) e -= 1;
    if (e > s) segments.push({ start: s, end: e });
  }
  let result: { text: string; selStart: number; selEnd: number };
  if (segments.length === 0) {
    // Never inside a line's own marker: "- " gives "- ****", not "****- ".
    const home = lineSpans(text).find((line) => line.start <= a && a <= line.end);
    const at = home ? Math.max(a, Math.min(home.end, home.start + (linePrefix(text.slice(home.start, home.end), false)?.length ?? 0))) : a;
    result = { text: text.slice(0, at) + m + m + text.slice(at), selStart: at + m.length, selEnd: at + m.length };
  } else {
    const first = segments[0];
    const last = segments[segments.length - 1];
    const only = segments.length === 1 ? first : null;
    const italic = mark === 'italic';
    const around =
      only !== null &&
      text.slice(only.start - m.length, only.start) === m &&
      text.slice(only.end, only.end + m.length) === m &&
      (!italic || (text[only.start - 2] !== '*' && text[only.end + 1] !== '*'));
    const inside =
      only !== null &&
      only.end - only.start >= 2 * m.length + 1 &&
      text.slice(only.start, only.start + m.length) === m &&
      text.slice(only.end - m.length, only.end) === m &&
      (!italic || (text[only.start + 1] !== '*' && text[only.end - 2] !== '*'));
    if (only && around) {
      result = {
        text: text.slice(0, only.start - m.length) + text.slice(only.start, only.end) + text.slice(only.end + m.length),
        selStart: only.start - m.length,
        selEnd: only.end - m.length,
      };
    } else if (only && inside) {
      result = {
        text: text.slice(0, only.start) + text.slice(only.start + m.length, only.end - m.length) + text.slice(only.end),
        selStart: only.start,
        selEnd: only.end - 2 * m.length,
      };
    } else {
      for (const seg of segments) {
        if (holdsMark(text.slice(seg.start, seg.end), mark)) {
          return {
            ok: false,
            error:
              mark === 'bold'
                ? 'The selection already has ** in it. Take those off first, or select less.'
                : 'The selection already has a single * in it. Take it off first, or select less.',
          };
        }
      }
      let out = '';
      let cursor = 0;
      for (const seg of segments) {
        out += text.slice(cursor, seg.start) + m + text.slice(seg.start, seg.end) + m;
        cursor = seg.end;
      }
      out += text.slice(cursor);
      result = {
        text: out,
        selStart: first.start + m.length,
        selEnd: last.end + m.length * (2 * (segments.length - 1) + 1),
      };
    }
  }
  return result.text.length > max && result.text.length > text.length ? tooLong(max) : { ok: true, ...result };
}

function prefixLines(text: string, a: number, b: number, mark: 'heading' | 'bullet' | 'number', max: number): MarkResult {
  const lines = lineSpans(text);
  const targets = lines.filter((line) =>
    a === b ? line.start <= a && a <= line.end : line.start < b && (line.end > a || line.start === a),
  );
  let eligible = targets.filter((line) => text.slice(line.start, line.end).trim() !== '');
  if (eligible.length === 0 && targets.length === 1) eligible = targets;
  if (eligible.length === 0) return { ok: true, text, selStart: a, selEnd: b };

  const kindOf = mark === 'number' ? 'number' : mark;
  const olds = eligible.map((line) => linePrefix(text.slice(line.start, line.end), false));
  const allHave = olds.every((old) => old?.kind === kindOf);
  const news = eligible.map((_, index) => (allHave ? '' : mark === 'heading' ? '## ' : mark === 'bullet' ? '- ' : `${index + 1}. `));

  let out = '';
  let cursor = 0;
  const changes = eligible.map((line, index) => {
    const oldLength = olds[index]?.length ?? 0;
    out += text.slice(cursor, line.start) + news[index];
    cursor = line.start + oldLength;
    return { start: line.start, oldLength, newLength: news[index].length };
  });
  out += text.slice(cursor);

  const map = (p: number): number => {
    let shift = 0;
    for (const change of changes) {
      if (p < change.start) break;
      const into = p - change.start;
      if (into >= change.oldLength) shift += change.newLength - change.oldLength;
      else return p + shift + Math.min(into, change.newLength) - into;
    }
    return p + shift;
  };
  const selStart = map(a);
  const selEnd = Math.max(selStart, map(b));
  return out.length > max && out.length > text.length ? tooLong(max) : { ok: true, text: out, selStart, selEnd };
}

/**
 * What a toolbar button does to `text` with the selection `selStart..selEnd` (either order; a caret has both equal).
 * - bold, italic: the selection of each line, without the spaces at its ends, is wrapped in `**` or `*`; a caret or a
 *   selection of spaces inserts an empty pair with the caret inside. Pressing it again on a single-line selection
 *   that is already wrapped (the selection or the text around it) takes the marks off. The selection afterwards is the
 *   wrapped text, so a second press is that toggle.
 * - heading: every non-empty line touched gets `## `, replacing any other block marker; if they all already start
 *   with a heading marker it is removed. A caret on an empty line gets the marker.
 * - bullet, number: the same with `- ` or `1. `, `2. `, … (numbered over the lines touched).
 * Refused, with a sentence, when the result would pass `max` characters (a result that is no longer than the text is
 * never refused).
 */
export function applyMark(text: string, selStart: number, selEnd: number, mark: Mark, max: number): MarkResult {
  const clamp = (n: number) => Math.min(Math.max(Math.trunc(Number.isFinite(n) ? n : 0), 0), text.length);
  const a = Math.min(clamp(selStart), clamp(selEnd));
  const b = Math.max(clamp(selStart), clamp(selEnd));
  return mark === 'bold' || mark === 'italic' ? wrapSelection(text, a, b, mark, max) : prefixLines(text, a, b, mark, max);
}
