-- Hands back pushes a run claimed but never tried.
-- push_pending claims a batch for 10 minutes. When a run hits its time limit, the items it
-- did not get to used to sit out that whole lease, so they went two runs later instead of
-- on the next one. The sender now passes their ids here: the claim is cleared and no
-- attempt is counted, so the next 5-minute run picks them up. Service role only.
create or replace function public.push_release(p_outbox bigint[])
returns void language plpgsql security definer set search_path = public as $$
begin
  update private.push_outbox set claimed_at = null
  where id = any(coalesce(p_outbox, '{}'::bigint[])) and claimed_at is not null;
end; $$;
revoke all on function public.push_release(bigint[]) from public, anon, authenticated;
grant execute on function public.push_release(bigint[]) to service_role;
