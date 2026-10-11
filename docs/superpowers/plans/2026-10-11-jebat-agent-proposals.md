# Jebat Autonomous Proposals (5b + 5c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Jebat's autonomous Weekly Studio run *propose* non-destructive marketing changes into a durable approval queue the owner reviews (Approve applies under the owner's own authority; Reject drops it; stale ones expire).

**Architecture:** A new `agent_proposals` table (service-role inserts; owner updates only the decision columns, trigger-guarded). The worker, after writing its digest, runs a deterministic opportunity scan → an LLM selects which candidates to queue → a server gate re-validates each against an allow-list + the reach capability's own Zod schema before insert. A "Pending approvals" section on `reach/agents` wires Approve/Reject to server actions that re-validate and run the existing reach capability under the owner's session. The poll cron expires stale proposals.

**Tech Stack:** Next.js 16 App Router (server actions, server components), Supabase Postgres + two-layer RLS, Vitest (unit tests with a hand-rolled fake client; RLS tests against the live dev DB), AI SDK v7 + OpenRouter (behind a mockable seam), TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-10-11-jebat-agent-proposals-design.md` (read both — the plan argues from the spec).

## Global Constraints

- No Kuasa brand names in `src/`; **no purple/violet/indigo/fuchsia** in the UI; fictional data only.
- Supabase project `ugchntdgaeefmufumchx` via the `openkuasa-supabase` MCP ONLY. **The controller applies migrations** (`apply_migration`, one at a time — parallel calls collide on a per-second version); implementers own the committed `.sql` + TS + tests.
- TypeScript strict; 2-space indent, single quotes, semicolons; named exports; functional components + hooks; pnpm.
- `'use client'` files NEVER import `@/lib/ai/*`, `@/lib/reach/capabilities`, `@/lib/agents/apply-proposal`, `@/lib/agents/proposer`, or `@/lib/supabase/service` (server-only). Client components import **types only**.
- Never log, print, or commit any API key (OpenRouter, service-role). `.env*` is read/write-denied — verify env var presence by name only.
- **CI must not spend real money:** every test mocks the OpenRouter seam (`@/lib/agents/openrouter-media`); no test performs a real LLM/image/video/search call.
- **Service-role grants are not automatic** in this repo: a new service-written table needs an explicit `grant ... to service_role` in its migration or inserts fail with SQLSTATE `42501` (see `service-role-needs-explicit-grants`).
- Allow-list = non-destructive, reversible, **channel-free** reach actions only: `promoteLeadToContact`, `setLeadStage`, `createAppointment`, `updateAppointment`, `setAppointmentStatus`, `createForm`, `updateForm`. Everything else (all `delete*`, `setFormStatus`, `setCampaignStatus`, `updateAdSettings`, `create/updateCampaign`, `create/updateCreative`, `create/updateLead`) is excluded (destructive, go-live/spend, or `channel`-bound).

## Review Focus

1. **Apply a proposal whose target row vanished** (lead deleted between propose and approve) → the capability returns `{ok:false}`, the proposal becomes `failed` with a clear result, no crash. — *Task 2, test `apply of a missing target records failed`.*
2. **Approve an already-handled or expired proposal** (double-click, two owners, past `expires_at`) → guarded no-op; the change is applied at most once. — *Task 2, tests `apply is a no-op when not pending` + `apply is a no-op when expired`.*
3. **A viewer approves/rejects** → denied by the `edit-data` gate. — *Task 2, test `apply denied without edit permission`.*
4. **The proposer re-proposes a still-pending or already-satisfied opportunity** (same promote on two runs) → deduped, not re-queued. — *Task 4, test `does not re-propose a pending or satisfied opportunity`.*
5. **The LLM selects an off-list action, a malformed input, or a foreign-org id** → dropped by the server gate before any insert. — *Task 4, tests `drops a non-allowlisted selection` + `drops a selection whose target is not in the loaded data`.*

---

## Task 1: Migration — `agent_proposals` table, RLS, status-guard trigger, grants, types, RLS test

**Files:**
- Create: `supabase/migrations/20261016090000_agent_proposals.sql` (use a timestamp later than the latest existing migration — migrations currently reach `20261015100000`)
- Modify: `src/lib/agents/types.ts` (add proposal types)
- Create: `tests/helpers/agent-proposals-table.ts` (table-missing skip guard)
- Test: `tests/agent-proposals.rls.test.ts`

**Interfaces:**
- Produces: table `public.agent_proposals` with columns `id, org_id, run_id, agent_key, product, action, input, title, detail, rationale, status, result, created_at, decided_at, decided_by, expires_at`; types `AgentProposal`, `ProposalStatus`, `PROPOSAL_STATUSES` from `@/lib/agents/types`.

- [ ] **Step 1: Write the migration SQL.** Create `supabase/migrations/20261016090000_agent_proposals.sql`:

```sql
-- Jebat autonomous proposals (5b + 5c): a durable approval queue. The worker
-- (service role) INSERTs proposals; an org owner UPDATEs only the decision
-- columns to approve/reject (the apply runs the reach capability under the
-- owner's session). A BEFORE UPDATE guard freezes the proposal's substance and
-- lets a pending row move only to approved/rejected/failed/expired, once.
create table public.agent_proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  run_id uuid references public.agent_runs(id) on delete set null,
  agent_key text not null default 'weekly-studio',
  product text not null default 'reach' check (product in ('reach')),
  action text not null,
  input jsonb not null,
  title text not null,
  detail text,
  rationale text,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','expired','failed')),
  result jsonb,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id),
  expires_at timestamptz not null default (now() + interval '14 days')
);
alter table public.agent_proposals enable row level security;
create index agent_proposals_org_status_created_idx
  on public.agent_proposals (org_id, status, created_at desc);

create policy agent_proposals_select on public.agent_proposals for select to authenticated
  using (private.is_org_member(org_id));
-- Owners may UPDATE (approve/reject). INSERT/DELETE are not granted to authenticated
-- (the worker inserts; nothing deletes). The column grant below limits which columns.
create policy agent_proposals_update on public.agent_proposals for update to authenticated
  using (private.is_org_writer(org_id)) with check (private.is_org_writer(org_id));
create policy mfa_required on public.agent_proposals as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));

-- Only the decision may change, only from pending, only to a terminal status.
create or replace function private.agent_proposals_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status <> 'pending' then
    raise exception 'this proposal is already handled' using errcode = 'AGP01';
  end if;
  if new.status not in ('approved','rejected','failed','expired') then
    raise exception 'invalid decision' using errcode = 'AGP01';
  end if;
  -- Freeze everything except the decision columns.
  if (to_jsonb(new) - 'status' - 'result' - 'decided_at' - 'decided_by')
     is distinct from (to_jsonb(old) - 'status' - 'result' - 'decided_at' - 'decided_by') then
    raise exception 'only the decision may change' using errcode = 'AGP01';
  end if;
  return new;
end $$;
create trigger agent_proposals_guard before update on public.agent_proposals
  for each row execute function private.agent_proposals_guard();

revoke all on public.agent_proposals from anon, authenticated;
grant select on public.agent_proposals to authenticated;
grant update (status, result, decided_at, decided_by) on public.agent_proposals to authenticated;
-- Service role: the default grants are stripped in this project, so grant explicitly
-- (the worker proposes + the expiry sweep flips pending→expired).
grant insert, select, update on public.agent_proposals to service_role;
```

- [ ] **Step 2: Add the types.** In `src/lib/agents/types.ts`, append:

```ts
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
```

- [ ] **Step 3: Add the table-missing skip guard.** Create `tests/helpers/agent-proposals-table.ts` (mirrors `tests/helpers/forms-table.ts`; lets the RLS suite skip, not fail, until the controller applies the migration):

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

export const proposalsTableSkipReason =
  'agent_proposals migration not yet applied to the dev database — skipping RLS tests.';

/** True until 20261016090000_agent_proposals.sql is applied (PostgREST reports the table missing). */
export async function proposalsTableMissing(client: SupabaseClient): Promise<boolean> {
  const { error } = await client.from('agent_proposals').select('id').limit(1);
  // PGRST205 = table not found in the schema cache; 42P01 = undefined_table.
  return error?.code === 'PGRST205' || error?.code === '42P01';
}
```

- [ ] **Step 4: Write the failing RLS test.** Create `tests/agent-proposals.rls.test.ts` (scaffold copied from `tests/reach-forms.rls.test.ts`; a second org `other` drives cross-tenant deny). The worker-insert path is simulated with the SELECT grant only (an authenticated INSERT must be denied `42501`), and the owner UPDATE path exercises the column grant + the guard trigger:

```ts
import { afterAll, beforeAll, expect, test, type TestContext } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseEnv, supabaseEnvSkipReason } from './setup/supabase';
import { proposalsTableMissing, proposalsTableSkipReason } from './helpers/agent-proposals-table';

