import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type ComponentProps, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LetterBody, HEADING_CLASS } from '@/components/people/letter-body';
import { LetterHead, LetterheadProvider } from '@/components/people/letter-head';
import { LETTER_BODY_MAX } from '@/lib/people/document-forms';
import {
  type Block,
  type Inline,
  type LetterheadDetails,
  type Mark,
  applyMark,
  inlineText,
  letterHeadLines,
  linePrefix,
  parseLetter,
  plainPreview,
} from '@/lib/people/letter-marks';
import { createSeedPeopleData } from '@/lib/people/seed';

const T = (text: string): Inline => ({ t: 'text', text });
const paragraph = (...lines: Inline[][]): Block => ({ kind: 'paragraph', lines });

/** Every character of the tree, in order, with line breaks as "\n" (marks and list markers are not characters). */
function plainOf(blocks: Block[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'gap') lines.push('');
    else if (block.kind === 'paragraph') for (const line of block.lines) lines.push(inlineText(line));
    else if (block.kind === 'heading') lines.push(inlineText(block.content));
    else if (block.kind === 'bullets') for (const item of block.items) lines.push(inlineText(item));
    else for (const item of block.items) lines.push(inlineText(item.content));
  }
  return lines.join('\n');
}

const render = (body: string): string => renderToStaticMarkup(createElement(LetterBody, { body }));
const ELEMENTS = new Set(['div', 'p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'h3', 'h4']);
const ATTRIBUTES = new Set(['class', 'aria-hidden', 'value']);

/** The tag and attribute names in the markup. */
function shape(html: string): { tags: Set<string>; attributes: Set<string> } {
  const tags = new Set<string>();
  const attributes = new Set<string>();
  for (const m of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
    tags.add(m[1]);
    for (const a of m[2].matchAll(/\s([a-zA-Z-]+)=/g)) attributes.add(a[1]);
  }
  return { tags, attributes };
}

/** The visible lines of the markup: one line per paragraph line, heading and list item; a gap is an empty line. */
function visible(html: string): string {
  const unescape = (t: string) =>
    t.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const blocks = html.match(/<(p|h3|h4|ul|ol)[ >].*?<\/\1>/g) ?? [];
  return blocks
    .map((block) => {
      if (block.startsWith('<p aria-hidden')) return '';
      return unescape(
        block
          .replace(/<\/li>/g, '\n')
          .replace(/<br\s*\/?>/g, '\n')
          .replace(/<[^>]*>/g, '')
          .replace(/\n$/, ''),
      );
    })
    .join('\n');
}

describe('parseLetter: blocks', () => {
  it('reads headings of three levels, a bullet list, a numbered list and a paragraph', () => {
    const tree = parseLetter('# One\n## Two\n### Three\nPlain line\n- a\n- b\n1. x\n2. y');
    expect(tree).toEqual([
      { kind: 'heading', level: 1, content: [T('One')] },
      { kind: 'heading', level: 2, content: [T('Two')] },
      { kind: 'heading', level: 3, content: [T('Three')] },
      paragraph([T('Plain line')]),
      { kind: 'bullets', items: [[T('a')], [T('b')]] },
      { kind: 'numbers', items: [{ n: 1, content: [T('x')] }, { n: 2, content: [T('y')] }] },
    ]);
  });
  it('keeps the line breaks inside a paragraph and makes each empty line a gap', () => {
    expect(parseLetter('a\nb\n\nc')).toEqual([paragraph([T('a')], [T('b')]), { kind: 'gap' }, paragraph([T('c')])]);
    expect(parseLetter('a\n\n\nb').filter((b) => b.kind === 'gap')).toHaveLength(2);
  });
  it('starts a new list when the kind changes, and ends a list at a plain line', () => {
    expect(parseLetter('- a\n1. b\n- c').map((b) => b.kind)).toEqual(['bullets', 'numbers', 'bullets']);
    expect(parseLetter('- a\nplain\n- b').map((b) => b.kind)).toEqual(['bullets', 'paragraph', 'bullets']);
  });
  it('gives nothing for an empty body', () => {
    expect(parseLetter('')).toEqual([]);
  });
});

describe('parseLetter: what is text', () => {
  const asText = (line: string) => expect(parseLetter(line), line).toEqual([paragraph([T(line)])]);
  it('leaves "1.5 million", "- " alone, a dash in a sentence, "-5 degrees" and an indented marker as text', () => {
    for (const line of ['1.5 million', '- ', '-', '-5 degrees', 'a - b', 'It is 5 - 3.', '  - indented', '  1. indented', '12345. five digits', '1) paren', '1.']) {
      asText(line);
    }
  });
  it('leaves "#hashtag", "# " alone, "#" alone, four hashes and a marker with only spaces after it as text', () => {
    for (const line of ['#hashtag', '# ', '#', '####  x', '#### x', '##  ', '-    ', '2.    ']) asText(line);
  });
  it('treats a marker with content as a block', () => {
    expect(linePrefix('# a')).toEqual({ kind: 'heading', level: 1, length: 2 });
    expect(linePrefix('- a')).toEqual({ kind: 'bullet', length: 2 });
    expect(linePrefix('12. a')).toEqual({ kind: 'number', length: 4 });
    expect(linePrefix('# ')).toBeNull();
    expect(linePrefix('# ', false)).toEqual({ kind: 'heading', level: 1, length: 2 });
  });
});

describe('parseLetter: inline marks', () => {
  const only = (body: string) => (parseLetter(body)[0] as Extract<Block, { kind: 'paragraph' }>).lines[0];
  it('reads bold and italic', () => {
    expect(only('a **b** c')).toEqual([T('a '), { t: 'bold', children: [T('b')] }, T(' c')]);
    expect(only('a *b* c')).toEqual([T('a '), { t: 'italic', children: [T('b')] }, T(' c')]);
  });
  it('lets bold hold italic and italic hold bold, and nothing deeper', () => {
    expect(only('**a *b* c**')).toEqual([
      { t: 'bold', children: [T('a '), { t: 'italic', children: [T('b')] }, T(' c')] },
    ]);
    expect(only('*a **b** c*')).toEqual([
      { t: 'italic', children: [T('a '), { t: 'bold', children: [T('b')] }, T(' c')] },
    ]);
    expect(only('***x***')).toEqual([{ t: 'bold', children: [{ t: 'italic', children: [T('x')] }] }]);
    const deep = only('**a *b **c** b* a**');
    const depth = (nodes: Inline[]): number => Math.max(0, ...nodes.map((n) => (n.t === 'text' ? 0 : 1 + depth(n.children))));
    expect(depth(deep)).toBeLessThanOrEqual(2);
  });
  it('leaves an unclosed mark, an empty mark, a mark with spaces at its ends and a mark of only spaces as text', () => {
    for (const line of ['**unclosed', '*unclosed', 'a * b', '2 * 3 * 4', '** x **', '* x *', '**  **', '****', '**', '*', '* *']) {
      expect(only(line), line).toEqual([T(line)]);
    }
  });
  it('does not carry a mark over a line break', () => {
    const [p] = parseLetter('**a\nb**') as Extract<Block, { kind: 'paragraph' }>[];
    expect(p.lines).toEqual([[T('**a')], [T('b**')]]);
  });
  it('reads marks in headings and list items, and a placeholder inside a mark is plain text', () => {
    expect(parseLetter('# **a**')[0]).toEqual({ kind: 'heading', level: 1, content: [{ t: 'bold', children: [T('a')] }] });
    expect(parseLetter('- *a*')[0]).toEqual({ kind: 'bullets', items: [[{ t: 'italic', children: [T('a')] }]] });
    expect(only('**{designation}**')).toEqual([{ t: 'bold', children: [T('{designation}')] }]);
  });
});

describe('parseLetter: hostile text stays text', () => {
  const hostile = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[x](javascript:alert(1))',
    '![x](y)',
    '&lt;b&gt; &amp; &#60;',
    '<a href="javascript:alert(1)">x</a>',
    '"><svg onload=alert(1)>',
    '{{constructor}} ${process.env.SECRET} `x`',
  ];
  for (const text of hostile) {
    it(`${text.slice(0, 30)}: the tree is one text node with the same characters`, () => {
      expect(parseLetter(text)).toEqual([paragraph([T(text)])]);
    });
    it(`${text.slice(0, 30)}: the markup holds only fixed elements, the characters escaped`, () => {
      const html = render(text);
      const { tags, attributes } = shape(html);
      expect([...tags].filter((t) => !ELEMENTS.has(t))).toEqual([]);
      expect([...attributes].filter((a) => !ATTRIBUTES.has(a))).toEqual([]);
      expect(visible(html)).toBe(text);
    });
  }
  it('hostile text inside marks, headings and lists is still only text in fixed elements', () => {
    const body = `# <script>alert(1)</script>\n- **<img src=x onerror=alert(1)>**\n1. *[x](javascript:alert(1))*\n**![x](y)**`;
    const html = render(body);
    const { tags, attributes } = shape(html);
    expect([...tags].filter((t) => !ELEMENTS.has(t))).toEqual([]);
    expect([...attributes].filter((a) => !ATTRIBUTES.has(a))).toEqual([]);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href');
    expect(visible(html)).toBe('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[x](javascript:alert(1))\n![x](y)');
  });
  it('10,000 stars come back as the same 10,000 characters in one text node', () => {
    const stars = '*'.repeat(10000);
    expect(parseLetter(stars)).toEqual([paragraph([T(stars)])]);
    expect(visible(render(stars))).toBe(stars);
  });
  it('deeply repeated and nested-looking marks return, with every non-mark character kept, at most two marks deep', () => {
    const depth = (nodes: Inline[]): number => Math.max(0, ...nodes.map((n) => (n.t === 'text' ? 0 : 1 + depth(n.children))));
    const inputs = [
      '*a'.repeat(5000),
      '**a'.repeat(3400),
      '**a *b '.repeat(1500),
      `${'**'.repeat(2500)}x${'**'.repeat(2500)}`,
      `${'* '.repeat(5000)}`,
      `${'*a* **b** '.repeat(900)}`,
      `${'***'.repeat(3300)}`,
    ];
    for (const input of inputs) {
      const tree = parseLetter(input);
      const letters = (s: string) => s.replace(/[*\s]/g, '');
      expect(letters(plainOf(tree)), input.slice(0, 12)).toBe(letters(input));
      for (const block of tree) if (block.kind === 'paragraph') for (const line of block.lines) expect(depth(line)).toBeLessThanOrEqual(2);
      // The renderer takes it, too.
      expect(letters(visible(render(input)))).toBe(letters(input));
    }
  });
  it('4,000 lines of marks parse as 4,000 lines', () => {
    const input = Array.from({ length: 4000 }, () => '**a *b').join('\n');
    const [p] = parseLetter(input) as Extract<Block, { kind: 'paragraph' }>[];
    expect(p.lines).toHaveLength(4000);
  });
});

describe('a letter with no marks reads back as it was typed', () => {
  const data = createSeedPeopleData(new Date('2026-10-12T04:00:00Z'));
  const startersInMigration = (() => {
    const sql = readFileSync(resolve('supabase/migrations/20261102090100_people_letters_writes.sql'), 'utf8');
    const bodies: string[] = [];
    for (const m of sql.matchAll(/E'((?:[^']|'')*)'/g)) {
      if (m[1].startsWith('{today}')) bodies.push(m[1].replace(/\\n/g, '\n').replace(/''/g, "'"));
    }
    return bodies;
  })();
  /** The raw text with one terminal newline dropped (the page never showed it as a line). */
  const same = (raw: string) => {
    const tree = parseLetter(raw);
    expect(plainOf(tree)).toBe(raw.endsWith('\n') ? raw.slice(0, -1) : raw);
    // Only paragraphs and gaps: no heading, no list.
    expect(tree.every((b) => b.kind === 'paragraph' || b.kind === 'gap')).toBe(true);
    const html = render(raw);
    expect(visible(html)).toBe(raw.endsWith('\n') ? raw.slice(0, -1) : raw);
    expect(html).not.toMatch(/<(strong|em|ul|ol|li|h3|h4)/);
    expect(plainPreview(raw)).toBe(raw.endsWith('\n') ? raw.slice(0, -1) : raw);
  };
  it("pins the demo's five letter bodies", async () => {
    const letters = await data.listLetters();
    expect(letters).toHaveLength(5);
    for (const l of letters) same(l.body);
  });
  it('pins the six English starter template bodies, and the demo templates', async () => {
    expect(startersInMigration).toHaveLength(6);
    for (const body of startersInMigration) same(body);
    const templates = await data.listLetterTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(6);
    for (const t of templates) same(t.body);
  });
  it('keeps multiple spaces, leading blank lines, runs of blank lines, a spaces-only line and tabs', () => {
    for (const raw of ['a  b   c', '\n\nHello', 'a\n\n\n\nb', 'a\n   \nb', 'a\tb', 'x\n', 'x\n\n', '\n', '[Describe what happened, and when.]', 'Hello, 1.5 million (approx) - ok #1 *']) {
      same(raw);
    }
  });
  it('draws each blank line one line tall and each paragraph with pre-wrap', () => {
    const html = render('a\nb\n\nc');
    expect(html).toBe(
      '<div class="break-words text-sm leading-relaxed"><p class="whitespace-pre-wrap">a<br/>b</p><p aria-hidden="true"><br/></p><p class="whitespace-pre-wrap">c</p></div>',
    );
  });
});

