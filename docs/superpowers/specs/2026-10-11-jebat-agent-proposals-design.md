# Jebat Autonomous Proposals — Propose → Approve → Apply (Slices 5b + 5c) — Design

**Status:** approved in chat 2026-10-11. Source of truth for the plan. Second vertical of the
autonomous-agent feature (decomposition: 5a shipped, **5b + 5c this**, 5d full crew). Builds on
`docs/superpowers/specs/2026-10-10-jebat-autonomous-agent-design.md` (5a) and
`docs/superpowers/specs/2026-10-11-jebat-agent-scheduling-design.md` (scheduling).

## 1. Goal

Let Jebat's autonomous agent go beyond *drafting a digest* to **proposing concrete marketing
changes** while the owner is away. Each proposal lands in a durable **approval queue**; the owner
reviews it with the same Approve/Reject card used in chat; **nothing touches org data until the
owner approves**, and when they do, the change is applied **under the owner's own authority**
(their session + RLS/write grants), never the service-role worker. 5a was deliberately read-only
to avoid the approval-card conflict; 5b + 5c are where autonomous *writes* safely enter, with the
queue as the only gate.

This ships as ONE working vertical: the existing **Weekly Studio** run, after it writes its
digest, runs an **opportunity scan + an LLM "propose" step** that emits a bounded set of
non-destructive proposals into the queue; the **AI Agents screen** grows a "Pending approvals"
section; Approve applies the change through the existing reach capability; Reject drops it; stale
proposals expire.

## 2. Context (surveyed 2026-10-11)

- **The proposal shape already exists** (`src/lib/chat/delegation.ts`): `Proposal = { id, product,
  action, input, title, detail }` — self-describing, product = route segment (`reach`), action =
  a capability name (`promoteLeadToContact`), input = the args. This is exactly what the queue
  persists.
- **The apply dispatch already exists** (`src/lib/ai/agents/specialists.ts` ~L260): a prepared
  proposal is carried out by looking up `product.write[proposal.action]` and calling it with
  `proposal.input`, behind `toolApproval: { applyChange: 'user-approval' }`. In chat this runs
  under the **authenticated user's** reach write context — 5c reuses the same capability, invoked
  from an owner server action.
- **Approval wording is pure and reusable** (`src/lib/chat/change-titles.ts`): `approvalTitle(tool,
  input, nameFinder)` and `approvalDetail(tool, input)` already word every reach action
  ("Promote lead "Aina Rahman" to a CRM contact?", "Book appointment with "Daniel Lim"?", "Create
  lead form "X"?"). `approvalDetail` returns `null` for all non-destructive reach actions (no
  warning needed). The proposer computes and stores the title at propose-time.
- **Reach write capabilities** (`src/lib/reach/capabilities.ts`): each is an exported
  `async function <name>(ctx: ReachWriteContext, input)` with a sibling exported Zod
  `<name>Input` schema. Full set: campaigns (create/update/setStatus/delete), leads
  (create/update/setStage/delete), appointments (create/update/setStatus/delete),
  promoteLeadToContact, creatives (create/update/delete), updateAdSettings, forms
  (create/update/setStatus/delete), deleteFormSubmission.
- **The reach write context**: reach actions build `createSupabaseReachData(sessionClient, orgId)`
  + a `ReachWriteContext` with `canWrite` from the authenticated session (see
  `src/app/(app)/reach/actions.ts`). The service-role worker uses
  `createSupabaseReachData(serviceClient, orgId)` for READS only.
- **5a infra in place**: `agent_configs`/`agent_runs`/`agent_run_assets`, `src/lib/agents/{runner,
  weekly-studio,openrouter-media,config,types}.ts`, `/api/agents/{run,poll}` (service-role-key
  authed), the live `reach/agents` screen + `agents-panel.tsx`. The poll tick already runs on the
  Railway cron and is the natural home for the expiry sweep. `service_role` needs explicit DML
  grants (lesson: `service-role-needs-explicit-grants`).