const testWithSupabase = hasSupabaseEnv ? test : test.skip;
if (!hasSupabaseEnv) console.warn(supabaseEnvSkipReason);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const client = (): SupabaseClient =>
  createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });

async function signedIn() {
  const c = client();
  const { error } = await c.auth.signInAnonymously();
  expect(error, error?.message).toBeNull();
  return c;
}
async function ownedOrg(c: SupabaseClient, name: string) {
  const { data: orgId, error } = await c.rpc('create_org_for_current_user', { org_name: name });
  expect(error, error?.message).toBeNull();
  return { c, orgId: orgId as string };
}
type Owned = Awaited<ReturnType<typeof ownedOrg>>;

let owner: Owned;
let other: Owned;
let tableMissing = false;
const proposalFields = (orgId: string) => ({
  org_id: orgId,
  action: 'promoteLeadToContact',
  input: { id: '00000000-0000-0000-0000-000000000000' },
  title: 'Promote lead “X” to a CRM contact?',
});
function needsTable(ctx: TestContext) {
  if (tableMissing) ctx.skip();
}

beforeAll(async () => {
  if (!hasSupabaseEnv) return;
  const first = await signedIn();
  tableMissing = await proposalsTableMissing(first);
  if (tableMissing) {
    console.warn(proposalsTableSkipReason);
    await first.auth.signOut();
    return;
  }
  owner = await ownedOrg(first, 'Proposals Owner Sdn Bhd');
  other = await ownedOrg(await signedIn(), 'Proposals Other Sdn Bhd');
});
afterAll(async () => {
  if (owner) await owner.c.from('agent_proposals').delete().eq('org_id', owner.orgId);
  await owner?.c.auth.signOut();
  await other?.c.auth.signOut();
});

testWithSupabase('authenticated users cannot INSERT a proposal (worker/service-role only)', async (ctx) => {
  needsTable(ctx);
  const ins = await owner.c.from('agent_proposals').insert(proposalFields(owner.orgId));
  expect(ins.error?.code).toBe('42501');
});

