-- Kasturi automations: "when this happens, do that". One trigger, one action.
--
-- Triggers are things that happen to the workspace's own records:
--   contact_created   a contact is added (by a person, the assistant, an
--                     import, or a public lead form)
--   form_submitted    a public lead form is submitted (one form, or any)
--   deal_stage        a deal arrives in a chosen stage
--   deal_won          a deal becomes won
--   deal_lost         a deal becomes lost
-- A submission that makes a new contact is both of the first two.
-- Actions change the contact the event is about, and nothing else:
--   add_follow_up     add a follow-up for the contact, due in N days
--   add_tag           add a tag to the contact
--   set_status        set the contact's status
--
-- The database runs an automation itself, in the same transaction as the event,
-- so it happens whoever caused the event. The rules that keep that safe:
--   * It never blocks the event. Each action runs in its own block; if it
--     fails, the failure is recorded as a run and the contact, deal or form
--     submission is saved all the same. The engine is wrapped again by each
--     trigger. And it never waits long for a lock: after one second it gives
--     up (as an error those blocks catch) rather than hold the event until the
--     caller's own time limit cancels it, which nothing here could catch.
--   * It cannot loop. No action is a trigger: adding a follow-up, a tag or a
--     status sets nothing else off.
--   * It cannot run away. An automation that has run 1,000 times in a day is
--     switched off, with the reason written on it, until someone switches it
--     back on; the count then starts again. (An import adds up to 500
--     contacts at a time.) A workspace can have 50 automations switched on.
--   * A stranger cannot use it to rewrite a record. submit_public_form
--     promises that someone typing an existing contact's email into a public
--     form changes nothing about that contact. So when a form is submitted by
--     an address that was already a contact, an automation may add a
--     follow-up (someone has got in touch again) but not a tag or a status.
--   * An archived contact is left alone.
--
-- Access: members read automations and their runs; writers add, edit, switch
-- and delete automations. Nobody signed in can write a run, the engine's
-- notes or `resumed_at`: only the engine does. `anon` has nothing. A stranger
-- submitting a lead form sets automations off only through the triggers
-- below, which decide for themselves what happens.
--
-- Additive. Safe before or after the app release that uses it: with no
-- automations there is nothing for the triggers to do.

create table public.crm_automations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  trigger_type text not null check (trigger_type in ('contact_created', 'form_submitted', 'deal_stage', 'deal_won', 'deal_lost')),
  -- For deal_stage: the stage a deal must arrive in. If the stage is deleted
  -- this empties, and the automation then matches nothing.
  trigger_stage_id uuid references public.crm_pipeline_stages(id) on delete set null,
  -- For form_submitted: the one form, unless trigger_any_form. If the form is
  -- deleted this empties, and (unless any form) it then matches nothing.
  trigger_form_id uuid references public.forms(id) on delete set null,
  trigger_any_form boolean not null default false,
  action_type text not null check (action_type in ('add_follow_up', 'add_tag', 'set_status')),
  -- add_follow_up: what to do, and how many days from the event it is due (null: no due date).
  action_title text check (action_title is null or char_length(btrim(action_title)) between 1 and 200),
  action_due_days int check (action_due_days is null or action_due_days between 0 and 365),
  -- add_tag: one tag, as the contact form would store it.
  action_tag text check (
    action_tag is null
    or (char_length(action_tag) between 1 and 30 and action_tag = btrim(action_tag)
        and action_tag !~ ',' and action_tag !~ '\s\s')
  ),
  -- set_status. Never 'archived': an automation does not archive anyone.
  action_status text check (action_status is null or action_status in ('lead', 'contacted', 'qualified', 'customer')),
  enabled boolean not null default true,
  -- Why the engine switched it off, when it did. Cleared when it is switched on again.
  paused_reason text,
  -- When it was last switched back on: the daily count starts again from here.
  resumed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Each action has what it needs.
  check (action_type <> 'add_follow_up' or action_title is not null),
  check (action_type <> 'add_tag' or action_tag is not null),
  check (action_type <> 'set_status' or action_status is not null)
);
alter table public.crm_automations enable row level security;
create index crm_automations_org_created_idx on public.crm_automations (org_id, created_at desc);
-- What the engine looks up on every event.
create index crm_automations_org_trigger_idx on public.crm_automations (org_id, trigger_type) where enabled;
create index crm_automations_stage_idx on public.crm_automations (trigger_stage_id);
create index crm_automations_form_idx on public.crm_automations (trigger_form_id);
create index crm_automations_created_by_idx on public.crm_automations (created_by);