- **Precedent:** Bendahara uses a `pending_approval` transaction status; `notifications` table
  exists (the bell). No `agent_proposals` table exists yet.

## 3. Decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Vertical | One loop end-to-end: Weekly Studio proposes → queue → owner approves → apply → expire | Ships 5b + 5c as working value |
| Risk posture | **Non-destructive / reversible actions only** (allow-list, §8) — no deletes, no publishes/go-live/spend, nothing irreversible, even behind approval | A wrong approval is always undoable |
| Decision model | **Hybrid** — a deterministic opportunity scan surfaces candidates; the LLM picks + writes specifics; the **server validates every proposal against the allow-list + the capability Zod schema** before queuing | Autonomy the owner asked for, but a hallucinated/malformed proposal never reaches the queue; testable |
| Who applies | The **owner**, via a server action under their session client (`is_org_writer` / RLS), reusing the reach capability | Nothing is written to org data without an authenticated human action |
| Proposer writes | The LLM can ONLY emit proposals through side-effect-free `propose` tools; it never holds a real write tool | The model can never write org data, only suggest |
| Persistence | New `agent_proposals` table; worker (service-role) inserts; members read; owner updates status | A durable queue outlives the chat/run |
| Caps | ≤ **5** proposals per run; **14-day** TTL → `expired`; propose step counts toward the run's existing `max_cost_cents` | Bound queue flooding + spend |
| Scope of products | **reach (Jebat) only** this slice | Matches 5a; cross-product queue is later |

## 4. Global constraints (carry into every task)

- No Kuasa brand names in `src/`; **no purple/violet/indigo/fuchsia** in the UI; fictional data only.
- Supabase project `ugchntdgaeefmufumchx` via the `openkuasa-supabase` MCP ONLY. Controller applies
  migrations; implementers own the committed `.sql` + TS + tests.
- TypeScript strict; 2-space indent, single quotes, semicolons; named exports; functional
  components + hooks; pnpm. `'use client'` never imports `@/lib/ai/*` or `@/lib/reach/capabilities`.
- A new live screen change → keep `reach/agents` in `src/config/live-screens.ts`; regenerate routes
  (`gen:routes`) if routing-relevant.
- **Never log, print, or commit any API key** (OpenRouter, service-role). `.env*` read/write-denied.
- **CI must not spend real money**: every test mocks OpenRouter; no test performs a real LLM call.

## 5. Data model

Migration adds (public schema, two-layer RLS mirroring the reach + agent tables; FK
`org_id → orgs(id) on delete cascade`):

```sql
create table public.agent_proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  run_id uuid references public.agent_runs(id) on delete set null,
  agent_key text not null default 'weekly-studio',
  product text not null default 'reach' check (product in ('reach')),
  action text not null,                 -- an allow-listed reach capability name
  input jsonb not null,                 -- args, validated at propose-time and re-validated at apply
  title text not null,                  -- the approval-card question (from approvalTitle)
  detail text,                          -- optional warning (from approvalDetail; null for these)
  rationale text,                       -- one line: why Jebat suggests it (shown to the owner)
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','expired','failed')),
  result jsonb,                         -- capability result on apply, or { error } on failure
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id),
  expires_at timestamptz not null default (now() + interval '14 days')
);
create index on public.agent_proposals (org_id, status, created_at desc);
```

**RLS (two-layer, mirroring reach tables):** `agent_proposals_select = is_org_member(org_id)`;
`mfa_required` restrictive. **No authenticated INSERT** — only the worker's service-role inserts
(explicit grant). **Authenticated UPDATE** of `status, result, decided_at, decided_by` only, policy
`is_org_writer(org_id)` (the owner's approve/reject action); a DB trigger (or the action + a
`check`) forbids leaving `pending` to anything but `approved|rejected`, and forbids editing a row
that is no longer `pending` (idempotency at the data layer). No authenticated DELETE.