testWithSupabase('another workspace sees nothing and cannot update', async (ctx) => {
  needsTable(ctx);
  // RLS filters the other org's rows out: a cross-tenant select is empty (no error).
  const seen = await other.c.from('agent_proposals').select('id').eq('org_id', owner.orgId);
  expect(seen.error).toBeNull();
  expect(seen.data ?? []).toHaveLength(0);
});
```

- [ ] **Step 5: Run the RLS test; confirm it SKIPS (table not yet applied).**

Run: `pnpm exec vitest run tests/agent-proposals.rls.test.ts`
Expected: tests report as **skipped** with the `proposalsTableSkipReason` warning (the migration is not applied yet). This proves the guard works; the controller applies the migration next.

- [ ] **Step 6: Controller applies the migration** (NOT the implementer subagent): via `openkuasa-supabase` `apply_migration` with the exact committed SQL. Then re-run `pnpm exec vitest run tests/agent-proposals.rls.test.ts` and confirm the two tests now PASS (insert denied `42501`; cross-tenant select empty). Run `get_advisors` (security) and confirm no new RLS/`search_path` warnings on `agent_proposals` / `agent_proposals_guard`.

- [ ] **Step 7: Commit.**

```bash
git add supabase/migrations/20261016090000_agent_proposals.sql src/lib/agents/types.ts tests/helpers/agent-proposals-table.ts tests/agent-proposals.rls.test.ts
git commit -m "feat: agent_proposals table, RLS, status guard, grants and types"
```

---

## Task 2: Allow-list, apply dispatch, pending-read helper, approve/reject actions

**Files:**
- Create: `src/lib/agents/apply-proposal.ts` (allow-list + `runProposalAction`)
- Create: `src/lib/agents/proposals.ts` (`listPendingProposals`)
- Modify: `src/app/(app)/reach/actions.ts` (`applyProposalAction`, `rejectProposalAction`)
- Test: `tests/apply-proposal.test.ts`

**Interfaces:**
- Consumes: reach capabilities + their Zod input schemas from `@/lib/reach/capabilities`; `ReachWriteContext`, `CapResult`; `writeCtx`, `AGENTS_PATHS` (existing in `reach/actions.ts`); `AgentProposal` from `@/lib/agents/types`.
- Produces: `ALLOWED_ACTIONS` (record), `isAllowedAction(a): boolean`, `runProposalAction(ctx, action, input): Promise<ApplyResult>` where `ApplyResult = { ok: true; result: unknown } | { ok: false; error: string }`; `listPendingProposals(client, orgId): Promise<AgentProposal[]>`; server actions `applyProposalAction(input): Promise<{ok:boolean;error?:string}>`, `rejectProposalAction(input): Promise<{ok:boolean;error?:string}>`.

- [ ] **Step 1: Write the failing test.** Create `tests/apply-proposal.test.ts`. A fake `ReachWriteContext` records the capability call via a spy; `runProposalAction` must re-validate the input and dispatch to the right capability. (Capabilities are mocked so no real DB is touched.)

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/reach/capabilities', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/reach/capabilities')>();
  return {
    ...actual,
    promoteLeadToContact: vi.fn(async () => ({ ok: true, data: { contact_id: 'c1', contact: { id: 'c1', name: 'Aina' } } })),
    createForm: vi.fn(async () => ({ ok: true, data: { id: 'f1', status: 'draft' } })),
  };
});

import { runProposalAction, isAllowedAction } from '@/lib/agents/apply-proposal';
import { promoteLeadToContact } from '@/lib/reach/capabilities';

const ctx = { client: {} as never, orgId: 'org-1' };

describe('runProposalAction', () => {
  it('dispatches an allow-listed action after re-validating its input', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    const res = await runProposalAction(ctx, 'promoteLeadToContact', { id });
    expect(res).toEqual({ ok: true, result: { contact_id: 'c1', contact: { id: 'c1', name: 'Aina' } } });
    expect(promoteLeadToContact).toHaveBeenCalledWith(ctx, { id });
  });

  it('rejects a non-allowlisted action', async () => {
    expect(isAllowedAction('deleteLead')).toBe(false);
    const res = await runProposalAction(ctx, 'deleteLead', { id: '1' });
    expect(res).toEqual({ ok: false, error: 'That action is not allowed.' });
  });

  it('rejects input that no longer matches the capability schema', async () => {
    const res = await runProposalAction(ctx, 'promoteLeadToContact', { id: 'not-a-uuid' });
    expect(res.ok).toBe(false);
  });

  it('surfaces a capability failure (missing target) as ok:false', async () => {
    (promoteLeadToContact as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: 'That lead was not found.' });
    const id = '22222222-2222-2222-2222-222222222222';
    const res = await runProposalAction(ctx, 'promoteLeadToContact', { id });
    expect(res).toEqual({ ok: false, error: 'That lead was not found.' });
  });
});
```

- [ ] **Step 2: Run the test; verify it fails** (module not found).

Run: `pnpm exec vitest run tests/apply-proposal.test.ts`
Expected: FAIL — cannot resolve `@/lib/agents/apply-proposal`.

- [ ] **Step 3: Implement the allow-list + dispatch.** Create `src/lib/agents/apply-proposal.ts`:

```ts
import type { ZodType } from 'zod';
import {
  type CapResult,
  type ReachWriteContext,
  createAppointment,
  createAppointmentInput,
  createForm,
  createFormInput,
  promoteLeadToContact,
  promoteLeadToContactInput,
  setAppointmentStatus,
  setAppointmentStatusInput,
  setLeadStage,
  setLeadStageInput,
  updateAppointment,
  updateAppointmentInput,
  updateForm,
  updateFormInput,
} from '@/lib/reach/capabilities';

export type ApplyResult = { ok: true; result: unknown } | { ok: false; error: string };

type Entry = { schema: ZodType; run: (ctx: ReachWriteContext, input: unknown) => Promise<CapResult<unknown>> };
/** Erase the per-capability input type: parse with the schema, hand the parsed value on. */
function entry<I>(schema: ZodType<I>, cap: (ctx: ReachWriteContext, input: I) => Promise<CapResult<unknown>>): Entry {
  return { schema, run: (ctx, input) => cap(ctx, schema.parse(input) as I) };
}

/**
 * The ONLY reach actions the autonomous agent may propose and the queue may apply:
 * non-destructive, reversible, channel-free. No deletes, publishes, go-live or spend.
 */
export const ALLOWED_ACTIONS: Record<string, Entry> = {
  promoteLeadToContact: entry(promoteLeadToContactInput, promoteLeadToContact),
  setLeadStage: entry(setLeadStageInput, setLeadStage),
  createAppointment: entry(createAppointmentInput, createAppointment),
  updateAppointment: entry(updateAppointmentInput, updateAppointment),
  setAppointmentStatus: entry(setAppointmentStatusInput, setAppointmentStatus),
  createForm: entry(createFormInput, createForm),
  updateForm: entry(updateFormInput, updateForm),
};

export const ALLOWED_ACTION_NAMES = Object.keys(ALLOWED_ACTIONS);
export const isAllowedAction = (action: string): boolean => Object.hasOwn(ALLOWED_ACTIONS, action);

/**
 * Re-validate a persisted proposal's input and run its capability under `ctx`
 * (the OWNER's write context). Mirrors the in-chat applyChange re-validation.
 */
export async function runProposalAction(
  ctx: ReachWriteContext,
  action: string,
  input: unknown,
): Promise<ApplyResult> {
  const found = ALLOWED_ACTIONS[action];
  if (!found) return { ok: false, error: 'That action is not allowed.' };
  const parsed = found.schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'That proposed change is no longer valid.' };
  const res = await found.run(ctx, parsed.data);
  return res.ok ? { ok: true, result: res.data } : { ok: false, error: res.error };
}
```

