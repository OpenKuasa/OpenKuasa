import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logMcpChange } from '@/lib/mcp/activity';

const rpcOf = (impl: (...a: unknown[]) => unknown) => {
  const rpc = vi.fn(impl as never);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
};

afterEach(() => vi.restoreAllMocks());

describe('logMcpChange', () => {
  test('calls log_mcp_change with exactly the three texts', async () => {
    const { client, rpc } = rpcOf(async () => ({ error: null }));
    expect(await logMcpChange(client, { operation: 'scheduleInterview', target: 'Aina Rahman', client: 'Claude' })).toBe(true);
    expect(rpc).toHaveBeenCalledWith('log_mcp_change', { p_operation: 'scheduleInterview', p_target: 'Aina Rahman', p_client: 'Claude' });
  });

  test('false when the database refuses, with one sanitized line', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = rpcOf(async () => ({ error: { code: '42501', message: 'secret@example.com token abc' } }));
    expect(await logMcpChange(client, { operation: 'op', target: 't', client: 'c' })).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).not.toContain('secret');
  });

  test('false, never a throw, when the call throws or rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await logMcpChange(rpcOf(() => { throw new Error('boom'); }).client, { operation: 'op', target: 't', client: 'c' })).toBe(false);
    expect(await logMcpChange(rpcOf(async () => { throw new Error('boom'); }).client, { operation: 'op', target: 't', client: 'c' })).toBe(false);
  });
});

describe('log_mcp_change migration', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261125180100_log_mcp_change.sql'), 'utf8');
  const flat = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ');

  test('is a definer function on an empty search path that refuses no sign-in', () => {
    expect(flat).toContain('create or replace function public.log_mcp_change(p_operation text, p_target text, p_client text) returns void');
    expect(flat).toContain('security definer set search_path = \'\'');
    expect(flat).toContain('if uid is null then raise exception \'not authenticated\'; end if;');
    expect(flat).toContain('private.current_org(uid)');
  });

  test('writes one admins-only mcp entry, each text cut to 120, target built here', () => {
    expect(flat).toContain("'mcp', 'admins'");
    for (const p of ['p_operation', 'p_target', 'p_client']) expect(flat).toContain(`left(coalesce(${p}, ''), 120)`);
    expect(flat).toContain("' · via MCP · '");
    expect(flat).toContain("category in ('auth','team','data','security','billing','mcp')");
  });

  test('execute is for signed-in users only', () => {
    expect(flat).toContain('revoke all on function public.log_mcp_change(text, text, text) from public, anon;');
    expect(flat).toContain('grant execute on function public.log_mcp_change(text, text, text) to authenticated;');
    expect(flat.match(/grant execute on function public\.log_mcp_change/g)).toHaveLength(1);
  });
});
