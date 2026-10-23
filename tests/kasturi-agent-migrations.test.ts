// tests/kasturi-agent-migrations.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8');

const focus = read('20261125140000_agent_focus.sql');
const notes = read('20261125140100_crm_agent_notes.sql');

const fnBody = (sql: string, head: string) => {
  const start = sql.indexOf(head);
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$$;', start));
};

describe('agent focus migration', () => {
  test('agent_configs gains the four focus columns', () => {
    expect(focus).toContain('add column focus_text text check (length(focus_text) <= 500)');
    expect(focus).toContain('add column focus_plan jsonb');
    expect(focus).toContain("add column focus_cannot text[] not null default '{}'");
    expect(focus).toContain('add column focus_confirmed_at timestamptz');
  });

  test('the focus columns are updatable by authenticated (the owner/admin policy still decides)', () => {
    expect(focus).toContain(
      'grant update (focus_text, focus_plan, focus_cannot, focus_confirmed_at) on public.agent_configs to authenticated;',
    );
    // Inserts are granted table-wide (20261101140000), so new columns need no insert grant.
    expect(focus).not.toMatch(/revoke\s+insert/);
    expect(focus).not.toMatch(/(create|drop|alter)\s+policy/);
  });
});

describe('crm agent notes migration', () => {
  test('crm_notes gains a source column', () => {
    expect(notes).toContain(
      "add column source text not null default 'user' check (source in ('user','agent'))",
    );
  });

  test('crm_add_agent_note is a guarded definer function', () => {
    const body = fnBody(notes, 'create or replace function public.crm_add_agent_note(');
    expect(body).toMatch(/crm_add_agent_note\(\s*p_deal_id uuid,\s*p_contact_id uuid,\s*p_body text\s*\)/);
    expect(body).toContain('returns uuid');
    expect(body).toContain('security definer');
    expect(body).toContain("set search_path = ''");
    // exactly one of the two ids
    expect(body).toContain('(p_deal_id is null) = (p_contact_id is null)');
    // org resolved from the record, never from input
    expect(body).toContain('from public.crm_deals d where d.id = p_deal_id');
    expect(body).toContain('from public.crm_contacts c where c.id = p_contact_id');
    expect(body).not.toContain('p_org');
    expect(body).toContain('private.is_org_writer(v_org)');
    expect(body).toContain('auth.uid()');
    expect(body).toContain('length(p_body) between 1 and 1000');
    expect(body).toContain("set_config('app.agent_note', 'on', true)");
    expect(body).toContain("set_config('app.agent_note', 'off', true)");
    expect(body).toContain("'agent'");
    expect(body.indexOf("'on', true")).toBeLessThan(body.indexOf('insert into public.crm_notes'));
    expect(body.indexOf('insert into public.crm_notes')).toBeLessThan(body.indexOf("'off', true"));
    expect(body).toContain("errcode = '42501'");
  });

  test('only authenticated may execute crm_add_agent_note', () => {
    expect(notes).toContain(
      'revoke all on function public.crm_add_agent_note(uuid, uuid, text) from public, anon;',
    );
    expect(notes).toContain(
      'grant execute on function public.crm_add_agent_note(uuid, uuid, text) to authenticated;',
    );
  });

  test('the guard trigger blocks forged agent notes and edits of them', () => {
    const body = fnBody(notes, 'create or replace function private.crm_notes_agent_guard()');
    expect(body).toContain('returns trigger');
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("current_setting('app.agent_note', true) is distinct from 'on'");
    expect(body).toContain("old.source = 'agent'");
    expect(body).toContain('new.source is distinct from old.source');
    expect(body).toContain("errcode = '42501'");
    expect(notes).toContain(
      'revoke all on function private.crm_notes_agent_guard() from public, anon, authenticated;',
    );
    expect(notes).toMatch(
      /create trigger crm_notes_agent_guard\s+before insert or update on public\.crm_notes\s+for each row execute function private\.crm_notes_agent_guard\(\);/,
    );
    // deletes stay allowed
    expect(notes).not.toMatch(/before[^;]*delete on public\.crm_notes/);
  });
});