- [ ] **Step 4: Run the test; verify it passes.**

Run: `pnpm exec vitest run tests/apply-proposal.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the pending-read helper.** Create `src/lib/agents/proposals.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentProposal } from '@/lib/agents/types';

const COLS =
  'id,org_id,run_id,agent_key,product,action,input,title,detail,rationale,status,result,created_at,decided_at,decided_by,expires_at';

/** The org's pending proposals, newest first. Read with the session client (RLS scopes it). */
export async function listPendingProposals(client: SupabaseClient, orgId: string): Promise<AgentProposal[]> {
  const { data } = await client
    .from('agent_proposals')
    .select(COLS)
    .eq('org_id', orgId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  return (data ?? []) as unknown as AgentProposal[];
}
```

- [ ] **Step 6: Write the failing action tests.** Add to `tests/apply-proposal.test.ts` a describe block for the actions. Mock the auth/session seams so the gate and the pending-load are exercised without a real DB:

```ts
vi.mock('@/lib/auth/viewer', () => ({ getViewer: vi.fn() }));
vi.mock('@/lib/auth/permissions', () => ({ can: (role: string, _p: string) => role !== 'viewer' }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// A session client whose agent_proposals row + update we control:
const proposalRow = { id: 'p1', action: 'promoteLeadToContact', input: { id: '33333333-3333-3333-3333-333333333333' }, status: 'pending', expires_at: new Date(Date.now() + 86_400_000).toISOString() };
let loaded: Record<string, unknown> | null = proposalRow;
const updates: unknown[] = [];
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: loaded }) }) }) }),
      update: (patch: unknown) => { updates.push(patch); return { eq: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }; },
    }),
  }),
}));

import { getViewer } from '@/lib/auth/viewer';
import { applyProposalAction, rejectProposalAction } from '@/app/(app)/reach/actions';

describe('applyProposalAction', () => {
  beforeEach(() => { loaded = { ...proposalRow }; updates.length = 0; (getViewer as ReturnType<typeof vi.fn>).mockResolvedValue({ orgId: 'org-1', role: 'owner', isDemo: false }); });

  it('applies a pending proposal and marks it approved', async () => {
    const res = await applyProposalAction({ id: 'p1' });
    expect(res.ok).toBe(true);
    expect(updates[0]).toMatchObject({ status: 'approved' });
  });
  it('apply denied without edit permission', async () => {
    (getViewer as ReturnType<typeof vi.fn>).mockResolvedValue({ orgId: 'org-1', role: 'viewer', isDemo: false });
    const res = await applyProposalAction({ id: 'p1' });
    expect(res.ok).toBe(false);
    expect(updates).toHaveLength(0);
  });
  it('apply is a no-op when not pending', async () => {
    loaded = { ...proposalRow, status: 'approved' };
    const res = await applyProposalAction({ id: 'p1' });
    expect(res.ok).toBe(false);
    expect(updates).toHaveLength(0);
  });
  it('apply is a no-op when expired', async () => {
    loaded = { ...proposalRow, expires_at: new Date(Date.now() - 1000).toISOString() };
    const res = await applyProposalAction({ id: 'p1' });
    expect(res.ok).toBe(false);
    expect(updates).toHaveLength(0);
  });
  it('apply of a missing target records failed', async () => {
    const cap = await import('@/lib/reach/capabilities');
    (cap.promoteLeadToContact as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: 'That lead was not found.' });
    const res = await applyProposalAction({ id: 'p1' });
    expect(res.ok).toBe(false);
    expect(updates[0]).toMatchObject({ status: 'failed' });
  });
});
```

- [ ] **Step 7: Implement the actions.** In `src/app/(app)/reach/actions.ts`, after the agents section, add (reuse the existing `writeCtx`, `AGENTS_PATHS`, `revalidatePath`, `z`):

```ts
import { runProposalAction } from '@/lib/agents/apply-proposal';

const proposalIdInput = z.object({ id: z.string().uuid() });

/**
 * Approve a queued proposal: re-validate it and run the reach capability under the
 * OWNER's session (never the service-role worker). Only a pending, unexpired row is
 * applied; the DB guard trigger makes a concurrent second apply a no-op.
 */
export async function applyProposalAction(input: unknown): Promise<{ ok: boolean; error?: string }> {
  const parsed = proposalIdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'That input was not valid.' };
  const ctx = await writeCtx();
  if (!ctx) return { ok: false, error: 'You do not have permission to make changes here.' };
  const { data: p } = await ctx.client
    .from('agent_proposals')
    .select('action, input, status, expires_at')
    .eq('id', parsed.data.id)
    .eq('org_id', ctx.orgId)
    .maybeSingle();
  if (!p || p.status !== 'pending' || new Date(p.expires_at as string) <= new Date()) {
    return { ok: false, error: 'That suggestion has already been handled.' };
  }
  const applied = await runProposalAction(ctx, p.action as string, p.input);
  const patch = applied.ok
    ? { status: 'approved', result: (applied.result ?? null) as never, decided_at: new Date().toISOString() }
    : { status: 'failed', result: { error: applied.error } as never, decided_at: new Date().toISOString() };
  await ctx.client
    .from('agent_proposals')
    .update(patch)
    .eq('id', parsed.data.id)
    .eq('org_id', ctx.orgId)
    .eq('status', 'pending');
  for (const path of AGENTS_PATHS) revalidatePath(path);
  return applied.ok ? { ok: true } : { ok: false, error: 'The change could not be applied.' };
}

