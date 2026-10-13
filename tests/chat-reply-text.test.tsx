import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReplyText, TypedText, replyBlocks } from '@/components/chat/reply-text';

/**
 * How an assistant's words are drawn in a product's chat card. The model is told to write plain text, and now and
 * then writes a heading, a bold phrase, a list or a rule anyway (or is asked to). Those few marks are drawn; every
 * other character is text, and a reply with no marks is drawn exactly as it was before.
 */
const html = (text: string) => renderToStaticMarkup(<ReplyText text={text} />);
/** The same while the reply is still being written. */
const arriving = (text: string) => renderToStaticMarkup(<ReplyText text={text} arriving />);
/** What the card drew for every reply before: one pre-wrapped block holding the text. */
const BEFORE = (text: string) =>
  renderToStaticMarkup(<div className="whitespace-pre-wrap leading-relaxed text-primary-foreground">{text}</div>);

describe('a reply with no marks is drawn as before', () => {
  const PLAIN = [
    'Ada 3 orang cuti hari ini.',
    'Here is this month so far.\n\nLeads: 42, up from 31.\nSpend: RM 1,204.50.\n\nWant the breakdown by campaign?',
    'First line\n  indented line\n\n\nafter two blank lines\n',
    'Costs 2*3*4 and a*b*c, a #tag, 1.5 million, -5 degrees, a - dash, and 5 * 3 * 2.',
    '  leading spaces and a trailing space ',
    'Unclosed **bold and unclosed *italic stay as typed',
    '####  four hashes\n#\n- \n1. ',
  ];
  it.each(PLAIN)('%j', (text) => {
    expect(html(text)).toBe(BEFORE(text));
  });

  it('pins the markup of a plain reply of several paragraphs', () => {
    expect(html('Hello Saudara.\n\nYou have 5 days of annual leave left.\nNothing is pending.')).toBe(
      '<div class="whitespace-pre-wrap leading-relaxed text-primary-foreground">Hello Saudara.\n\nYou have 5 days of annual leave left.\nNothing is pending.</div>',
    );
  });
});