describe('the renderer maps node kinds to fixed elements', () => {
  it('draws each kind with the elements and classes written in the file', () => {
    const html = render('# H1\n## H2\n### H3\n**b** *i*\n- x\n1. y');
    expect(html).toContain(`<h3 class="${HEADING_CLASS[1]}">H1</h3>`);
    expect(html).toContain(`<h4 class="${HEADING_CLASS[2]}">H2</h4>`);
    expect(html).toContain(`<h4 class="${HEADING_CLASS[3]}">H3</h4>`);
    expect(html).toContain('<strong>b</strong> <em>i</em>');
    expect(html).toContain('<ul class="list-disc pl-6"><li class="break-inside-avoid">x</li></ul>');
    expect(html).toContain('<ol class="list-decimal pl-6"><li value="1" class="break-inside-avoid">y</li></ol>');
  });
  it('keeps a heading with the line after it and a list item whole when printing', () => {
    for (const level of [1, 2, 3] as const) expect(HEADING_CLASS[level]).toContain('break-after-avoid');
  });
  it('shows a placeholder left in the text as typed, with no special styling', () => {
    expect(render('Dear {employee_name}, **{salary}**')).toContain('Dear {employee_name}, <strong>{salary}</strong>');
  });
});

describe('the source holds no way to turn text into markup', () => {
  const read = (path: string) => readFileSync(resolve(path), 'utf8');
  const FORBIDDEN = [/dangerouslySetInnerHTML/, /innerHTML/, /outerHTML/, /insertAdjacentHTML/, /<a[\s>]/, /<img[\s>]/, /createElement\(/, /document\.write/, /\beval\(/, /new Function/];
  for (const path of [
    'src/lib/people/letter-marks.ts',
    'src/components/people/letter-body.tsx',
    'src/components/people/letter-toolbar.tsx',
    'src/components/people/letter-form.tsx',
    'src/components/people/template-form.tsx',
    'src/components/people/letter-view.tsx',
  ]) {
    it(`${path} has none of them`, () => {
      const source = read(path);
      for (const pattern of FORBIDDEN) expect(source, String(pattern)).not.toMatch(pattern);
    });
  }
  it('the letterhead has no HTML string, one image, and takes its address only from logoUrl', () => {
    const source = read('src/components/people/letter-head.tsx');
    expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
    expect(source.match(/<img[\s>]/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/const url = head \? logoUrl\(head\.logo_path, \{ isDemo: head\.isDemo \}\) : null;/);
    expect(source).toContain('src={url}');
    expect(source).not.toMatch(/<a[\s>]/);
  });
  it('no regular expression in the parser repeats a group or a character class inside a repetition', () => {
    const source = read('src/lib/people/letter-marks.ts');
    expect(source).not.toMatch(/\([^)]*[+*][^)]*\)[+*]/);
  });
});

describe('the parser is linear in a long line', () => {
  const time = (input: string) => {
    const t0 = performance.now();
    parseLetter(input);
    return performance.now() - t0;
  };
  it('parses 100,000 stars in under 200 ms', () => {
    expect(time('*'.repeat(100000))).toBeLessThan(200);
  });
  it('parses 100,000 repetitions of "a*" in under 200 ms', () => {
    expect(time('a*'.repeat(100000))).toBeLessThan(200);
  });
});

describe('numbered lists keep the number that was typed', () => {
  const numbers = (body: string) =>
    parseLetter(body)
      .filter((b): b is Extract<Block, { kind: 'numbers' }> => b.kind === 'numbers')
      .flatMap((b) => b.items.map((i) => i.n));
  const values = (body: string) => [...render(body).matchAll(/<li value="(\d+)"/g)].map((m) => m[1]);
  it('shows 1, 2, 3 across three lists split by blank lines', () => {
    const body = '1. one\n\n2. two\n\n3. three';
    expect(numbers(body)).toEqual([1, 2, 3]);
    expect(values(body)).toEqual(['1', '2', '3']);
  });
  it('shows 3, 4 for a list that starts at 3, and 1, 1 for 1. 1. as typed', () => {
    expect(numbers('3. third\n4. fourth')).toEqual([3, 4]);
    expect(numbers('1. a\n1. b')).toEqual([1, 1]);
    expect(values('1. a\n1. b')).toEqual(['1', '1']);
  });
  it('the value is a number the parser built, from at most three digits', () => {
    expect(numbers('007. x')).toEqual([7]);
    expect(numbers('999. x')).toEqual([999]);
    expect(parseLetter('1000. x')).toEqual([paragraph([T('1000. x')])]);
  });
  it('the preview uses the typed number', () => {
    expect(plainPreview('3. third\n4. fourth')).toBe('3. third\n4. fourth');
  });
});

describe('a star inside a word or number is text', () => {
  const asText = (line: string) => expect(parseLetter(line), line).toEqual([paragraph([T(line)])]);
  it('leaves a*b*c, 2*3*4 and 5*4=20 and 3*2=6 as typed', () => {
    for (const line of ['a*b*c', '2*3*4', '5*4=20 and 3*2=6', 'x**y**z']) asText(line);
  });
  it('still reads marks at the edges of words and next to punctuation', () => {
    const only = (body: string) => (parseLetter(body)[0] as Extract<Block, { kind: 'paragraph' }>).lines[0];
    expect(only('**bold**')).toEqual([{ t: 'bold', children: [T('bold')] }]);
    expect(only('*italic*')).toEqual([{ t: 'italic', children: [T('italic')] }]);
    expect(only('(*note*)')).toEqual([T('('), { t: 'italic', children: [T('note')] }, T(')')]);
    expect(only('**bold**, then')).toEqual([{ t: 'bold', children: [T('bold')] }, T(', then')]);
  });
});

describe('line endings and look-alikes', () => {
  it('reads CRLF and a lone CR as a line feed', () => {
    expect(parseLetter('- a\r\n- b\r\n\r\nx')).toEqual(parseLetter('- a\n- b\n\nx'));
    expect(parseLetter('a\rb')).toEqual(parseLetter('a\nb'));
  });
  it('keeps a null character and the full-width look-alikes as text', () => {
    for (const text of ['a\u0000b', '＊a＊', '＃ x', '－ x']) {
      expect(parseLetter(text)).toEqual([paragraph([T(text)])]);
      expect(visible(render(text))).toBe(text);
    }
  });
});

describe('heading sizes', () => {
  it('gives each level its own size, the largest still modest, and ## larger than body text', () => {
    const size = (level: 1 | 2 | 3) => HEADING_CLASS[level].split(' ').find((c) => c.startsWith('text-'))!;
    expect(new Set([size(1), size(2), size(3)]).size).toBe(3);
    expect(size(2)).not.toBe('text-sm');
    expect(size(1)).not.toMatch(/xl/);
  });
});

describe('the starter templates, in their newest definition', () => {
  // private.hr_starter_letter_templates() was first written by 20261109133800 and is defined again, with five Bahasa
  // Malaysia bodies corrected ("di Jabatan {department}"), by the file read here: what a workspace is given today.
  const NEWEST = 'supabase/migrations/20261109140000_people_letterhead_hardening.sql';
  const startersIn = (file: string) => {
    const sql = readFileSync(resolve(file), 'utf8');
    const bodies: string[] = [];
    for (const m of sql.matchAll(/E'((?:[^']|'')*)'/g)) {
      if (m[1].startsWith('{today}')) bodies.push(m[1].replace(/\\n/g, '\n').replace(/''/g, "'"));
    }
    return bodies;
  };

  it('is the newest: no later migration defines the starter list again', () => {
    const files = readdirSync(resolve('supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
    const defining = files.filter((f) => readFileSync(resolve('supabase/migrations', f), 'utf8').includes('create or replace function private.hr_starter_letter_templates('));
    expect(defining.at(-1)).toBe(NEWEST.split('/').at(-1));
  });

  it('no Bahasa Malaysia body keeps the lower-case "di jabatan {department}", and each keeps exactly the placeholders it had', () => {
    const now = startersIn(NEWEST);
    const was = startersIn('supabase/migrations/20261109133800_people_letter_salary_templates.sql');
    expect(was).toHaveLength(12);
    for (let i = 6; i < 12; i += 1) {
      expect(now[i]).not.toContain('di jabatan {department}');
      expect(now[i].match(/\{[^}]*\}/g)).toEqual(was[i].match(/\{[^}]*\}/g));
    }
    expect(now.filter((body) => body.includes('di Jabatan {department}'))).toHaveLength(5);
    expect(now.slice(0, 6)).toEqual(was.slice(0, 6));
  });

  it('pins all twelve (six English, six Bahasa Malaysia) as rendering unchanged', () => {
    const bodies = startersIn(NEWEST);
    expect(bodies).toHaveLength(12);
    for (const body of bodies) {
      const tree = parseLetter(body);
      expect(tree.every((b) => b.kind === 'paragraph' || b.kind === 'gap')).toBe(true);
      expect(plainOf(tree)).toBe(body);
      expect(visible(render(body))).toBe(body);
      expect(render(body)).not.toMatch(/<(strong|em|ul|ol|li|h3|h4)/);
    }
  });
});

