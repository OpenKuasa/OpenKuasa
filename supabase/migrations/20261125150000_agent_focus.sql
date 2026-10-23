-- Agent focus: what a workspace asks its agent to watch, in its own words.
--
-- focus_text         the workspace's own words (at most 500 characters)
-- focus_plan         the plan the app read from those words, for the runner
-- focus_cannot       the parts of the focus the agent said it cannot do
-- focus_confirmed_at when an owner or admin confirmed the plan
--
-- Members read these with the rest of the row (agent_configs_select). Writes stay
-- owner/admin by agent_configs_write (20261030111500_agent_spend_controls.sql).
-- Inserts are already granted table-wide (20261101140000), so the new columns
-- need no insert grant; updates are column-granted and get these four.
-- The runner reads focus_plan as service_role, which already has SELECT
-- (20261015100000_agent_service_role_grants.sql); nothing here changes its grants.

alter table public.agent_configs
  add column focus_text text check (length(focus_text) <= 500),
  add column focus_plan jsonb,
  add column focus_cannot text[] not null default '{}',
  add column focus_confirmed_at timestamptz;

grant update (focus_text, focus_plan, focus_cannot, focus_confirmed_at) on public.agent_configs to authenticated;