**Grants** (add to the agent grants migration pattern per `service-role-needs-explicit-grants`):
`grant insert, select, update on public.agent_proposals to service_role;` (worker inserts +
expiry sweep); `grant select on public.agent_proposals to authenticated;` + `grant
update (status, result, decided_at, decided_by) on public.agent_proposals to authenticated;`.

## 6. The proposer (5b) — inside the Weekly Studio run

`src/lib/agents/proposer.ts`, called from `runWeeklyStudio` after the digest is written (so the
digest still ships even if proposing fails; proposing is wrapped in its own try/catch and never
fails the run).

1. **Opportunity scan** (deterministic, service-role, org-scoped; reuses the reach data the run
   already loaded): compute candidate situations, e.g.
   - a **won** lead with `promoted_contact_id is null` → candidate `promoteLeadToContact`.
   - a **qualified** or **booked** lead with no upcoming appointment → candidate
     `createAppointment` (a follow-up).
   - a lead whose only appointment is **completed** but is still in an earlier stage → candidate
     `setLeadStage` (advance it; reversible).
   - the week's **trend angle** (from the web search the run already did) → candidate
     `createForm` (a **draft** lead form to capture interest).
   The scan caps candidates and de-duplicates against the current state and existing `pending`
   proposals (see Dedupe below).
2. **LLM picks + writes specifics**: one AI SDK call on the org's OpenRouter key, given the digest
   context + the candidate list, with **side-effect-free `propose` tools** — one per allow-listed
   action (`proposePromoteLead`, `proposeSetLeadStage`, `proposeBookAppointment`,
   `proposeUpdateAppointment`, `proposeSetAppointmentStatus`, `proposeCreateLeadForm`,
   `proposeUpdateLeadForm`). Each tool only **records** `{ action, input, rationale }`; the model
   holds **no real write tool** and cannot touch data. The model may decline (propose nothing).
3. **Server gate** (the safety core — runs over the recorded intents, not trusting the model):
   for each recorded `{ action, input, rationale }`:
   - `action` MUST be in the allow-list (§8); else drop.
   - `input` MUST parse against the capability's `<action>Input` Zod schema; else drop.
   - any referenced `id` (lead/appointment/form/campaign) MUST exist and belong to the org
     (service-role read, org-scoped); else drop.
   - MUST NOT duplicate a still-`pending` proposal (same `action` + same target `id`/name) or a
     state already satisfied (e.g. the lead is already promoted); else drop.
   - stop once **5** valid proposals are queued.
   Valid ones are inserted `pending` with `title = approvalTitle(action, input, nameFinder)`,
   `detail = approvalDetail(action, input)` (null for these), `rationale`, `run_id`, `expires_at`.
   Dropped intents are counted + logged (no key material), never queued.
4. **Cost**: the propose LLM call's usage is added to the run's `cost_cents`; if the run is already
   at `max_cost_cents`, the propose step is skipped entirely (recorded, not an error).

## 7. Apply / reject / expire (5c)

- **`applyProposalAction(id)`** — server action in `src/app/(app)/reach/actions.ts`, `edit-data`
  gated (viewer denied). Steps: load the proposal via the **session** client (RLS scopes to the
  owner's org); require `status === 'pending'` and `expires_at > now()` (else a no-op result
  "already handled"); **re-parse `input`** against `<action>Input` (defence in depth; queued input
  is untrusted); dispatch `action → capability` through a small map in
  `src/lib/agents/apply-proposal.ts` and call it with the owner's `ReachWriteContext`
  (`createSupabaseReachData(sessionClient, orgId)` + `canWrite`). On success → `status='approved'`,
  `result`, `decided_by/at`; on capability failure (returns `{ ok:false }`) → `status='failed'`,
  `result={error}`. Revalidate `/reach/agents`.