describe('the few marks a reply may carry', () => {
  it('the letter a member asked for: a modest heading, one bold phrase, no stray characters', () => {
    const letter = [
      '# Thank You',
      '',
      'Dear team,',
      '',
      '**Thank you for everything you do.** It has been a long quarter.',
      '',
      '---',
      '',
      'Warm regards,',
      'Member Check',
    ].join('\n');
    const out = html(letter);
    expect(out).toContain('<h3 class="text-[0.9375rem] font-semibold">Thank You</h3>');
    expect(out).toContain('<strong class="font-semibold">Thank you for everything you do.</strong> It has been a long quarter.');
    expect(out).toContain('<hr');
    expect(out).toContain('Warm regards,\nMember Check');
    // None of the marks is left on screen.
    const shown = out.replace(/<[^>]+>/g, '');
    expect(shown).not.toMatch(/[*#]/);
    expect(shown).not.toContain('---');
    // Modest: no page-sized heading.
    expect(out).not.toMatch(/<h1|<h2|text-(lg|xl|2xl|3xl)/);
  });

  it('bullets, numbers that keep the number typed, italic and the smaller headings', () => {
    const out = html('## Plan\n- first\n- *second*\n\n3. three\n4. four\n### Note\nplain');
    expect(out).toContain('<h4 class="font-semibold">Plan</h4>');
    expect(out).toContain('<ul class="list-disc pl-5"><li>first</li><li><em>second</em></li></ul>');
    expect(out).toContain('<ol class="list-decimal pl-5"><li value="3">three</li><li value="4">four</li></ol>');
    expect(out).toContain('<h4 class="font-semibold">Note</h4>');
  });

  it('a line of three or more hyphens is a thin rule, and the blank lines around it are not doubled', () => {
    const out = html('**Above**\n\n---\n\nbelow\n-----\nlast');
    expect(out.match(/<hr/g)).toHaveLength(2);
    expect(out).not.toContain('---');
    // The blank line on each side of a rule is the rule's own space, not an extra empty line.
    expect(out).not.toContain('<br/>');
  });

  it('two hyphens, or hyphens with words, are text', () => {
    expect(html('**x**\n--\n--- not a rule')).toContain('--\n--- not a rule');
  });

  it('line breaks and blank lines between marked paragraphs are kept', () => {
    const out = html('**Summary**\nline two\n\nnext paragraph');
    expect(out).toContain('<p class="whitespace-pre-wrap"><strong class="font-semibold">Summary</strong>\nline two</p>');
    expect(out).toContain('<p aria-hidden="true"><br/></p>');
    expect(out).toContain('<p class="whitespace-pre-wrap">next paragraph</p>');
  });
});

describe('while a reply is still arriving', () => {
  it('an unclosed mark is text until it closes', () => {
    const whole = '**Thank you for everything.** Done.';
    for (let cut = 1; cut < whole.indexOf('.**') + 3; cut += 1) {
      const out = arriving(whole.slice(0, cut));
      // Not bold yet, and never italic for the moment between the two closing stars.
      expect(out).not.toMatch(/<strong|<em/);
      expect(out.replace(/<[^>]+>/g, '')).toBe(whole.slice(0, cut));
    }
    expect(arriving(`${whole.slice(0, whole.indexOf('.**') + 3)} `)).toContain('<strong class="font-semibold">Thank you for everything.</strong>');
    expect(arriving(whole)).toContain('<strong class="font-semibold">Thank you for everything.</strong> Done.');
    expect(html(whole)).toContain('<strong class="font-semibold">Thank you for everything.</strong> Done.');
  });

  it('a reply that ends on a closed mark is drawn bold once it is complete', () => {
    expect(arriving('All **done**')).not.toContain('<strong');
    expect(arriving('All **done**').replace(/<[^>]+>/g, '')).toBe('All **done**');
    expect(html('All **done**')).toContain('All <strong class="font-semibold">done</strong>');
  });

  it('stars at the end of an arriving heading, list item or new line stay where they are, as text', () => {
    expect(arriving('# Title **')).toContain('<h3 class="text-[0.9375rem] font-semibold">Title **</h3>');
    expect(arriving('- one\n- two *')).toContain('<li>two *</li>');
    expect(arriving('1. one **')).toContain('<li value="1">one **</li>');
    expect(arriving('**a** b\n**')).toContain('<p class="whitespace-pre-wrap">**</p>');
  });

  it('every cut of a marked reply draws, and never loses a character that is not a mark', () => {
    const whole = '# Title\n\n**Bold** and *soft*.\n\n- one\n- two\n\n---\n\n1. first\n2. second\n';
    const letters = (s: string) => s.replace(/<[^>]+>/g, '').replace(/[^A-Za-z]/g, '');
    for (let cut = 0; cut <= whole.length; cut += 1) {
      const piece = whole.slice(0, cut);
      expect(letters(html(piece))).toBe(letters(piece));
      expect(letters(arriving(piece))).toBe(letters(piece));
    }
  });

  it('a 10,000 character reply drawn again on each of 300 chunks stays cheap', () => {
    const paragraph = '**Leave** for *March*: 3 days taken, 5 left. See the list below.\n- annual\n- medical\n\n';
    const whole = paragraph.repeat(Math.ceil(10_000 / paragraph.length)).slice(0, 10_000);
    const started = performance.now();
    for (let chunk = 1; chunk <= 300; chunk += 1) replyBlocks(whole.slice(0, Math.ceil((whole.length * chunk) / 300)));
    const parseMs = performance.now() - started;
    const startedDraw = performance.now();
    for (let chunk = 1; chunk <= 300; chunk += 1) html(whole.slice(0, Math.ceil((whole.length * chunk) / 300)));
    const drawMs = performance.now() - startedDraw;
    // Measured on a laptop: a few tens of milliseconds for all 300 parses together. The bound is loose for a busy machine.
    expect(parseMs).toBeLessThan(1500);
    expect(drawMs).toBeLessThan(4000);
  });
});

describe('hostile text comes out as text', () => {
  const HOSTILE = [
    '<script>alert(1)</script>',
    '**<img src=x onerror=alert(1)>**',
    '# <a href="javascript:alert(1)">click</a>',
    '![alt](https://example.com/x.png)',
    '[click me](javascript:alert(1))',
    '- [link](https://example.com) and <b>bold</b>',
    '1. <iframe src="https://example.com"></iframe>',
    '&lt;script&gt; &amp; &#x3C;img&#x3E; &quot;',
    '*<svg onload=alert(1)>*',
    '<div style="position:fixed" class="x" onclick="y()">**z**</div>',
    '---\n<script>x</script>\n---',
  ];
  it.each(HOSTILE)('%j', (text) => {
    const out = html(text);
    // Only the elements the renderer writes itself, each with only the attributes it writes itself.
    const tags = [...out.matchAll(/<\/?([a-z0-9]+)((?:\s[^>]*)?)>/g)];
    for (const [, name, attributes] of tags) {
      expect(['div', 'p', 'h3', 'h4', 'strong', 'em', 'ul', 'ol', 'li', 'hr', 'br']).toContain(name);
      expect(attributes.replace(/\s(class|value|aria-hidden)="[^"]*"/g, '').replace('/', '').trim()).toBe('');
    }
    expect(out).not.toMatch(/<(script|img|a|iframe|svg|b)[\s>]/);
    // And the same while it is arriving.
    expect(arriving(text)).not.toMatch(/<(script|img|a|iframe|svg|b)[\s>]/);
  });

  it('what looks like a tag is shown as its characters', () => {
    expect(html('**<script>alert(1)</script>**')).toContain('<strong class="font-semibold">&lt;script&gt;alert(1)&lt;/script&gt;</strong>');
    // An entity typed out stays typed out: the ampersand is escaped, never read as an entity.
    expect(html('# &lt;b&gt;')).toContain('&amp;lt;b&amp;gt;');
  });

  it('100,000 stars, hashes or hyphens are drawn in bounded time', () => {
    const started = performance.now();
    for (const text of ['*'.repeat(100_000), `**a ${'*'.repeat(100_000)}`, '#'.repeat(100_000), '-'.repeat(100_000), '- '.repeat(50_000), `${'**a** '.repeat(20_000)}`, '---\n'.repeat(25_000)]) {
      expect(html(text).length).toBeGreaterThan(0);
    }
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe('the renderer and where it is used', () => {
  const renderer = readFileSync(new URL('../src/components/chat/reply-text.tsx', import.meta.url), 'utf8');
  const card = readFileSync(new URL('../src/components/chat/ask-hero.tsx', import.meta.url), 'utf8');

  it('holds none of the constructs that could turn text into markup', () => {
    const code = renderer.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    for (const forbidden of [
      'dangerouslySetInnerHTML', 'innerHTML', 'outerHTML', '__html', 'createElement', 'cloneElement', 'insertAdjacentHTML',
      'document.', 'eval(', 'new Function', 'href', 'src=', '<a ', '<a>', '<img', '<iframe', '<script', '<object', '<embed', 'style=',
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    // Every element is written out by name: no tag held in a variable, no props spread from data.
    expect(code).not.toMatch(/<[A-Z][A-Za-z]*\s[^>]*\{\.\.\./);
    expect(code).not.toMatch(/<\{|const Tag\b|as keyof JSX/);
    expect([...code.matchAll(/<([a-z][a-z0-9]*)[\s>]/g)].map((m) => m[1]).filter((tag, i, all) => all.indexOf(tag) === i).sort()).toEqual(
      ['br', 'div', 'em', 'h3', 'h4', 'hr', 'li', 'ol', 'p', 'strong', 'ul'],
    );
  });

  it('the assistant’s words go through it; the person’s own message is drawn as typed', () => {
    expect(card).toContain('<ReplyText key={i} text={part.text} arriving={');
    expect(card.match(/<ReplyText/g)).toHaveLength(1);
    // The one place a user's words are drawn, inside the `m.role === 'user'` branch.
    expect(card).toContain('<TypedText text={textOf(m)} />');
    expect(card.match(/<TypedText/g)).toHaveLength(1);
    const userBranch = card.slice(card.indexOf("if (m.role === 'user')"), card.indexOf('{persona.name}</div>', card.indexOf("if (m.role === 'user')")));
    expect(userBranch).toContain('<TypedText');
    expect(userBranch).not.toContain('<ReplyText');
  });

  it('the person’s own message holding marks is shown as typed, stars and all', () => {
    const text = '# not a heading\nmake **x** bold\n- item\n---';
    const typed = renderToStaticMarkup(<TypedText text={text} />);
    expect(typed).toBe(BEFORE(text));
    expect(typed).toContain('make **x** bold');
    expect(typed).not.toMatch(/<(strong|h3|h4|ul|hr)/);
  });
});