-- A stage or a form named by an automation must be the workspace's own.
-- Neither table has an (id, org_id) key for a composite foreign key, so the
-- write policies check it; the engine matches on the workspace again.
create policy crm_automations_select on public.crm_automations
  for select to authenticated using (private.is_org_member(org_id));
create policy crm_automations_insert on public.crm_automations
  for insert to authenticated
  with check (
    private.is_org_writer(org_id)
    and (created_by is null or created_by = (select auth.uid()))
    and (trigger_stage_id is null or exists (
      select 1 from public.crm_pipeline_stages s
       where s.id = trigger_stage_id and s.org_id = crm_automations.org_id))
    and (trigger_form_id is null or exists (
      select 1 from public.forms f
       where f.id = trigger_form_id and f.org_id = crm_automations.org_id))
  );
create policy crm_automations_update on public.crm_automations
  for update to authenticated
  using (private.is_org_writer(org_id))
  with check (
    private.is_org_writer(org_id)
    and (trigger_stage_id is null or exists (
      select 1 from public.crm_pipeline_stages s
       where s.id = trigger_stage_id and s.org_id = crm_automations.org_id))
    and (trigger_form_id is null or exists (
      select 1 from public.forms f
       where f.id = trigger_form_id and f.org_id = crm_automations.org_id))
  );
create policy crm_automations_delete on public.crm_automations
  for delete to authenticated using (private.is_org_writer(org_id));
create policy mfa_required on public.crm_automations as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));

revoke all on public.crm_automations from anon, authenticated;
grant select, delete on public.crm_automations to authenticated;
-- Not the engine's notes, not resumed_at, and not org_id on an update.
grant insert (org_id, name, trigger_type, trigger_stage_id, trigger_form_id, trigger_any_form,
              action_type, action_title, action_due_days, action_tag, action_status, enabled, created_by)
  on public.crm_automations to authenticated;
grant update (name, trigger_type, trigger_stage_id, trigger_form_id, trigger_any_form,
              action_type, action_title, action_due_days, action_tag, action_status, enabled, updated_at)
  on public.crm_automations to authenticated;

-- Two rules about switching on:
--   * a workspace has at most 50 automations switched on, so the work done
--     inside one event stays small;
--   * switching one back on clears the reason it was switched off and starts
--     its daily count again.
create or replace function private.crm_automations_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.enabled and (tg_op = 'INSERT' or not old.enabled) then
    if (select count(*) from public.crm_automations x
         where x.org_id = new.org_id and x.enabled and x.id <> new.id) >= 50 then
      raise exception 'a workspace can have at most 50 automations switched on'
        using errcode = 'check_violation';
    end if;
    if tg_op = 'UPDATE' then
      new.paused_reason := null;
      new.resumed_at := now();
    end if;
  end if;
  return new;
end; $$;
revoke all on function private.crm_automations_guard() from public, anon, authenticated;
create trigger crm_automations_guard
  before insert or update on public.crm_automations
  for each row execute function private.crm_automations_guard();

create table public.crm_automation_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  automation_id uuid not null references public.crm_automations(id) on delete cascade,
  -- Kept when the contact or deal is later deleted: the run still happened.
  contact_id uuid,
  deal_id uuid,
  -- done: the action was carried out. skipped: there was nothing to do, or it
  -- was not allowed to. failed: it could not be done. `detail` says which.
  status text not null check (status in ('done', 'skipped', 'failed')),
  detail text check (detail is null or char_length(detail) <= 300),
  created_at timestamptz not null default now(),
  constraint crm_automation_runs_contact_fkey foreign key (contact_id, org_id)
    references public.crm_contacts(id, org_id) on delete set null (contact_id),
  constraint crm_automation_runs_deal_fkey foreign key (deal_id, org_id)
    references public.crm_deals(id, org_id) on delete set null (deal_id)
);
alter table public.crm_automation_runs enable row level security;
create index crm_automation_runs_org_created_idx on public.crm_automation_runs (org_id, created_at desc);
create index crm_automation_runs_automation_created_idx on public.crm_automation_runs (automation_id, created_at desc);
create index crm_automation_runs_contact_idx on public.crm_automation_runs (contact_id);
create index crm_automation_runs_deal_idx on public.crm_automation_runs (deal_id);