- **`rejectProposalAction(id)`** — `edit-data` gated; pending-only → `status='rejected'`,
  `decided_by/at`. No capability call.
- **Expiry sweep** — in the existing poll tick (`reapStaleRuns`/`pollVideos` path in
  `runner.ts`, service-role): `update agent_proposals set status='expired' where status='pending'
  and expires_at <= now()` (org-scoped per processed config). Idempotent.
- **Idempotency** — the status guard (action + DB trigger) makes a second apply/reject/expire of a
  non-pending row a no-op.

## 8. Allow-list (enforced server-side, both at propose-time and apply-time)

**Allowed** (non-destructive, reversible, no go-live/spend, and — verified against
`capabilities.ts` — all **channel-free**): `promoteLeadToContact`, `setLeadStage`,
`createAppointment`, `updateAppointment`, `setAppointmentStatus`, `createForm`, `updateForm`.
`createForm` persists as **draft** with `channel` null by its capability defaults, so a
proposed+approved form is not public and names no ad platform until a human separately activates it.

**Explicitly excluded, with the reason** (verified in `capabilities.ts`):
- every `delete*` (`deleteLead/Campaign/Appointment/Form/Creative/FormSubmission`) — destructive.
- `setFormStatus` — activating a form **publishes** it publicly; `setCampaignStatus` — resuming
  makes **ads go live and spend**; `updateAdSettings` — changes caps/billing. Go-live/spend.
- `createCampaign`/`updateCampaign` — `createCampaignInput.status` **defaults to `active`** (a
  created campaign is live/spending) AND requires a `channel`. Go-live + ad-platform-bound.
- `createCreative`/`updateCreative` — require a `channel` (ad creatives bound to an ad platform).
- `createLead`/`updateLead` — require/accept a `channel`. The agent never fabricates ad-platform
  leads; it works the channel-free lifecycle of leads that already arrived.

**Consequence worth noting:** the `channel` enum is exactly the ad platforms
(whatsapp/facebook/instagram/tiktok), so every excluded-for-channel action is also the one that
would put another SaaS's name on a proposal. Keeping the agent to the channel-free lifecycle
(nurture existing leads → book meetings → capture via a draft form) makes its proposals both
non-destructive **and** free of other-SaaS names, matching the project's no-other-SaaS posture.

The allow-list is a single exported constant; the `propose` tool set, the propose-time gate, and
the apply-time dispatch all derive from it (one source of truth).

## 9. Review UI — `src/screens/reach/agents.tsx` + `src/components/reach/pending-approvals.tsx`

