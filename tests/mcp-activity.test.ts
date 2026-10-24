import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { logMcpChange } from '@/lib/mcp/activity';

const service = vi.hoisted(() => ({ rpc: vi.fn(), created: 0, throwOnCreate: false }));
vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => {
    if (service.throwOnCreate) throw new Error('Service role is not configured.');
    service.created += 1;
    return { rpc: service.rpc };
  },
}));

const ORG = '11111111-1111-4111-8111-111111111111';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const entry = { actor: ALICE, org: ORG, operation: 'op', target: 't', client: 'c' };

beforeEach(() => {
  service.rpc.mockReset();
  service.created = 0;
  service.throwOnCreate = false;
});
afterEach(() => vi.restoreAllMocks());

describe('logMcpChange', () => {
  test('calls log_mcp_change_as on the service client with the caller as actor, in the credential\'s workspace', async () => {
    service.rpc.mockResolvedValue({ data: true, error: null });
    expect(
      await logMcpChange({ actor: ALICE, org: ORG, operation: 'scheduleInterview', target: 'Aina Rahman', client: 'Claude' }),
    ).toBe(true);
    expect(service.created).toBe(1);
    expect(service.rpc).toHaveBeenCalledTimes(1);
    expect(service.rpc).toHaveBeenCalledWith('log_mcp_change_as', {
      p_actor: ALICE,
      p_org: ORG,
      p_operation: 'scheduleInterview',
      p_target: 'Aina Rahman',
      p_client: 'Claude',
    });
  });

  test('false when nothing was written (a viewer, or not a member)', async () => {
    service.rpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await logMcpChange(entry)).toBe(false);
    service.rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await logMcpChange(entry)).toBe(false);
  });

  test('false when the database refuses, with one sanitized line', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    service.rpc.mockResolvedValue({ error: { code: '42501', message: 'secret@example.com token abc' } });
    expect(await logMcpChange(entry)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    expect(line).toContain('42501');
    expect(line).not.toContain('secret');
    expect(line).not.toContain(ALICE);
  });

  test('false, never a throw, when the call throws or rejects, or the service role is not configured', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    service.rpc.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(await logMcpChange(entry)).toBe(false);
    service.rpc.mockRejectedValueOnce(new Error('boom'));
    expect(await logMcpChange(entry)).toBe(false);
    service.throwOnCreate = true;
    expect(await logMcpChange(entry)).toBe(false);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('boom');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('configured');
  });
});

describe('log_mcp_change_as migration', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261125180300_log_mcp_change_as.sql'), 'utf8');
  const flat = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ');
  const body = flat.slice(flat.indexOf('create or replace function public.log_mcp_change_as'), flat.indexOf('end; $$;'));

  test('is a definer function on an empty search path that refuses a missing actor or workspace', () => {
    expect(flat).toContain(
      'create or replace function public.log_mcp_change_as(p_actor uuid, p_org uuid, p_operation text, p_target text, p_client text) returns boolean',
    );
    expect(flat).toContain("security definer set search_path = ''");
    expect(body).toMatch(/if p_actor is null or p_org is null then raise exception/);
    // It cannot see the caller's session: no auth.uid(), no current workspace.
    expect(body).not.toContain('auth.uid()');
    expect(body).not.toContain('current_org');
  });

  test('writes only for a non-viewer member of the workspace, as that member, and says whether it wrote', () => {
    expect(body).toMatch(
      /if not exists \( select 1 from public\.org_members where org_id = p_org and user_id = p_actor and role <> 'viewer' \) then return false; end if;/,
    );
    expect(body).toContain('values ( p_org, p_actor, private.display_name(p_actor),');
    expect(body).toMatch(/\); return true; $/);
  });

  test('writes one admins-only mcp entry, each text cut to 120, target built here', () => {
    expect(body).toContain("'Changed data through an AI tool'");
    expect(body).toContain("'mcp', 'admins'");
    expect(body).toContain(
      "left(coalesce(p_operation, ''), 120) || ' · ' || left(coalesce(p_target, ''), 120) || ' · via MCP · ' || left(coalesce(p_client, ''), 120)",
    );
  });

  test('only the service role may run it, and clients can no longer run the old one', () => {
    expect(flat).toContain(
      'revoke all on function public.log_mcp_change_as(uuid, uuid, text, text, text) from public, anon, authenticated;',
    );
    expect(flat).toContain('grant execute on function public.log_mcp_change_as(uuid, uuid, text, text, text) to service_role;');
    expect(flat.match(/grant execute/g)).toHaveLength(1);
    expect(flat).toContain('revoke execute on function public.log_mcp_change(uuid, text, text, text) from authenticated;');
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