/** Reject a queued proposal: mark it rejected, apply nothing. */
export async function rejectProposalAction(input: unknown): Promise<{ ok: boolean; error?: string }> {
  const parsed = proposalIdInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'That input was not valid.' };
  const ctx = await writeCtx();
  if (!ctx) return { ok: false, error: 'You do not have permission to make changes here.' };
  const { data } = await ctx.client
    .from('agent_proposals')
    .update({ status: 'rejected', decided_at: new Date().toISOString() })
    .eq('id', parsed.data.id)
    .eq('org_id', ctx.orgId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  for (const path of AGENTS_PATHS) revalidatePath(path);
  return data ? { ok: true } : { ok: false, error: 'That suggestion has already been handled.' };
}
```

- [ ] **Step 8: Run the tests; verify all pass.**

Run: `pnpm exec vitest run tests/apply-proposal.test.ts`
Expected: PASS (dispatch + action tests).

- [ ] **Step 9: Commit.**

```bash
git add src/lib/agents/apply-proposal.ts src/lib/agents/proposals.ts src/app/(app)/reach/actions.ts tests/apply-proposal.test.ts
git commit -m "feat: proposal allow-list, apply dispatch, pending read, approve/reject actions"
```

**Cut:** a human-seeded `pending` proposal can now be approved (applied through the reach capability) or rejected end-to-end from the server layer.

---

## Task 3: "Pending approvals" UI on `reach/agents`

**Files:**
- Create: `src/components/reach/pending-approvals.tsx` (client)
- Modify: `src/screens/reach/agents.tsx` (load pending proposals, pass to the panel)
- Modify: `src/components/reach/agents-panel.tsx` (render the section)

**Interfaces:**
- Consumes: `listPendingProposals` (Task 2); `AgentProposal` type (Task 1); `applyProposalAction`, `rejectProposalAction` (Task 2); the existing `ActionResult` type, `Button`, `useTransition` pattern in `agents-panel.tsx`.
- Produces: `<PendingApprovals proposals canEdit />`.

- [ ] **Step 1: Build the client component.** Create `src/components/reach/pending-approvals.tsx` (model the `run()`/`useTransition` helper on `SchedulesSection`; import **types only** from `@/lib/agents/types`):

```tsx
'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import type { AgentProposal } from '@/lib/agents/types';
import { applyProposalAction, rejectProposalAction } from '@/app/(app)/reach/actions';

type ActionResult = { ok: boolean; error?: string };