- A **"Pending approvals"** section above run history: load the org's `pending` proposals (session
  client, newest first) in the server component. Each row shows the `title`, a one-line
  `rationale` ("Why Jebat suggests this"), the `detail` warning if any, and **Approve / Reject**
  buttons wired to the server actions. `edit-data` gated: viewers see the list read-only (no
  buttons, a muted "ask an owner to review" note). Honest empty state ("No suggestions waiting —
  Jebat will add some after its next run.").
- A **pending-count badge** on the "AI Agents" nav item (a small count query; reuse the existing
  nav badge mechanism if one exists, else a server-computed count passed to the nav).
- After a decision the row leaves `pending` (revalidate). A collapsed **"Recently decided"** trail
  shows the last few approved/rejected/expired with their outcome. No purple/violet. Client
  component imports types only, never `@/lib/ai/*` or the capabilities.

## 10. Security & review focus

- **The model never writes**: it holds only side-effect-free `propose` tools; all real writes go
  through the server gate (propose-time) + the owner's approval (apply-time). The allow-list +
  Zod re-validation run at BOTH points.
- **Owner authority on apply**: the capability runs under the owner's session/RLS, never the
  service-role worker; a viewer is denied; cross-org is impossible (RLS + org-scoping).
- **Service-role containment**: the worker only INSERTs proposals + runs the expiry sweep, always
  org-scoped; it never applies a change.
- **Non-destructive guarantee**: the allow-list excludes every delete/publish/go-live; a mistaken
  Approve is always reversible.
- **Review focus (inputs the spec implies but a happy path won't hit):**
  1. a proposal whose target lead/appointment was deleted between propose and approve → apply
     fails cleanly (`failed`, clear result), no crash.
  2. the same opportunity proposed on two consecutive runs → deduped (not re-queued) because a
     `pending` one exists or the state is already satisfied.
  3. a viewer taps Approve/Reject → denied (`edit-data` gate).
  4. an expired proposal is approved → guarded no-op ("already handled").
  5. the LLM emits an off-allow-list action, a malformed `input`, or an id from another org → each
     dropped at the propose gate, never queued.
  6. the run is at its cost cap → the propose step is skipped (digest still shipped), recorded.
  7. a second Approve of the same row (double-click / two owners) → status guard makes it a no-op;
     the change is applied exactly once.
  8. `createForm` approved → the row is created as **draft** with `channel` null (not public, no
     ad platform named), confirmed by a test asserting the persisted status/channel.

## 11. Files

**New:** migration `<ts>_agent_proposals.sql` (table + RLS + status trigger + grants incl.
service_role + authenticated-update-columns); `src/lib/agents/proposer.ts` (opportunity scan +
`propose` tools + server gate + insert); `src/lib/agents/apply-proposal.ts` (allow-list constant +
action→capability dispatch + re-validation); `src/lib/agents/proposals.ts` (types + a
`listPendingProposals(client, orgId)` read used by the screen); `src/components/reach/
pending-approvals.tsx` (client list); tests (RLS; proposer allow-list + Zod + dedupe + cap, with
mocked OpenRouter; apply dispatch per action + re-validation + owner-context; reject; expiry sweep;
idempotency/status-guard; viewer-denied; draft-on-create).

**Modified:** `src/lib/agents/weekly-studio.ts` (call the proposer after the digest, cost-gated,
own try/catch); `src/lib/agents/runner.ts` (expiry sweep in the poll tick); `src/lib/agents/
types.ts` (proposal types); `src/app/(app)/reach/actions.ts` (`applyProposalAction`,
`rejectProposalAction`); `src/screens/reach/agents.tsx` (load + render pending approvals); the
agent grants migration (add `agent_proposals`).

## 12. Out of scope (later sub-slices / never)

- 5d multi-agent crew + richer dashboard; Kasturi/Finance agent proposals (cross-product queue).
- Destructive or go-live proposals (delete, publish a form, resume a campaign, ad-settings) — never
  via the autonomous agent.
- The owner **editing** a proposal's input before approving (approve-as-is or reject only, this
  slice); a proposal that bundles several changes as one card; proposals from the chat assistant
  (the chat already applies in-session — this queue is for *autonomous* runs only).
- AI chat tools that configure the agent; notifications beyond the in-app badge (email/push).

## 13. Plan order (for writing-plans)

Spine first, a clean cut after each layer so a partial slice still ships value:
migration (table + RLS + trigger + grants) + types + RLS test → allow-list constant +
`apply-proposal` dispatch + `applyProposalAction`/`rejectProposalAction` (unit-tested against
seeded `pending` rows, no proposer yet) [cut: a human-seeded proposal can be approved/applied] →
`pending-approvals` UI on `reach/agents` (list + approve/reject + empty state + badge) [cut: the
queue is reviewable end-to-end] → `proposer` (opportunity scan + `propose` tools + server gate,
OpenRouter mocked) wired into `runWeeklyStudio` behind the cost cap [cut: autonomous proposals
appear after a run] → expiry sweep in the poll tick + dedupe hardening → final sweep (tsc/eslint/
suite, `get_advisors`, `gen:routes --check`; browser smoke on the smoke account: a run proposes,
the owner approves, the change lands).
