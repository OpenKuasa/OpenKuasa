import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logMcpChange } from '@/lib/mcp/activity';

const rpcOf = (impl: (...a: unknown[]) => unknown) => {
  const rpc = vi.fn(impl as never);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
};

const ORG = '11111111-1111-4111-8111-111111111111';

afterEach(() => vi.restoreAllMocks());

describe('logMcpChange', () => {
  test('calls log_mcp_change with the credential\'s workspace and exactly the three texts', async () => {
    const { client, rpc } = rpcOf(async () => ({ data: true, error: null }));
    expect(await logMcpChange(client, { org: ORG, operation: 'scheduleInterview', target: 'Aina Rahman', client: 'Claude' })).toBe(true);
    expect(rpc).toHaveBeenCalledWith('log_mcp_change', {
      p_org: ORG,
      p_operation: 'scheduleInterview',
      p_target: 'Aina Rahman',
      p_client: 'Claude',
    });
  });

  test('false when nothing was written (a viewer, or no current workspace)', async () => {
    expect(await logMcpChange(rpcOf(async () => ({ data: false, error: null })).client, { org: ORG, operation: 'op', target: 't', client: 'c' })).toBe(false);
    expect(await logMcpChange(rpcOf(async () => ({ data: null, error: null })).client, { org: ORG, operation: 'op', target: 't', client: 'c' })).toBe(false);
  });

  test('false when the database refuses, with one sanitized line', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = rpcOf(async () => ({ error: { code: '42501', message: 'secret@example.com token abc' } }));
    expect(await logMcpChange(client, { org: ORG, operation: 'op', target: 't', client: 'c' })).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).not.toContain('secret');
  });

  test('false, never a throw, when the call throws or rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await logMcpChange(rpcOf(() => { throw new Error('boom'); }).client, { org: ORG, operation: 'op', target: 't', client: 'c' })).toBe(false);
    expect(await logMcpChange(rpcOf(async () => { throw new Error('boom'); }).client, { org: ORG, operation: 'op', target: 't', client: 'c' })).toBe(false);
  });
});

describe('log_mcp_change migration', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261125180100_log_mcp_change.sql'), 'utf8');
  const flat = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ');

  test('is a definer function on an empty search path that refuses no sign-in', () => {
    expect(flat).toContain(
      'create or replace function public.log_mcp_change(p_org uuid, p_operation text, p_target text, p_client text) returns boolean',
    );
    expect(flat).toContain('security definer set search_path = \'\'');
    expect(flat).toContain('if uid is null then raise exception \'not authenticated\'; end if;');
    expect(flat).toContain('private.current_org(uid)');
  });

  test('writes in the credential\'s workspace only, and says whether it wrote', () => {
    const body = flat.slice(flat.indexOf('create or replace function public.log_mcp_change'), flat.indexOf('end; $$;'));
    // Nothing to write without a workspace: false, before the workspace is compared.
    expect(body).toMatch(/if org is null then return false; end if; if p_org is distinct from org then raise exception/);
    expect(body).toContain('values ( p_org,');
    expect(body).toMatch(/role <> 'viewer' \) then return false; end if;/);
    expect(body).toMatch(/\); return true; $/);
  });

  test('writes one admins-only mcp entry, each text cut to 120, target built here', () => {
    expect(flat).toContain("'mcp', 'admins'");
    for (const p of ['p_operation', 'p_target', 'p_client']) expect(flat).toContain(`left(coalesce(${p}, ''), 120)`);
    expect(flat).toContain("' · via MCP · '");
    expect(flat).toContain("category in ('auth','team','data','security','billing','mcp')");
  });

  test('execute is for signed-in users only', () => {
    expect(flat).toContain('revoke all on function public.log_mcp_change(uuid, text, text, text) from public, anon;');
    expect(flat).toContain('grant execute on function public.log_mcp_change(uuid, text, text, text) to authenticated;');
    // No three-text version is left behind.
    expect(flat).not.toMatch(/log_mcp_change\(text, text, text\)/);
    expect(flat.match(/grant execute on function public\.log_mcp_change/g)).toHaveLength(1);
  });
});
