import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({
  configured: true,
  service: { data: 'ok' as unknown, error: null as null | { code: string } },
  serviceThrows: false,
  calls: [] as { as: 'service' | 'visitor'; fn: string; args: unknown }[],
}));

vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => {
    if (!ctl.configured) throw new Error('Service role is not configured.');
    return {
      rpc: async (fn: string, args: unknown) => {
        ctl.calls.push({ as: 'service', fn, args });
        if (ctl.serviceThrows) throw new Error('network');
        return ctl.service;
      },
    };
  },
}));

const { serverWriteClient } = await import('@/lib/supabase/server-writer');

const visitor = () =>
  ({
    rpc: async (fn: string, args: unknown) => {
      ctl.calls.push({ as: 'visitor', fn, args });
      return { data: 'from-visitor', error: null };
    },
  }) as never;

const ARGS = { p_form_id: 'f' };
const call = () => serverWriteClient(visitor).rpc('submit_public_form', ARGS);

beforeEach(() => {
  ctl.configured = true;
  ctl.service = { data: 'ok', error: null };
  ctl.serviceThrows = false;
  ctl.calls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('serverWriteClient', () => {
  it('calls as the server, once', async () => {
    expect(await call()).toEqual({ data: 'ok', error: null });
    expect(ctl.calls).toEqual([{ as: 'service', fn: 'submit_public_form', args: ARGS }]);
  });

  it('calls as before when the database does not let the server call yet', async () => {
    ctl.service = { data: null, error: { code: '42501' } };
    expect(await call()).toEqual({ data: 'from-visitor', error: null });
    expect(ctl.calls.map((c) => c.as)).toEqual(['service', 'visitor']);
    expect(ctl.calls[1]).toMatchObject({ fn: 'submit_public_form', args: ARGS });
  });

  it('calls as before on a host with no service key', async () => {
    ctl.configured = false;
    expect(await call()).toEqual({ data: 'from-visitor', error: null });
    expect(ctl.calls.map((c) => c.as)).toEqual(['visitor']);
  });

  it.each(['57014', 'PGRST202', '08006', ''])(
    'does not send a post again after any other error (%s): it may have been kept',
    async (code) => {
      ctl.service = { data: null, error: { code } };
      expect(await call()).toEqual({ data: null, error: { code } });
      expect(ctl.calls.map((c) => c.as)).toEqual(['service']);
    },
  );

  it('does not send a post again when the call throws', async () => {
    ctl.serviceThrows = true;
    await expect(call()).rejects.toThrow('network');
    expect(ctl.calls.map((c) => c.as)).toEqual(['service']);
  });
});
