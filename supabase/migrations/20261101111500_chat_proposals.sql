-- Changes the chat assistants have put to a user for approval. Additive only.
--
-- When an assistant proposes a change, the server keeps what it proposed here.
-- An approval then names the row, and the server applies the stored input:
-- once, for the person it was proposed to, in the workspace it was proposed
-- in, and only while it is still waiting. What the browser sends back is used
-- to find the row, never as the change itself.
--
-- Deploy order: this migration first, then the code that uses it. The table is
-- unused by older code. Newer code without the table prepares no changes (the
-- assistant says so) and keeps answering questions; it never falls back to
-- applying input the browser carried.
--
-- Rows are written and settled by the server only (service role). A signed-in
-- user may read their own rows and nothing else: no insert, update or delete
-- is granted, so a browser cannot mint a proposal or re-open a settled one.

create table public.chat_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  -- The saved chat it was proposed in, when the chat is one. Not a foreign key:
  -- a first question's thread row is written after its answer.
  thread_id uuid,
  -- The model call that proposed it, for an assistant that holds its change
  -- tools itself. Null for a change one of Tuah's specialists prepared, which
  -- is named by `id`.
  tool_call_id text check (tool_call_id is null or length(tool_call_id) between 1 and 200),
  product text not null check (product in ('reach', 'crm', 'hire', 'people')),
  action text not null check (length(action) between 1 and 80),
  -- The change's arguments. Cleared when the proposal is settled or has
  -- lapsed: an HR change can hold pay and identity details, and they are not
  -- kept here once they have served their purpose. `input_hash` stays.
  input jsonb,
  -- SHA-256 of the arguments in canonical JSON (sorted keys), hex.
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '1 hour'),
  consumed_at timestamptz,
  check ((status = 'pending') = (consumed_at is null))
);

create index chat_proposals_user_created_idx on public.chat_proposals (user_id, created_at desc);
create index chat_proposals_call_idx on public.chat_proposals (user_id, tool_call_id)
  where tool_call_id is not null;

alter table public.chat_proposals enable row level security;

create policy chat_proposals_select_own on public.chat_proposals
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy mfa_required on public.chat_proposals as restrictive
  for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));

revoke all on public.chat_proposals from public, anon, authenticated;
grant select on public.chat_proposals to authenticated;
-- The service role has no default privileges in this project: grant what the server uses.
grant select, insert, update, delete on public.chat_proposals to service_role;

-- Keeps one proposal. Before it does, this user's lapsed proposals lose their
-- arguments and their week-old rows are removed, so the table holds little
-- more than what is waiting.
create or replace function public.record_chat_proposal(
  p_id uuid,
  p_user_id uuid,
  p_org_id uuid,
  p_thread_id uuid,
  p_tool_call_id text,
  p_product text,
  p_action text,
  p_input jsonb,
  p_input_hash text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.chat_proposals
     set input = null
   where user_id = p_user_id and input is not null and expires_at <= now();
  delete from public.chat_proposals
   where user_id = p_user_id and created_at < now() - interval '7 days';

  insert into public.chat_proposals (id, user_id, org_id, thread_id, tool_call_id, product, action, input, input_hash)
  values (p_id, p_user_id, p_org_id, p_thread_id, p_tool_call_id, p_product, p_action, p_input, p_input_hash);
  return p_id;
end;
$$;

-- Takes a waiting proposal for applying: marks it approved and hands back the
-- stored arguments, in one statement, so two requests can never both get it.
-- A proposal is found by its id, or by the model call that proposed it
-- together with the hash of the arguments that call carried. Nothing comes
-- back for a row that is another user's, another workspace's, lapsed, or
-- already settled.
create or replace function public.claim_chat_proposal(
  p_user_id uuid,
  p_org_id uuid,
  p_id uuid default null,
  p_tool_call_id text default null,
  p_input_hash text default null
)
returns table (id uuid, product text, action text, input jsonb)
language sql
security invoker
set search_path = ''
as $$
  with target as (
    select c.id, c.product, c.action, c.input
      from public.chat_proposals c
     where c.user_id = p_user_id
       and c.org_id = p_org_id
       and c.status = 'pending'
       and c.expires_at > now()
       and c.input is not null
       and (
         (p_id is not null and c.id = p_id)
         or (p_id is null and p_tool_call_id is not null and p_input_hash is not null
             and c.tool_call_id = p_tool_call_id and c.input_hash = p_input_hash)
       )
     order by c.created_at desc
     limit 1
       for update
  ), settled as (
    update public.chat_proposals c
       set status = 'approved', consumed_at = now(), input = null
      from target t
     where c.id = t.id and c.status = 'pending'
    returning c.id
  )
  select t.id, t.product, t.action, t.input
    from target t
    join settled s on s.id = t.id;
$$;

-- Settles proposals the user said no to, so a rejected change can never be
-- approved afterwards. `p_calls` pairs a model call's id with the hash of its
-- arguments: [{"tool_call_id": "...", "input_hash": "..."}].
create or replace function public.reject_chat_proposals(
  p_user_id uuid,
  p_org_id uuid,
  p_ids uuid[],
  p_calls jsonb
)
returns integer
language sql
security invoker
set search_path = ''
as $$
  with settled as (
    update public.chat_proposals c
       set status = 'rejected', consumed_at = now(), input = null
     where c.user_id = p_user_id
       and c.org_id = p_org_id
       and c.status = 'pending'
       and (
         c.id = any (coalesce(p_ids, '{}'::uuid[]))
         or exists (
           select 1
             from jsonb_array_elements(coalesce(p_calls, '[]'::jsonb)) as call
            where c.tool_call_id = call->>'tool_call_id' and c.input_hash = call->>'input_hash'
         )
       )
    returning 1
  )
  select count(*)::integer from settled;
$$;

revoke all on function public.record_chat_proposal(uuid, uuid, uuid, uuid, text, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.claim_chat_proposal(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.reject_chat_proposals(uuid, uuid, uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.record_chat_proposal(uuid, uuid, uuid, uuid, text, text, text, jsonb, text) to service_role;
grant execute on function public.claim_chat_proposal(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.reject_chat_proposals(uuid, uuid, uuid[], jsonb) to service_role;

-- Chat attachments: the same second-factor rule as the other private buckets
-- (`avatars`, `hire-cvs`, `hr-receipts`), and the bucket itself now refuses
-- anything but the types the app keeps. The app decides a file's type from
-- its bytes and uploads it under one of exactly these.
create policy chat_attachments_mfa_required on storage.objects as restrictive
  for all to authenticated
  using (bucket_id <> 'chat-attachments' or (select private.mfa_ok()))
  with check (bucket_id <> 'chat-attachments' or (select private.mfa_ok()));

update storage.buckets
   set public = false,
       file_size_limit = 10485760,
       allowed_mime_types = array['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']
 where id = 'chat-attachments';