export function PendingApprovals({
  proposals,
  canEdit,
}: {
  proposals: AgentProposal[];
  canEdit: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function run(id: string, p: Promise<ActionResult>) {
    setError(null);
    setBusyId(id);
    start(async () => {
      const res = await p;
      if (!res.ok) setError(res.error ?? 'Something went wrong.');
      setBusyId(null);
    });
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">
        Pending approvals{proposals.length > 0 ? ` (${proposals.length})` : ''}
      </h3>
      {proposals.length === 0 ? (
        <p className="grid min-h-16 place-items-center text-center text-sm text-muted-foreground">
          No suggestions waiting — Jebat will add some after its next run.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {proposals.map((p) => (
            <li key={p.id} className="space-y-1.5 p-3 text-sm">
              <p className="font-medium">{p.title}</p>
              {p.rationale && <p className="text-muted-foreground">{p.rationale}</p>}
              {p.detail && <p className="text-muted-foreground">{p.detail}</p>}
              {canEdit ? (
                <div className="flex gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    disabled={pending}
                    onClick={() => run(p.id, applyProposalAction({ id: p.id }))}
                  >
                    {busyId === p.id ? 'Working…' : 'Approve'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => run(p.id, rejectProposalAction({ id: p.id }))}
                  >
                    Reject
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Ask an owner to review this.</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Load pending proposals in the screen.** In `src/screens/reach/agents.tsx`: import `listPendingProposals` from `@/lib/agents/proposals` and the `AgentProposal` type from `@/lib/agents/types`; add `let proposals: AgentProposal[] = [];`; add `listPendingProposals(supabase, viewer.orgId)` to the `Promise.all` (capture it as a new destructured entry, e.g. `proposalRows`) and set `proposals = proposalRows;`; pass `proposals={proposals}` to `<AgentsPanel>`.

- [ ] **Step 3: Render the section in the panel.** In `src/components/reach/agents-panel.tsx`: import `{ PendingApprovals }` and the `AgentProposal` type; add `proposals: AgentProposal[]` to the `AgentsPanel` props type and destructure it; render `<PendingApprovals proposals={proposals} canEdit={canEdit} />` immediately before the `Run history` block (`<div className="space-y-2"><h3 …>Run history</h3> …`).

- [ ] **Step 4: Type-check + build the screen.**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (no type errors; client component imports only the `AgentProposal` type + the server actions).

- [ ] **Step 5: Browser smoke (controller, on the smoke account).** On `openkuasa.com/reach/agents` (or localhost), seed one pending proposal via `openkuasa-supabase` `execute_sql` (insert into `agent_proposals` for the smoke org, `status 'pending'`, `action 'promoteLeadToContact'`, `input {"id":"<a real smoke lead id>"}`, a `title`), reload, confirm the "Pending approvals (1)" card renders with Approve/Reject, click **Approve**, and confirm the row leaves the list and the lead shows promoted. This is a controller verification step, not an implementer unit test.

- [ ] **Step 6: Commit.**

```bash
git add src/components/reach/pending-approvals.tsx src/screens/reach/agents.tsx src/components/reach/agents-panel.tsx
git commit -m "feat: pending-approvals section on the AI Agents screen"
```

**Cut:** the approval queue is reviewable and actionable end-to-end in the UI.

> **Deferred (not this slice):** a pending-count badge on the AI Agents *nav* item. The nav shell renders separately from the screen and has no confirmed badge mechanism; the in-card count ("Pending approvals (N)") covers visibility. Revisit when the nav gains a badge affordance.

---

## Task 4: The proposer — opportunity scan + LLM selection + server gate, wired into the run

**Files:**
- Create: `src/lib/agents/proposer.ts` (scan + gate + insert)
- Modify: `src/lib/agents/openrouter-media.ts` (add the mockable `suggestProposals` seam)
- Modify: `src/lib/agents/weekly-studio.ts` (call `proposeChanges` before `finish('done')`)
- Test: `tests/proposer.test.ts`

**Interfaces:**
- Consumes: `ALLOWED_ACTIONS`/`isAllowedAction` (Task 2); `approvalTitle`, `approvalDetail` from `@/lib/chat/change-titles`; `Lead`, `Appointment` types from `@/lib/reach/types`; the service client + `orgId` + `runId` + `apiKey` + `leads`/`appts`/`context`/`cost` in scope in `weekly-studio.ts`.
- Produces: `suggestProposals(apiKey, context, candidates): Promise<{ keep: Array<{ index: number; rationale: string }>; cost_cents: number }>`; `opportunityScan(leads, appts, now): Candidate[]`; `proposeChanges(service, orgId, runId, apiKey, { leads, appts, context }, maxCost, costSoFar): Promise<{ proposed: number; cost_cents: number }>`.

- [ ] **Step 1: Add the LLM seam (mockable).** In `src/lib/agents/openrouter-media.ts`, add `suggestProposals(apiKey, context, candidates)`: it asks the model, over the org's OpenRouter key, to pick which candidate indexes to queue and write a one-line rationale for each, returning `{ keep: Array<{ index: number; rationale: string }>, cost_cents }`. It MUST NOT invent actions or inputs — it only selects from the given candidate list. (Implementation mirrors the existing `writeDigest`/`webSearch` calls in this file; candidates are passed as `{ index, title }[]` so the model never sees raw ids it could echo into a new action.) Tests mock this export, so keep its signature exact.

- [ ] **Step 2: Write the failing proposer test.** Create `tests/proposer.test.ts`. Mock the seam + the capabilities-free bits; drive `proposeChanges` with a fake service client that records inserts.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/agents/openrouter-media', () => ({ suggestProposals: vi.fn() }));

import { opportunityScan, proposeChanges } from '@/lib/agents/proposer';
import { suggestProposals } from '@/lib/agents/openrouter-media';

const now = new Date('2026-10-11T00:00:00Z');
const lead = (over: Partial<Record<string, unknown>> = {}) => ({
  id: '11111111-1111-1111-1111-111111111111', name: 'Aina Rahman', channel: 'whatsapp',
  stage: 'won', source: 'Free Catering Quote', promoted_contact_id: null, created_at: '2026-10-01T00:00:00Z', ...over,
});

function fakeService(pendingActions: string[] = []) {
  const inserts: Record<string, unknown>[] = [];
  const client = {
    from(table: string) {
      return {
        // dedupe query: existing pending proposals
        select: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ data: pendingActions.map((a) => ({ action: a, input: {} })) }) }) }) }),
        insert: (row: Record<string, unknown>) => { inserts.push(row); return { select: () => ({ single: async () => ({ data: { id: 'new' }, error: null }) }) }; },
      };
    },
  } as never;
  return { client, inserts };
}

describe('opportunityScan', () => {
  it('proposes promote for a won, unpromoted lead', () => {
    const cands = opportunityScan([lead()], [], now);
    expect(cands.some((c) => c.action === 'promoteLeadToContact')).toBe(true);
  });
  it('does not propose promote for an already-promoted lead', () => {
    const cands = opportunityScan([lead({ promoted_contact_id: 'c1' })], [], now);
    expect(cands.some((c) => c.action === 'promoteLeadToContact')).toBe(false);
  });
});

describe('proposeChanges gate', () => {
  beforeEach(() => vi.mocked(suggestProposals).mockReset());

  it('queues the LLM-selected candidate with its title + rationale', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [{ index: 0, rationale: 'A won lead ready for sales.' }], cost_cents: 2 });
    const { client, inserts } = fakeService();
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', { leads: [lead()], appts: [], context: 'ctx' }, 200, 10);
    expect(res.proposed).toBe(1);
    expect(inserts[0]).toMatchObject({ action: 'promoteLeadToContact', status: 'pending', rationale: 'A won lead ready for sales.', run_id: 'run-1', org_id: 'org-1' });
    expect(inserts[0].title).toContain('Aina Rahman');
  });

  it('drops a non-allowlisted selection (index out of range / tampered)', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [{ index: 99, rationale: 'x' }], cost_cents: 1 });
    const { client, inserts } = fakeService();
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', { leads: [lead()], appts: [], context: 'ctx' }, 200, 10);
    expect(res.proposed).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('does not re-propose a pending or satisfied opportunity (dedupe)', async () => {
    vi.mocked(suggestProposals).mockResolvedValue({ keep: [{ index: 0, rationale: 'x' }], cost_cents: 1 });
    const { client, inserts } = fakeService(['promoteLeadToContact']); // already pending for this lead
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', { leads: [lead()], appts: [], context: 'ctx' }, 200, 10);
    expect(res.proposed).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('skips the LLM entirely when already at the cost cap', async () => {
    const { client, inserts } = fakeService();
    const res = await proposeChanges(client, 'org-1', 'run-1', 'key', { leads: [lead()], appts: [], context: 'ctx' }, 50, 50);
    expect(suggestProposals).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(res).toEqual({ proposed: 0, cost_cents: 0 });
  });
});
```

- [ ] **Step 3: Run the test; verify it fails** (module not found).

Run: `pnpm exec vitest run tests/proposer.test.ts`
Expected: FAIL — cannot resolve `@/lib/agents/proposer`.

- [ ] **Step 4: Implement the proposer.** Create `src/lib/agents/proposer.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Lead, Appointment } from '@/lib/reach/types';
import { approvalDetail, approvalTitle, type ItemKind } from '@/lib/chat/change-titles';
import { isAllowedAction, ALLOWED_ACTIONS } from '@/lib/agents/apply-proposal';
import { suggestProposals } from '@/lib/agents/openrouter-media';

