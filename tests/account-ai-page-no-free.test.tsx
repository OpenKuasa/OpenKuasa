import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/** Account → AI key on a server with no free questions (no platform OpenRouter key). */

vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ orgName: 'Kedai Maju', role: 'owner', isDemo: false }),
  hasSupabaseEnv: () => true,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock('@/lib/ai/gate', () => ({
  getChatStatus: vi.fn(async () => ({ hasKey: false, keyHint: null, freeLimit: 0, freeRemaining: 0 })),
}));
vi.mock('@/lib/ai/key-crypto', () => ({ hasKeySecret: () => true }));
vi.mock('@/components/account/ai-key-form', () => ({ AiKeyForm: () => null, RemoveAiKeyForm: () => null }));

import AiKeyPage from '@/app/account/ai/page';

describe('the AI key page with no free questions', () => {
  it('says chat needs a key instead of "0 of 0 free questions"', async () => {
    const html = renderToStaticMarkup(await AiKeyPage());
    expect(html).toContain('This server has no free questions, so chat needs a key.');
    expect(html).toContain('Add a key to start chatting.');
    expect(html).not.toContain('0 of 0');
    expect(html).not.toContain('0 free questions a week');
  });
});