create policy crm_automation_runs_select on public.crm_automation_runs
  for select to authenticated using (private.is_org_member(org_id));
create policy mfa_required on public.crm_automation_runs as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.crm_automation_runs from anon, authenticated;
grant select on public.crm_automation_runs to authenticated;

-- Each automation with how often it has run and when it last did, counted
-- from its runs. (Not kept as a counter on the automation: updating that row
-- on every run would make every event in a workspace wait its turn for it.)
-- Read as the caller, so the tables' own policies decide what is seen.
create view public.crm_automation_totals with (security_invoker = true) as
select a.*,
       coalesce(t.runs_count, 0)::int as runs_count,
       t.last_run_at
  from public.crm_automations a
  left join lateral (
    select count(*) as runs_count, max(r.created_at) as last_run_at
      from public.crm_automation_runs r
     where r.automation_id = a.id
  ) t on true;
revoke all on public.crm_automation_totals from anon, authenticated;
grant select on public.crm_automation_totals to authenticated;

-- ---------------------------------------------------------------------------
-- The engine. Runs every enabled automation of the workspace that matches the
-- event, in the order they were made. Called only by the triggers below.
-- `lock_timeout`: a second is the longest it will wait for a row someone else
-- is holding; then it raises an error the blocks below catch.
-- ---------------------------------------------------------------------------
create or replace function private.crm_run_automations(
  p_org uuid,
  p_trigger text,
  p_contact uuid,
  p_deal uuid,
  p_stage uuid,
  p_form uuid
)
returns void
language plpgsql security definer
set search_path = ''
set lock_timeout = '1s'
as $$
declare
  a public.crm_automations%rowtype;
  v_today int;
  v_status text;
  v_detail text;
  v_tags text[];
  v_current text;
  v_created timestamptz;
  v_existing boolean;
begin
  if p_org is null or p_contact is null then
    return;
  end if;

  for a in
    select * from public.crm_automations x
     where x.org_id = p_org
       and x.enabled
       and x.trigger_type = p_trigger
       and (p_trigger <> 'deal_stage' or x.trigger_stage_id = p_stage)
       and (p_trigger <> 'form_submitted' or x.trigger_any_form or x.trigger_form_id = p_form)
     order by x.created_at, x.id
  loop
    -- The cap: 1,000 runs since the start of today in Malaysia, or since it
    -- was last switched back on if that is later, switch the automation off.
    select count(*) into v_today
      from public.crm_automation_runs r
     where r.automation_id = a.id
       and r.created_at >= greatest(
             date_trunc('day', now() at time zone 'Asia/Kuala_Lumpur') at time zone 'Asia/Kuala_Lumpur',
             coalesce(a.resumed_at, '-infinity'::timestamptz)
           );
    if v_today >= 1000 then
      update public.crm_automations
         set enabled = false,
             paused_reason = 'Switched off after 1,000 runs in one day. Switch it on again when you are ready.'
       where id = a.id;
      continue;
    end if;

    v_status := 'done';
    v_detail := null;
    -- Its own block: whatever goes wrong in here is undone and recorded, and
    -- nothing outside it is disturbed.
    begin
      -- The lock an update of these columns takes anyway; a stronger one would
      -- clash with the foreign-key checks other writers hold on the contact.
      select c.tags, c.status, c.created_at into v_tags, v_current, v_created
        from public.crm_contacts c
       where c.id = p_contact and c.org_id = p_org
         for no key update;

      -- A contact made in this very transaction was made by this event. Any
      -- other was there before a public form was submitted with its address.
      v_existing := p_trigger = 'form_submitted' and v_created is distinct from now();

      if v_current is null then
        v_status := 'skipped';
        v_detail := 'The contact no longer exists.';
      elsif v_current = 'archived' then
        v_status := 'skipped';
        v_detail := 'The contact is archived, so it was left alone.';
      elsif a.action_type = 'add_follow_up' then
        insert into public.crm_activities (org_id, contact_id, deal_id, type, title, due_at)
        values (
          p_org, p_contact, p_deal, 'task', btrim(a.action_title),
          -- A due date is stored as midnight UTC of the day, counted from today in Malaysia.
          case when a.action_due_days is null then null
               else (((now() at time zone 'Asia/Kuala_Lumpur')::date + a.action_due_days)::timestamp at time zone 'UTC')
          end
        );
      elsif v_existing then
        v_status := 'skipped';
        v_detail := 'This address was already a contact. A public form may not change an existing contact.';
      elsif a.action_type = 'add_tag' then
        if exists (select 1 from unnest(coalesce(v_tags, '{}')) t where lower(t) = lower(a.action_tag)) then
          v_status := 'skipped';
          v_detail := 'The contact already has this tag.';
        elsif cardinality(coalesce(v_tags, '{}')) >= 10 then
          v_status := 'failed';
          v_detail := 'The contact already has 10 tags, which is the most a contact can have.';
        else
          update public.crm_contacts
             set tags = coalesce(tags, '{}') || a.action_tag, updated_at = now()
           where id = p_contact and org_id = p_org;
        end if;
      elsif a.action_type = 'set_status' then
        if v_current = a.action_status then
          v_status := 'skipped';
          v_detail := 'The contact already has this status.';
        else
          update public.crm_contacts
             set status = a.action_status, updated_at = now()
           where id = p_contact and org_id = p_org;
        end if;
      end if;
    exception when others then
      -- The code only: an error's text can quote the row it was about.
      raise log 'crm automations: an action failed (%)', sqlstate;
      v_status := 'failed';
      v_detail := case when sqlstate = '55P03'
                       then 'The contact was being changed by something else at that moment.'
                       else 'The action could not be carried out.' end;
    end;

    insert into public.crm_automation_runs (org_id, automation_id, contact_id, deal_id, status, detail)
    values (p_org, a.id, p_contact, p_deal, v_status, v_detail);
  end loop;
