// tests/kasturi-agent-migrations.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8');

const focus = read('20261125150000_agent_focus.sql');
const notes = read('20261125150100_crm_agent_notes.sql');

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

  test('crm_notes records the proposal, one note per proposal', () => {
    expect(notes).toContain(
      'add column agent_proposal_id uuid references public.agent_proposals(id) on delete set null',
    );
    expect(notes).toMatch(
      /create unique index crm_notes_agent_proposal_id_key\s+on public\.crm_notes \(agent_proposal_id\) where agent_proposal_id is not null;/,
    );
  });

  test('crm_add_agent_note needs a fresh, unused approval by the caller for this exact note', () => {
    const body = fnBody(notes, 'create or replace function public.crm_add_agent_note(');
    for (const clause of [
      'from public.agent_proposals p',
      'p.org_id = v_org',
      "p.product = 'crm'",
      "p.action = 'createAgentNote'",
      "p.status = 'approved'",
      'p.decided_by = auth.uid()',
      "p.decided_at > now() - interval '10 minutes'",
      "p.input->>'body' = p_body",
      "p.input->>'dealId' is not distinct from p_deal_id::text",
      "p.input->>'contactId' is not distinct from p_contact_id::text",
      'not exists (select 1 from public.crm_notes n where n.agent_proposal_id = p.id)',
      'order by p.decided_at desc',
      'for update of p',
      'if v_proposal is null then',
    ]) {
      expect(body).toContain(clause);
    }
    // the writer check comes before the proposal lookup, the lookup before the insert
    expect(body.indexOf('private.is_org_writer(v_org)')).toBeLessThan(body.indexOf('from public.agent_proposals p'));
    expect(body.indexOf('from public.agent_proposals p')).toBeLessThan(body.indexOf('insert into public.crm_notes'));
    expect(body).toContain(
      "values (v_org, p_deal_id, p_contact_id, p_body, 'agent', auth.uid(), v_proposal)",
    );
  });

  test('proposal guard v4 keeps the v3 rules and freezes who decided and when', () => {
    const v3 = fnBody(
      read('20261025090000_agent_proposals_guard_v3.sql'),
      'create or replace function private.agent_proposals_guard()',
    );
    const v4 = fnBody(notes, 'create or replace function private.agent_proposals_guard()');
    expect(v4).toContain("returns trigger language plpgsql set search_path = '' as $$");
    // every v3 rule, verbatim
    for (const rule of [
      "if old.status = 'pending' then",
      "if new.status not in ('approved','rejected','expired','failed') then",
      "raise exception 'invalid decision' using errcode = 'AGP01';",
      "elsif old.status = 'approved' and new.status in ('approved','failed') then",
      "raise exception 'this proposal is already handled' using errcode = 'AGP01';",
      "if (to_jsonb(new) - 'status' - 'result' - 'decided_at' - 'decided_by')",
      "is distinct from (to_jsonb(old) - 'status' - 'result' - 'decided_at' - 'decided_by') then",
      "raise exception 'only the decision may change' using errcode = 'AGP01';",
    ]) {
      expect(v3).toContain(rule);
      expect(v4).toContain(rule);
    }
    expect(v4).toMatch(
      /if old\.status <> 'pending'\s+and \(new\.decided_at is distinct from old\.decided_at\s+or new\.decided_by is distinct from old\.decided_by\) then/,
    );
    // the trigger itself is unchanged; only the function is replaced
    expect(notes).not.toMatch(/create trigger agent_proposals_guard/);
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
    expect(body).toContain("(new.source = 'agent' or new.agent_proposal_id is not null)");
    expect(body).toContain("old.source = 'agent'");
    expect(body).toContain('new.source is distinct from old.source');
    expect(body).toContain('new.agent_proposal_id is distinct from old.agent_proposal_id');
    expect(body).toContain('not exists (select 1 from public.agent_proposals p where p.id = old.agent_proposal_id)');
    // created_by may only be cleared once the author's account is gone
    expect(body).toContain('not exists (select 1 from auth.users u where u.id = old.created_by)');
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