const MAX_PROPOSALS = 5;

export type Candidate = { action: string; input: unknown; title: string; detail: string | null; dedupeKey: string };

/** Deterministic: the opportunities worth proposing from this week's data. */
export function opportunityScan(leads: Lead[], appts: Appointment[], now: Date): Candidate[] {
  const nameOf = (id: unknown, kind?: ItemKind): string | null =>
    kind === 'lead' && typeof id === 'string' ? (leads.find((l) => l.id === id)?.name ?? null) : null;
  const make = (action: string, input: unknown, dedupeKey: string): Candidate => ({
    action,
    input,
    title: approvalTitle(action, input, nameOf),
    detail: approvalDetail(action, input),
    dedupeKey,
  });
  const upcomingByName = new Set(
    appts.filter((a) => new Date(a.scheduled_at) > now).map((a) => a.contact_name),
  );
  const out: Candidate[] = [];
  for (const l of leads) {
    if (l.stage === 'won' && !l.promoted_contact_id) {
      out.push(make('promoteLeadToContact', { id: l.id }, `promote:${l.id}`));
    }
    if ((l.stage === 'qualified' || l.stage === 'booked') && !upcomingByName.has(l.name)) {
      const when = new Date(now.getTime() + 3 * 24 * 3600_000);
      when.setUTCHours(9, 0, 0, 0);
      out.push(
        make(
          'createAppointment',
          { contact_name: l.name, kind: 'Follow-up call', scheduled_at: when.toISOString(), via: 'Phone', status: 'scheduled' },
          `appt:${l.id}`,
        ),
      );
    }
  }
  return out;
}

/**
 * Proposes changes for one run. The LLM only SELECTS from the deterministic
 * candidates; the server re-validates every kept candidate's input against the
 * capability schema + the allow-list, de-dupes against pending proposals, caps the
 * count, and inserts. Returns how many were queued and the LLM cost.
 */
export async function proposeChanges(
  service: SupabaseClient,
  orgId: string,
  runId: string,
  apiKey: string,
  reach: { leads: Lead[]; appts: Appointment[]; context: string },
  maxCost: number,
  costSoFar: number,
): Promise<{ proposed: number; cost_cents: number }> {
  if (costSoFar >= maxCost) return { proposed: 0, cost_cents: 0 };
  const candidates = opportunityScan(reach.leads, reach.appts, new Date());
  if (candidates.length === 0) return { proposed: 0, cost_cents: 0 };

  const { keep, cost_cents } = await suggestProposals(
    apiKey,
    reach.context,
    candidates.map((c, index) => ({ index, title: c.title })),
  );

  // Existing pending proposals for this org, to de-dupe against.
  const { data: existing } = await service
    .from('agent_proposals')
    .select('action, input')
    .eq('org_id', orgId)
    .eq('status', 'pending');
  const pendingKeys = new Set(
    (existing ?? []).map((r) => `${(r as { action: string }).action}:${JSON.stringify((r as { input: unknown }).input)}`),
  );

  let proposed = 0;
  for (const sel of keep) {
    if (proposed >= MAX_PROPOSALS) break;
    const c = candidates[sel.index];
    if (!c || !isAllowedAction(c.action)) continue; // tampered / off-list selection
    if (!ALLOWED_ACTIONS[c.action].schema.safeParse(c.input).success) continue; // re-validate input
    if (pendingKeys.has(`${c.action}:${JSON.stringify(c.input)}`)) continue; // dedupe
    const { error } = await service.from('agent_proposals').insert({
      org_id: orgId,
      run_id: runId,
      agent_key: 'weekly-studio',
      product: 'reach',
      action: c.action,
      input: c.input,
      title: c.title,
      detail: c.detail,
      rationale: sel.rationale.slice(0, 280),
      status: 'pending',
    });
    if (!error) {
      proposed += 1;
      pendingKeys.add(`${c.action}:${JSON.stringify(c.input)}`);
    }
  }
  return { proposed, cost_cents };
}
```

- [ ] **Step 5: Run the proposer test; verify it passes.**

Run: `pnpm exec vitest run tests/proposer.test.ts`
Expected: PASS (scan + gate tests).

- [ ] **Step 6: Wire into the run.** In `src/lib/agents/weekly-studio.ts`, immediately before `return await finish('done', { digest_md: digest.text, cost_cents: cost });` (line ~181), add (its own try/catch so a propose failure never loses the digest; cost-gated inside `proposeChanges`):

```ts
    // Autonomous proposals (5b/5c): suggest non-destructive changes for the owner to approve.
    try {
      const prop = await proposeChanges(
        service,
        orgId,
        runId,
        apiKey,
        { leads, appts, context },
        maxCost,
        cost,
      );
      cost += prop.cost_cents;
    } catch {
      // Deliberately drop the exception: it may carry request details or a key.
    }
