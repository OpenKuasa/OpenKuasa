import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatKeyNotice } from '@/components/chat/chat-key-notice';
import type { ChatStatusForViewer } from '@/app/account/ai/actions';

const GUIDE = 'href="/docs/getting-started/openrouter-key"';

const render = (over: Partial<ChatStatusForViewer>) =>
  renderToStaticMarkup(
    <ChatKeyNotice
      status={
        {
          isDemo: false,
          hasKey: false,
          freeRemaining: 0,
          freeLimit: 3,
          canManageKey: true,
          ...over,
        } as ChatStatusForViewer
      }
    />,
  );

describe('ChatKeyNotice', () => {
  it('locked owner sees the four steps, the key page link and the guide link', () => {
    const html = render({});
    expect(html).toContain('Keep chatting with your own OpenRouter key');
    expect(html).toContain('Create a free account at openrouter.ai.');
    expect(html).toContain('Add a few dollars of credit.');
    expect(html).toContain('Create a key.');
    expect(html).toContain('Paste it on the AI key page.');
    expect(html).toContain('href="/account/ai"');
    expect(html).toContain('Add your key');
    expect(html).toContain(GUIDE);
    expect(html).toContain('Step-by-step guide');
  });

  it('locked member is told to ask an owner and gets no key page link', () => {
    const html = render({ canManageKey: false });
    expect(html).toContain('Ask a workspace owner or admin');
    expect(html).not.toContain('href="/account/ai"');
    expect(html).toContain(GUIDE);
  });

  it('with free questions left it stays one line', () => {
    const html = render({ freeRemaining: 2 });
    expect(html).toContain('2 of 3 free questions left this week.');
    expect(html).not.toContain('Create a key.');
  });

  it('demo and keyed workspaces show nothing', () => {
    expect(render({ isDemo: true })).toBe('');
    expect(render({ hasKey: true })).toBe('');
  });
});
