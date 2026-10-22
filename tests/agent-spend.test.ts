// tests/agent-spend.test.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, test, vi } from 'vitest';
import { workspaceSpendCents } from '@/lib/agents/spend';

const fake = (result: { data: unknown; error: unknown }) => {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
};

describe('workspaceSpendCents', () => {
  test('without an agent key it sends no p_agent_key', async () => {
    const { client, rpc } = fake({ data: 42, error: null });
    await expect(workspaceSpendCents(client, 'o', 's')).resolves.toBe(42);
    expect(rpc).toHaveBeenCalledWith('agent_spend_cents', { p_org_id: 'o', p_since: 's' });
  });

  test('with an agent key it adds p_agent_key', async () => {
    const { client, rpc } = fake({ data: 7, error: null });
    await workspaceSpendCents(client, 'o', 's', 'crm-focus');
    expect(rpc).toHaveBeenCalledWith('agent_spend_cents', {
      p_org_id: 'o',
      p_since: 's',
      p_agent_key: 'crm-focus',
    });
  });

  test('an empty agent key is still passed through', async () => {
    const { client, rpc } = fake({ data: 0, error: null });
    await workspaceSpendCents(client, 'o', 's', '');
    expect(rpc).toHaveBeenCalledWith('agent_spend_cents', {
      p_org_id: 'o',
      p_since: 's',
      p_agent_key: '',
    });
  });

  test('non-number data throws', async () => {
    const { client } = fake({ data: null, error: null });
    await expect(workspaceSpendCents(client, 'o', 's')).rejects.toThrow('spend query failed');
  });
});
