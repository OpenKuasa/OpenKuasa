export type AgentCadence = 'off' | 'daily' | 'weekly';
export type AgentRunStatus = 'running' | 'done' | 'failed' | 'skipped';
export type ScheduleStatus = 'active' | 'paused' | 'completed';
export type AgentRunTrigger = 'schedule' | 'manual';
export type AssetKind = 'poster' | 'image' | 'video';
export type AssetStatus = 'pending' | 'done' | 'failed';

export type AgentConfig = {
  id: string;
  org_id: string;
  agent_key: string;
  enabled: boolean;
  cadence: AgentCadence;
  max_cost_cents: number;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
  daily_cap_cents: number;
  weekly_cap_cents: number;
};

export type AgentRun = {
  id: string;
  org_id: string;
  agent_key: string;
  status: AgentRunStatus;
  trigger: AgentRunTrigger;
  digest_md: string | null;
  cost_cents: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

export type AgentRunAsset = {
  id: string;
  run_id: string;
  org_id: string;
  kind: AssetKind;
  status: AssetStatus;
  provider_job_id: string | null;
  storage_path: string | null;
  created_at: string;
};

export const WEEKLY_STUDIO = 'weekly-studio';

export type AgentSchedule = {
  id: string;
  org_id: string;
  agent_key: string;
  created_by: string | null;
  nl_text: string | null;
  interval_seconds: number;
  next_run_at: string;
  last_run_at: string | null;
  end_at: string | null;
  max_runs: number | null;
  runs_used: number;
  max_total_cents: number | null;
  spent_cents: number;
  status: ScheduleStatus;
  paused_reason: string | null;
  created_at: string;
  updated_at: string;
};

export const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'failed'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** One queued, owner-approvable change an autonomous run proposed. */
export type AgentProposal = {
  id: string;
  org_id: string;
  run_id: string | null;
  agent_key: string;
  product: string;
  action: string;
  input: unknown;
  title: string;
  detail: string | null;
  rationale: string | null;
  status: ProposalStatus;
  result: unknown;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  expires_at: string;
};