end $$;
revoke all on function private.crm_run_automations(uuid, text, uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The triggers. Each only says what happened; the engine decides the rest.
-- Each wraps the engine once more: an event is never refused because of an
-- automation. What that wrapper catches is logged, by its code, so an engine
-- that has stopped working does not stay silent.
-- ---------------------------------------------------------------------------
create or replace function private.crm_automations_on_contact()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform private.crm_run_automations(new.org_id, 'contact_created', new.id, null, null, null);
  exception when others then
    raise log 'crm automations: the engine failed on a new contact (%)', sqlstate;
  end;
  return null;
end; $$;

create or replace function private.crm_automations_on_submission()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform private.crm_run_automations(new.org_id, 'form_submitted', new.contact_id, null, null, new.form_id);
  exception when others then
    raise log 'crm automations: the engine failed on a form submission (%)', sqlstate;
  end;
  return null;
end; $$;

create or replace function private.crm_automations_on_deal()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_arrived boolean;
  v_won boolean;
  v_lost boolean;
begin
  begin
    -- A new deal arrives in its stage; an existing one when its stage changes.
    if tg_op = 'INSERT' then
      v_arrived := true;
      v_won := new.status = 'won';
      v_lost := new.status = 'lost';
    else
      v_arrived := new.stage_id is distinct from old.stage_id;
      v_won := new.status = 'won' and old.status is distinct from 'won';
      v_lost := new.status = 'lost' and old.status is distinct from 'lost';
    end if;
    if v_arrived then
      perform private.crm_run_automations(new.org_id, 'deal_stage', new.contact_id, new.id, new.stage_id, null);
    end if;
    if v_won then
      perform private.crm_run_automations(new.org_id, 'deal_won', new.contact_id, new.id, null, null);
    end if;
    if v_lost then
      perform private.crm_run_automations(new.org_id, 'deal_lost', new.contact_id, new.id, null, null);
    end if;
  exception when others then
    raise log 'crm automations: the engine failed on a deal (%)', sqlstate;
  end;
  return null;
end; $$;

revoke all on function private.crm_automations_on_contact() from public, anon, authenticated;
revoke all on function private.crm_automations_on_submission() from public, anon, authenticated;
revoke all on function private.crm_automations_on_deal() from public, anon, authenticated;

create trigger crm_automations_on_contact
  after insert on public.crm_contacts
  for each row execute function private.crm_automations_on_contact();

create trigger crm_automations_on_submission
  after insert on public.form_submissions
  for each row when (new.contact_id is not null)
  execute function private.crm_automations_on_submission();

create trigger crm_automations_on_deal
  after insert or update of stage_id, status on public.crm_deals
  for each row execute function private.crm_automations_on_deal();
