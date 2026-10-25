import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/** Account → AI key: the "How it works" card says how much chat a workspace key allows each person. */

vi.mock('@/lib/auth/viewer', () => ({
  getViewer: async () => ({ orgName: 'Kedai Maju', role: 'owner', isDemo: true }),
  hasSupabaseEnv: () => true,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/ai/gate', () => ({ getChatStatus: vi.fn() }));
vi.mock('@/lib/ai/key-crypto', () => ({ hasKeySecret: () => true }));
vi.mock('@/components/account/ai-key-form', () => ({ AiKeyForm: () => null, RemoveAiKeyForm: () => null }));

import AiKeyPage from '@/app/account/ai/page';
import { WORKSPACE_KEY_TURNS_PER_DAY } from '@/lib/ai/rate-limit';

describe('the AI key page', () => {
  it('states the daily chat limit on a workspace key, not "no limit"', async () => {
    const html = renderToStaticMarkup(await AiKeyPage());
    expect(html).not.toContain('no limit from us');
    expect(html).toContain(
      `each person can send up to ${WORKSPACE_KEY_TURNS_PER_DAY} chat requests a day on the key`,
    );
    expect(html).toContain('The count resets at midnight UTC (8 am Malaysia time).');
  });
});
