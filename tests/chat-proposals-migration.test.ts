import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ALLOWED_ATTACHMENT_TYPES } from '@/lib/chat/attachments';
import { PROPOSAL_TTL_MS } from '@/lib/chat/proposal-store';

const DIR = join(process.cwd(), 'supabase/migrations');
const FILE = '20261101111500_chat_proposals.sql';
const sql = readFileSync(join(DIR, FILE), 'utf8');
// Comments say what the statements must not do; only the statements are checked.
const code = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

const fn = (name: string) => {
  const start = code.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return code.slice(start, code.indexOf('$$;', start));
};
const FUNCTIONS = ['record_chat_proposal', 'claim_chat_proposal', 'reject_chat_proposals'];

describe('chat proposals migration', () => {
  test('is one file, alone on its version', () => {
    const files = readdirSync(DIR);
    expect(files.filter((f) => f.includes('chat_proposals'))).toEqual([FILE]);
    expect(files.filter((f) => f.startsWith('20261101111500'))).toEqual([FILE]);
  });

  test('a signed-in user can read their own rows and write nothing', () => {
    expect(code).toContain('alter table public.chat_proposals enable row level security;');
    expect(code).toMatch(/create policy chat_proposals_select_own on public\.chat_proposals\s+for select to authenticated\s+using \(user_id = \(select auth\.uid\(\)\)\);/);
    expect(code).toContain('revoke all on public.chat_proposals from public, anon, authenticated;');
    expect(code).toContain('grant select on public.chat_proposals to authenticated;');
    // No way for a browser to add a proposal of its own, or to re-open or alter one.
    expect(code).not.toMatch(/grant[^;]*\b(insert|update|delete|all)\b[^;]*on public\.chat_proposals to (authenticated|anon|public)/i);
    expect(code).not.toMatch(/create policy [^;]* on public\.chat_proposals\s+for (insert|update|delete|all) to authenticated\s+using \((?!\(select private\.mfa_ok)/);
  });

  test('holds the second-factor rule like every other table', () => {
    expect(code).toMatch(
      /create policy mfa_required on public\.chat_proposals as restrictive\s+for all to authenticated\s+using \(\(select private\.mfa_ok\(\)\)\) with check \(\(select private\.mfa_ok\(\)\)\);/,
    );
  });

  test('grants the service role explicitly, since it has no default privileges here', () => {
    expect(code).toContain('grant select, insert, update, delete on public.chat_proposals to service_role;');
    for (const name of FUNCTIONS) {
      expect(code).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role;`));
    }
  });

  test('its functions are the server’s alone, with a pinned search path', () => {
    for (const name of FUNCTIONS) {
      const body = fn(name);
      expect(body, name).toContain("set search_path = ''");
      expect(body, name).toContain('security invoker');
      expect(code).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`));
      expect(code).not.toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to (authenticated|anon|public)`));
    }
  });

  test('taking a proposal is single use, and only for its owner, workspace and while it waits', () => {
    const claim = fn('claim_chat_proposal');
    expect(claim).toContain('c.user_id = p_user_id');
    expect(claim).toContain('c.org_id = p_org_id');
    expect(claim).toContain("c.status = 'pending'");
    expect(claim).toContain('c.expires_at > now()');
    // Locked, then settled in the same statement: a second request finds nothing waiting.
    expect(claim).toContain('for update');
    expect(claim).toMatch(/set status = 'approved', consumed_at = now\(\), input = null/);
    // By call id, the hash of what the call carried must match the stored one too.
    expect(claim).toContain('c.tool_call_id = p_tool_call_id and c.input_hash = p_input_hash');
  });

  test('a rejected proposal is settled too, and settled rows keep no arguments', () => {
    expect(fn('reject_chat_proposals')).toMatch(/set status = 'rejected', consumed_at = now\(\), input = null/);
    expect(fn('record_chat_proposal')).toMatch(/set input = null\s+where user_id = p_user_id and input is not null and expires_at <= now\(\)/);
  });

  test('a proposal waits as long as the app says it does', () => {
    expect(PROPOSAL_TTL_MS).toBe(60 * 60 * 1000);
    expect(code).toContain("expires_at timestamptz not null default (now() + interval '1 hour')");
  });

  test('chat attachments get the second-factor rule and a type list that matches what the app keeps', () => {
    expect(code).toMatch(
      /create policy chat_attachments_mfa_required on storage\.objects as restrictive\s+for all to authenticated\s+using \(bucket_id <> 'chat-attachments' or \(select private\.mfa_ok\(\)\)\)\s+with check \(bucket_id <> 'chat-attachments' or \(select private\.mfa_ok\(\)\)\);/,
    );
    const list = /allowed_mime_types = array\[([^\]]*)\]/.exec(code)?.[1] ?? '';
    const types = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(types.sort()).toEqual([...ALLOWED_ATTACHMENT_TYPES].sort());
    expect(code).toMatch(/update storage\.buckets[\s\S]*where id = 'chat-attachments';/);
  });

  test('adds and tightens only: nothing is dropped', () => {
    expect(code).not.toMatch(/\bdrop\s+(table|column|policy|function)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
  });
});

describe('every chat route answers approvals from the server’s record', () => {
  test.each(['chat', 'crm/chat', 'hire/chat', 'people/chat', 'reach/chat'])('/api/%s', (route) => {
    const source = readFileSync(join(process.cwd(), 'src/app/api', route, 'route.ts'), 'utf8');
    expect(source).toContain("from '@/lib/chat/approvals'");
    expect(source).toMatch(/chatApprovals\(chat, /);
  });
});
