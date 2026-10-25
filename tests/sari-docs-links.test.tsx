import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { withDocsLinks } from '@/components/chat/reply-text';

test('withDocsLinks links guide paths and nothing else', () => {
  const html = renderToStaticMarkup(<p>{withDocsLinks('Full guide: /docs/getting-started/openrouter-key or https://evil.com', true)}</p>);
  expect(html).toContain('href="/docs/getting-started/openrouter-key"');
  expect(html).not.toContain('href="https://evil.com"');
});

test('withDocsLinks draws no link while links are off (a reply still arriving)', () => {
  const html = renderToStaticMarkup(<p>{withDocsLinks('Full guide: /docs/getting-started/openrouter-key', false)}</p>);
  expect(html).not.toContain('<a');
});

test("Sari's answers draw guide paths as links, but not while the last answer is still arriving", () => {
  const source = readFileSync('src/components/command/sari-conversation.tsx', 'utf8');
  expect(source).toContain("withDocsLinks(part.text.trim(), !(busy && m === messages[messages.length - 1]), i)");
});