describe('print rules', () => {
  it('keep a heading with what follows even across a blank line', () => {
    const source = readFileSync(resolve('src/components/people/letter-view.tsx'), 'utf8');
    expect(source).toContain('[data-letter-print] :is(h3, h4) + p[aria-hidden] { break-after: avoid; }');
  });

  it('undo the centring of the dialog, which is done with translate and not transform, or the letter prints off the page', () => {
    const source = readFileSync(resolve('src/components/people/letter-view.tsx'), 'utf8');
    const rule = /\[data-letter-dialog\] \{([^}]*)\}/.exec(source)?.[1] ?? '';
    expect(rule).toContain('position: static !important');
    expect(rule).toContain('translate: none !important');
    expect(rule).toContain('transform: none !important');
  });
});

describe('letterHeadLines', () => {
  const base: LetterheadDetails = { name: 'Rimba Ventures Sdn Bhd', registration_no: null, address: null, city: null, state: null, postcode: null };
  it('gives only the name when nothing else is set', () => {
    expect(letterHeadLines(base)).toEqual({ name: 'Rimba Ventures Sdn Bhd', details: [] });
  });
  it('puts the registration number on its own line as "(Reg. No. …)"', () => {
    expect(letterHeadLines({ ...base, registration_no: '202401012345 (1234567-X)' }).details).toEqual(['(Reg. No. 202401012345 (1234567-X))']);
  });
  it('joins the address as "<address>, <postcode> <city>, <state>"', () => {
    const full = { ...base, address: 'Level 5, Menara Rimba, Jalan Ampang', postcode: '50450', city: 'Kuala Lumpur', state: 'Wilayah Persekutuan' };
    expect(letterHeadLines({ ...full, registration_no: '123' }).details).toEqual([
      '(Reg. No. 123)',
      'Level 5, Menara Rimba, Jalan Ampang, 50450 Kuala Lumpur, Wilayah Persekutuan',
    ]);
  });
  it('leaves out blank parts and never makes ", ," or a leading or trailing comma', () => {
    const cases: [Partial<LetterheadDetails>, string][] = [
      [{ address: '1 Jalan A' }, '1 Jalan A'],
      [{ city: 'Ipoh' }, 'Ipoh'],
      [{ postcode: '30000' }, '30000'],
      [{ postcode: '30000', city: 'Ipoh' }, '30000 Ipoh'],
      [{ address: '1 Jalan A', state: 'Perak' }, '1 Jalan A, Perak'],
      [{ address: '1 Jalan A,', city: 'Ipoh' }, '1 Jalan A, Ipoh'],
      [{ address: ' , 1 Jalan A , , ', city: ' ', state: ',', postcode: '' }, '1 Jalan A'],
      [{ address: '', city: '  ', state: 'Perak' }, 'Perak'],
      [{ address: '1 Jalan A\n  Taman B', state: 'Perak' }, '1 Jalan A Taman B, Perak'],
    ];
    for (const [over, expected] of cases) {
      const lines = letterHeadLines({ ...base, ...over }).details;
      expect(lines, JSON.stringify(over)).toEqual([expected]);
      expect(lines[0]).not.toMatch(/,\s*,|^\s*,|,\s*$/);
    }
  });
  it('gives no address line for blank parts, and a blank registration number is left out', () => {
    expect(letterHeadLines({ ...base, registration_no: '   ', address: ' ', city: '', state: ',,', postcode: ' ' }).details).toEqual([]);
  });
  it('trims the name and gives an empty name for a blank one', () => {
    expect(letterHeadLines({ ...base, name: '  Rimba   Ventures ' }).name).toBe('Rimba Ventures');
    expect(letterHeadLines({ ...base, name: '   ' }).name).toBe('');
  });
});

