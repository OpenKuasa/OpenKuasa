import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatAddedDate, listPushDevices } from '@/lib/push/devices';

function client(result: { data: unknown; error: unknown }) {
  const calls: unknown[][] = [];
  const supabase = {
    from: vi.fn((table: string) => {
      calls.push(['from', table]);
      return {
        select: (cols: string) => {
          calls.push(['select', cols]);
          return {
            order: async (col: string, opts: unknown) => {
              calls.push(['order', col, opts]);
              return result;
            },
          };
        },
      };
    }),
  } as unknown as SupabaseClient;
  return { supabase, calls };
}

describe('listPushDevices', () => {
  it('reads your own subscriptions, newest first, with a date in your timezone', async () => {
    const { supabase, calls } = client({
      data: [
        { id: 'd2', endpoint: 'https://push.example/2', device_label: 'Safari on iPhone', created_at: '2026-10-24T18:30:00Z' },
        { id: 'd1', endpoint: 'https://push.example/1', device_label: null, created_at: '2026-10-03T02:00:00Z' },
      ],
      error: null,
    });
    const devices = await listPushDevices(supabase, 'Asia/Kuala_Lumpur');
    expect(calls[0]).toEqual(['from', 'push_subscriptions']);
    expect(calls[2]).toEqual(['order', 'created_at', { ascending: false }]);
    expect(devices).toEqual([
      // 18:30 UTC on the 24th is 02:30 on the 25th in Kuala Lumpur.
      { id: 'd2', endpoint: 'https://push.example/2', label: 'Safari on iPhone', added: '25 Oct 2026' },
      { id: 'd1', endpoint: 'https://push.example/1', label: null, added: '3 Oct 2026' },
    ]);
  });

  it('shows an empty list when the read fails', async () => {
    const { supabase } = client({ data: null, error: { message: 'boom' } });
    expect(await listPushDevices(supabase, 'Asia/Kuala_Lumpur')).toEqual([]);
  });
});

describe('formatAddedDate', () => {
  it('falls back to Kuala Lumpur time for an unknown timezone', () => {
    expect(formatAddedDate('2026-10-24T18:30:00Z', 'Not/AZone')).toBe('25 Oct 2026');
  });
});