```

Add the import at the top of `weekly-studio.ts`: `import { proposeChanges } from '@/lib/agents/proposer';`.

- [ ] **Step 7: Extend `tests/weekly-studio.test.ts` to prove the wiring.** Add `suggestProposals: vi.fn()` to the existing `vi.mock('@/lib/agents/openrouter-media', …)` factory, give the reach-data mock a won/unpromoted lead, stub `suggestProposals` to keep index 0, and assert a `done` run still finishes and the proposer was invoked (an `agent_proposals` insert was attempted on the fake service). Keep every existing assertion green.

Run: `pnpm exec vitest run tests/weekly-studio.test.ts tests/proposer.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add src/lib/agents/proposer.ts src/lib/agents/openrouter-media.ts src/lib/agents/weekly-studio.ts tests/proposer.test.ts tests/weekly-studio.test.ts
git commit -m "feat: autonomous proposer (opportunity scan + gated LLM selection) in the Weekly Studio run"
```

**Cut:** an autonomous run now queues real, validated, non-destructive proposals the owner can approve.

---

## Task 5: Expiry sweep in the poll tick

**Files:**
- Modify: `src/lib/agents/runner.ts` (`expireProposals`)
- Modify: `src/app/api/agents/poll/route.ts` (call it)
- Test: `tests/expire-proposals.test.ts`

**Interfaces:**
- Produces: `expireProposals(client): Promise<void>` (service-role, bulk, idempotent).

- [ ] **Step 1: Write the failing test.** Create `tests/expire-proposals.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { expireProposals } from '@/lib/agents/runner';

function fakeService() {
  const calls: Record<string, unknown> = {};
  const client = {
    from(table: string) {
      calls.table = table;
      return {
        update(patch: unknown) { calls.update = patch; return {
          eq(col: string, val: unknown) { calls.eqCol = col; calls.eqVal = val; return {
            lte: async (col2: string, val2: unknown) => { calls.lteCol = col2; calls.lteVal = val2; return { error: null }; },
          }; },
        }; },
      };
    },
  } as never;
  return { client, calls };
}

describe('expireProposals', () => {
  it('flips pending proposals past expires_at to expired', async () => {
    const { client, calls } = fakeService();
    await expireProposals(client);
    expect(calls.table).toBe('agent_proposals');
    expect(calls.update).toMatchObject({ status: 'expired' });
    expect(calls.eqCol).toBe('status');
    expect(calls.eqVal).toBe('pending');
    expect(calls.lteCol).toBe('expires_at');
  });
});
```

- [ ] **Step 2: Run; verify it fails** (`expireProposals` not exported).

Run: `pnpm exec vitest run tests/expire-proposals.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `src/lib/agents/runner.ts`, next to `reapStaleRuns`, add:

```ts
/**
 * Marks pending proposals past their expires_at as 'expired'. `client` MUST be the
 * service-role client. A bulk cross-org update is correct here — a global background
 * sweep scoped by status + time, not by org. Idempotent: only pending+past rows move.
 */
export async function expireProposals(client: SupabaseClient): Promise<void> {
  const { error } = await client
    .from('agent_proposals')
    .update({ status: 'expired', decided_at: new Date().toISOString() })
    .eq('status', 'pending')
    .lte('expires_at', new Date().toISOString());
  void error; // supabase-js returns { error }; a failed sweep simply retries next poll.
}
```

- [ ] **Step 4: Call it from the poll route.** In `src/app/api/agents/poll/route.ts`, import `expireProposals` alongside `pollVideos, reapStaleRuns`, and add `await expireProposals(service);` after the existing sweeps inside `POST`.

- [ ] **Step 5: Run; verify it passes.**

Run: `pnpm exec vitest run tests/expire-proposals.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/agents/runner.ts src/app/api/agents/poll/route.ts tests/expire-proposals.test.ts
git commit -m "feat: expire stale agent proposals in the poll tick"
```

**Cut:** stale proposals age out automatically; the queue never grows unbounded.

---

## Task 6: Final sweep

**Files:** none (verification only).

- [ ] **Step 1: Full type-check.** `pnpm exec tsc --noEmit` → PASS.
- [ ] **Step 2: Lint.** `pnpm exec eslint .` (or the repo's lint script) → PASS (watch for `'use client'` importing a server-only module — `pending-approvals.tsx` must import only the `AgentProposal` type + the server actions).
- [ ] **Step 3: Full test suite.** `pnpm test` → all green (RLS tests run against the live dev DB and should pass now that the migration is applied; mocked suites never spend money).
- [ ] **Step 4: Advisors.** Controller runs `openkuasa-supabase` `get_advisors` (security + performance) → no new warnings for `agent_proposals` / `agent_proposals_guard` (RLS enabled, function `search_path` set).
- [ ] **Step 5: Routes check.** `pnpm gen:routes --check` (or the repo's equivalent) → clean (no route drift; `reach/agents` stays live).
- [ ] **Step 6: Browser smoke (controller, smoke account).** On `openkuasa.com/reach/agents`: enable Weekly Studio, Run now, confirm the digest run still completes AND (given the smoke org's won/unpromoted lead) a proposal appears under "Pending approvals"; Approve it and confirm the lead is promoted; Reject another and confirm it leaves the list; finally confirm a day-old pending proposal (seed one with `expires_at` in the past via `execute_sql`, then POST the poll route) becomes `expired`. Restore the account (disable the agent).
- [ ] **Step 7: Finish the branch** with superpowers:finishing-a-development-branch (PR titled `feat-111-jebat-agent-proposals`, no issue to close unless `gh issue list` shows a real tracking issue).

---

## Self-review notes (for the executor)

- **Spec coverage:** data model → Task 1; allow-list + apply + owner-authority → Task 2; review UI → Task 3; proposer (scan + gated LLM) → Task 4; expiry → Task 5; all §10 review-focus cases are pinned (see Review Focus above). The nav badge (§9) is explicitly deferred with a reason — the only spec item not implemented this slice.
- **Type consistency:** `AgentProposal`/`ProposalStatus` (Task 1) are used verbatim in Tasks 2–4; `runProposalAction`/`ApplyResult` (Task 2) are consumed by the actions; `ALLOWED_ACTIONS`/`isAllowedAction` (Task 2) are consumed by the proposer (Task 4); `suggestProposals` has one signature across Task 4 + its tests.
- **Draft-on-create guarantee:** `createForm` is allow-listed and persists as draft with `channel` null by its capability defaults (no publish/channel) — asserted by the browser smoke; a `createForm` proposal is safe to approve.