describe('LetterHead', () => {
  const head = (over: Record<string, unknown> = {}) => ({
    name: 'Rimba Ventures',
    registration_no: '123-X',
    address: '1 Jalan A',
    city: 'Ipoh',
    state: 'Perak',
    postcode: '30000',
    logo_path: null as string | null,
    isDemo: false,
    ...over,
  });
  const draw = (value: ReturnType<typeof head> | null, workspaceName = 'Rimba Ventures') =>
    renderToStaticMarkup(createElement(LetterheadProvider, { head: value, workspaceName } as ComponentProps<typeof LetterheadProvider>, createElement(LetterHead)));
  it('draws the name and lines with no logo when the workspace has none', () => {
    const html = draw(head());
    expect(html).toContain('Rimba Ventures');
    expect(html).toContain('(Reg. No. 123-X)');
    expect(html).toContain('1 Jalan A, 30000 Ipoh, Perak');
    expect(html).not.toContain('<img');
  });
  it('draws the logo from the workspace path only, with the alt text and a print-friendly height', () => {
    const previous = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
    try {
      const org = '11111111-1111-4111-8111-111111111111';
      const file = '22222222-2222-4222-8222-222222222222';
      const html = draw(head({ logo_path: `${org}/${file}.png` }));
      expect(html).toContain(`src="https://x.supabase.co/storage/v1/object/public/org-logos/${org}/${file}.png"`);
      expect(html).toContain('alt="Rimba Ventures logo"');
      expect(html).toMatch(/class="[^"]*max-h-16[^"]*print:max-h-20/);
      // A malformed path never becomes an address.
      expect(draw(head({ logo_path: '../../x.png' }))).not.toContain('<img');
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = previous;
    }
  });
  it('draws the demo sample logo for the demo workspace without a logo of its own', () => {
    expect(draw(head({ isDemo: true }))).toContain('src="/demo-logo.png"');
  });
  it('draws only the workspace name when the details could not be read', () => {
    const html = draw(null, 'Rimba Ventures');
    expect(html).toContain('Rimba Ventures');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('Reg. No.');
  });
});

describe('applyMark: bold and italic', () => {
  const ok = (text: string, a: number, b: number, mark: Mark, max = LETTER_BODY_MAX) => {
    const r = applyMark(text, a, b, mark, max);
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  it('wraps the selection and keeps it selected', () => {
    expect(ok('say hello now', 4, 9, 'bold')).toEqual({ ok: true, text: 'say **hello** now', selStart: 6, selEnd: 11 });
    expect(ok('say hello now', 4, 9, 'italic')).toEqual({ ok: true, text: 'say *hello* now', selStart: 5, selEnd: 10 });
  });
  it('takes the selection in either order', () => {
    expect(ok('say hello now', 9, 4, 'bold')).toEqual(ok('say hello now', 4, 9, 'bold'));
  });
  it('inserts an empty pair with the caret inside for an empty selection', () => {
    expect(ok('ab', 1, 1, 'bold')).toEqual({ ok: true, text: 'a****b', selStart: 3, selEnd: 3 });
    expect(ok('ab', 1, 1, 'italic')).toEqual({ ok: true, text: 'a**b', selStart: 2, selEnd: 2 });
    expect(ok('', 0, 0, 'bold')).toEqual({ ok: true, text: '****', selStart: 2, selEnd: 2 });
  });
  it('does the same for a selection of spaces', () => {
    expect(ok('a   b', 1, 4, 'bold').text).toBe('a****   b');
  });
  it('leaves the spaces at the ends of the selection outside the marks', () => {
    expect(ok('say hello now', 3, 10, 'bold')).toEqual({ ok: true, text: 'say **hello** now', selStart: 6, selEnd: 11 });
  });
  it('wraps each line of a selection across lines, and not the blank ones', () => {
    const r = ok('one\n\ntwo', 0, 8, 'bold');
    expect(r.text).toBe('**one**\n\n**two**');
    expect(r.selStart).toBe(2);
    expect(r.selEnd).toBe(14);
    expect(parseLetter(r.text).filter((b) => b.kind === 'paragraph').map((b) => plainOf([b]))).toEqual(['one', 'two']);
  });
  it('takes the marks off when the selection is the wrapped text, or sits inside the marks', () => {
    expect(ok('say **hello** now', 4, 13, 'bold')).toEqual({ ok: true, text: 'say hello now', selStart: 4, selEnd: 9 });
    expect(ok('say **hello** now', 6, 11, 'bold')).toEqual({ ok: true, text: 'say hello now', selStart: 4, selEnd: 9 });
    expect(ok('say *hello* now', 5, 10, 'italic')).toEqual({ ok: true, text: 'say hello now', selStart: 4, selEnd: 9 });
    expect(ok('say *hello* now', 4, 11, 'italic')).toEqual({ ok: true, text: 'say hello now', selStart: 4, selEnd: 9 });
  });
  it('pressing twice returns the text, because the selection stays on the wrapped words', () => {
    const once = ok('say hello now', 4, 9, 'bold');
    expect(ok(once.text, once.selStart, once.selEnd, 'bold').text).toBe('say hello now');
  });
  it('adds italic to bold text instead of breaking it', () => {
    const r = ok('say **hello** now', 6, 11, 'italic');
    expect(r.text).toBe('say ***hello*** now');
    expect(parseLetter(r.text)).toEqual([paragraph([T('say '), { t: 'bold', children: [{ t: 'italic', children: [T('hello')] }] }, T(' now')])]);
  });
  it('clamps a selection outside the text', () => {
    expect(ok('ab', -5, 99, 'bold').text).toBe('**ab**');
  });
  it('refuses, with a sentence, when the result would pass the limit, and allows a result exactly at it', () => {
    const r = applyMark('abcd', 0, 4, 'bold', 7);
    expect(r).toEqual({ ok: false, error: 'That would make the letter text longer than 7 characters.' });
    expect(applyMark('abcd', 0, 4, 'bold', 8).ok).toBe(true);
    expect(applyMark('ab', 1, 1, 'bold', 5).ok).toBe(false);
  });
  it('never refuses a result that is no longer than the text', () => {
    expect(applyMark('**ab**', 2, 4, 'bold', 3).ok).toBe(true);
  });
});

describe('applyMark: headings and lists', () => {
  const ok = (text: string, a: number, b: number, mark: Mark, max = LETTER_BODY_MAX) => {
    const r = applyMark(text, a, b, mark, max);
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  it('puts "## " on the line with the caret, keeping the caret on the same character', () => {
    expect(ok('Terms\nbody', 2, 2, 'heading')).toEqual({ ok: true, text: '## Terms\nbody', selStart: 5, selEnd: 5 });
  });
  it('toggles the heading off again', () => {
    expect(ok('## Terms\nbody', 5, 5, 'heading')).toEqual({ ok: true, text: 'Terms\nbody', selStart: 2, selEnd: 2 });
    expect(ok('# Terms', 0, 7, 'heading').text).toBe('Terms');
  });
  it('replaces a heading marker of another level and a list marker with "## "', () => {
    expect(ok('- Terms', 3, 3, 'heading').text).toBe('## Terms');
    expect(ok('1. Terms', 3, 3, 'heading').text).toBe('## Terms');
    expect(ok('# Terms\nplain', 0, 13, 'heading').text).toBe('## Terms\n## plain');
  });
  it('puts the marker on a caret on an empty line, and nothing on a selection of only empty lines', () => {
    expect(ok('a\n\nb', 2, 2, 'bullet')).toEqual({ ok: true, text: 'a\n- \nb', selStart: 4, selEnd: 4 });
    expect(ok('a\n\n\nb', 2, 4, 'bullet').text).toBe('a\n\n\nb');
  });
  it('prefixes each non-empty line of a selection across lines, bullet and numbered', () => {
    expect(ok('one\ntwo\n\nthree', 0, 14, 'bullet').text).toBe('- one\n- two\n\n- three');
    expect(ok('one\ntwo\n\nthree', 0, 14, 'number').text).toBe('1. one\n2. two\n\n3. three');
  });
  it('maps the selection across several lines', () => {
    const r = ok('one\ntwo\nthree', 1, 9, 'bullet');
    expect(r.text).toBe('- one\n- two\n- three');
    expect(r.text.slice(r.selStart, r.selEnd)).toBe('ne\n- two\n- t');
  });
  it('does not take in the next line when the selection ends at its start', () => {
    expect(ok('one\ntwo', 0, 4, 'bullet').text).toBe('- one\ntwo');
    expect(ok('one\ntwo', 3, 7, 'bullet').text).toBe('one\n- two');
  });
  it('toggles a list off only when every line already has it, and adds it to the rest otherwise', () => {
    expect(ok('- a\n- b', 0, 7, 'bullet').text).toBe('a\nb');
    expect(ok('- a\nb', 0, 5, 'bullet').text).toBe('- a\n- b');
    expect(ok('1. a\n2. b', 0, 9, 'number').text).toBe('a\nb');
    expect(ok('1. a\nb', 0, 6, 'number').text).toBe('1. a\n2. b');
    expect(ok('- a\n- b', 0, 7, 'number').text).toBe('1. a\n2. b');
  });
  it('keeps the selection start after a removed marker it was inside', () => {
    expect(ok('- abc', 1, 1, 'bullet')).toEqual({ ok: true, text: 'abc', selStart: 0, selEnd: 0 });
  });
  it('gives text the parser reads as the block that was asked for', () => {
    expect(parseLetter(ok('Terms', 0, 0, 'heading').text)[0]).toMatchObject({ kind: 'heading', level: 2 });
    expect(parseLetter(ok('a\nb', 0, 3, 'bullet').text)[0]).toMatchObject({ kind: 'bullets' });
    expect(parseLetter(ok('a\nb', 0, 3, 'number').text)[0]).toMatchObject({ kind: 'numbers' });
  });
  it('refuses at the limit with a sentence, and never refuses a toggle off', () => {
    expect(applyMark('abc', 0, 3, 'bullet', 4)).toEqual({ ok: false, error: 'That would make the letter text longer than 4 characters.' });
    expect(applyMark('abc', 0, 3, 'bullet', 5).ok).toBe(true);
    expect(applyMark('- abc', 0, 5, 'bullet', 3).ok).toBe(true);
  });
  it('works on an empty text', () => {
    expect(ok('', 0, 0, 'heading')).toEqual({ ok: true, text: '## ', selStart: 3, selEnd: 3 });
  });
});

describe('applyMark keeps block markers outside the marks', () => {
  const ok = (text: string, a: number, b: number, mark: Mark) => {
    const r = applyMark(text, a, b, mark, LETTER_BODY_MAX);
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  it('puts the mark after a bullet, a number and a heading marker', () => {
    expect(ok('- one', 0, 5, 'bold').text).toBe('- **one**');
    expect(ok('1. first', 0, 8, 'bold').text).toBe('1. **first**');
    expect(ok('## Terms', 0, 8, 'bold').text).toBe('## **Terms**');
    expect(ok('- one', 0, 5, 'italic').text).toBe('- *one*');
  });
  it('does the same for each line of a selection of list items', () => {
    expect(ok('- one\n- two\n1. three', 0, 20, 'bold').text).toBe('- **one**\n- **two**\n1. **three**');
  });
  it('gives text the parser still reads as the list or heading', () => {
    expect(parseLetter(ok('- one\n- two', 0, 11, 'bold').text)[0]).toEqual({
      kind: 'bullets',
      items: [[{ t: 'bold', children: [T('one')] }], [{ t: 'bold', children: [T('two')] }]],
    });
    expect(parseLetter(ok('## Terms', 0, 8, 'bold').text)[0]).toMatchObject({ kind: 'heading', level: 2 });
  });
  it('does not move a selection that starts after the marker', () => {
    expect(ok('- one two', 2, 5, 'bold').text).toBe('- **one** two');
  });
  it('leaves a line that is only a marker alone', () => {
    expect(ok('- ', 0, 2, 'bold').text).toBe('- ****');
  });
});

describe('applyMark over text that already holds the mark', () => {
  it('toggles off a selection exactly wrapped in the mark', () => {
    expect(applyMark('**a b**', 0, 7, 'bold', LETTER_BODY_MAX)).toEqual({ ok: true, text: 'a b', selStart: 0, selEnd: 3 });
  });
  it('refuses, with a sentence, text with the mark inside it', () => {
    const bold = applyMark('**a** b', 0, 7, 'bold', LETTER_BODY_MAX);
    expect(bold.ok).toBe(false);
    if (!bold.ok) expect(bold.error).toMatch(/\*\*/);
    expect(applyMark('a*b', 0, 3, 'italic', LETTER_BODY_MAX).ok).toBe(false);
  });
  it('still allows italic over bold text', () => {
    expect(applyMark('**a**', 0, 5, 'italic', LETTER_BODY_MAX)).toMatchObject({ ok: true, text: '***a***' });
  });
});
