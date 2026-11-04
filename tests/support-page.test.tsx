import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({ messages: [], sendMessage: vi.fn(), status: 'ready', error: undefined }),
}));

import { SupportChat } from '@/components/support/support-chat';

describe('the support Live chat box', () => {
  it('asks a visitor who may not chat to sign in, and offers no question box', () => {
    const html = renderToStaticMarkup(<SupportChat canChat={false} email="openkuasa@proton.me" limit={10} />);
    expect(html).toContain('Sign in to chat');
    expect(html).toContain('/login?next=%2Fsupport');
    expect(html).not.toContain('support-question');
  });

  it('gives a signed-in person the question box and the weekly allowance', () => {
    const html = renderToStaticMarkup(<SupportChat canChat email="openkuasa@proton.me" limit={10} />);
    expect(html).toContain('id="support-question"');
    expect(html).toContain('Up to 10 questions a week');
  });
});
