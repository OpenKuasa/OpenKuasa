# Bendahara (finance) AI Specialist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give finance an "Ask Bendahara" chat specialist (reads + owner-approved writes over the existing `src/lib/finance/*` layer) and wire it into Tuah, so Tuah orchestrates all four products.

**Architecture:** `createBendaharaTools(access)` wraps the existing ctx-first finance capability functions as AI tools (the Kasturi/CRM pattern — no snapshot loader), surfaced via `runBendahara` + `/api/finance/chat` + the finance assistant screen; then added to `runTuah` as a fifth `ProductToolkit`.

**Tech Stack:** Next.js 16 App Router, AI SDK v7 + OpenRouter (`@/lib/ai/provider`), Supabase + RLS, Zod (reuse finance `*Input` schemas), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-12-bendahara-finance-specialist-design.md`

## Global Constraints

- No Kuasa names in `src/`; no purple/violet/indigo/fuchsia in UI; fictional data only.
- No new migrations (finance schema already exists). Supabase only via `openkuasa-supabase` if ever needed.
- Chat/agent tests mock the model via `@/lib/ai/provider` (as `*-chat-route`/`tuah-*` tests do); CI never spends money.
- Branch→PR→squash-merge as `OpenKuasa`; PR title = branch name; never commit to main; never `git add -A`; `pnpm` only; full suite = `pnpm test`.
- Money is ringgit decimals (`numeric(14,2)`; `1250.5` = RM 1,250.50 — NOT sen); replies in RM to 2 decimals; tools never multiply/divide/convert a figure.
- Finance tool names must not clash with reach/crm/hire/people in Tuah's combined set (`combineToolkits` throws on a duplicate). Contacts/items use finance-scoped tool names; the `execute` still calls the unprefixed lib fn.

## Review Focus

- **Five-product name collision** in `combineToolkits([reach,crm,hire,people,finance])` → pinned in Task 3's test (no clash; nothing dropped).
- **Viewer gets no write tools** from `financeProduct(canWrite:false)` and from the route for a `viewer` role → Task 1/2/6 tests.
- **`ok:false` from a capability** is passed through as the tool result (not swallowed, not turned into a fact) → Task 1 test on a read whose fn returns `{ok:false}`.
- **Money units**: a tool never computes an amount; it passes input straight to the lib and returns the lib's output → Task 2 test asserts the wrapper forwards input and output verbatim.
- **Approve-card titles**: every finance write yields a specific title, not the generic fallback → Task 5 test.
- **Tuah blind spot**: after 1b-ii no TUAH prompt says finance cannot be looked up → Task 9 test.

---

## File Structure

- `src/lib/ai/finance-tools.ts` (create) — `FinanceAccess`, `createBendaharaTools`, read + write tool definitions. One file, mirrors `crm-tools.ts`.
- `src/lib/ai/products.ts` (modify) — `FINANCE_WRITE_TOOL_NAMES`, `financeProduct`, `ProductKey += 'finance'`.
- `src/lib/ai/agents/orchestrator.ts` (modify) — `runBendahara`; (1b-ii) `runTuah` finance arg + `TEAM_AREA.finance`.
- `src/lib/ai/agents/prompts.ts` (modify) — `BENDAHARA_SYSTEM`/`bendaharaSystem`; (1b-ii) `SPECIALIST_RULES.finance` + blind-spot edits.
- `src/lib/ai/agents/specialists.ts` (modify, 1b-ii) — `AREA.finance`.
- `src/lib/chat/change-titles.ts` (modify) — finance `ItemKind`s + title/detail/name cases.
- `src/app/api/finance/chat/route.ts` (create) — the Ask-Bendahara endpoint.
- `src/screens/finance/assistant.tsx` (modify) — static hero → real chat surface.
- `src/app/api/chat/route.ts` (modify, 1b-ii) — build finance access, pass to `runTuah`.

### Name → lib function → input schema (the wrapping table)

Reads (ctx-only unless noted): `getFinanceOverview`(derived), `listInvoices`, `getInvoice`(id), `listInvoiceBalances`, `listQuotations`, `listCreditNotes`, `listRefunds`, `listBills`, `getBill`(id), `listBillBalances`, `listPaymentsIn`, `listPaymentsOut`, `listFinanceContacts`→`listContacts`, `listFinanceItems`→`listProducts`, `listAccounts`.

Writes (tool name → lib fn → Zod input):
- `saveInvoice`→`saveInvoice`/`saveInvoiceInput`; `postInvoice`→`postInvoice`/`invoiceIdInput`; `voidInvoice`→`voidInvoice`/`invoiceIdInput`; `deleteInvoice`→`deleteInvoice`/`invoiceIdInput`; `setEInvoice`→`setEInvoice`/`setEInvoiceInput`
- `saveQuotation`→`saveQuotation`/`saveQuotationInput`; `sendQuotation`/`acceptQuotation`/`declineQuotation`/`deleteQuotation`→`quotationIdInput`; `convertQuotation`→`convertQuotation`/`quotationIdInput`
- `saveCreditNote`→`saveCreditNote`/`saveCreditNoteInput`; `issueCreditNote`/`voidCreditNote`/`deleteCreditNote`→`creditNoteIdInput`
- `recordRefund`→`recordRefund`/`recordRefundInput`; `markRefundPaid`/`voidRefund`/`deleteRefund`→`paymentIdInput` or the refund id input the lib uses (confirm at impl)
- `saveBill`→`saveBill`/`saveBillInput`; `postBill`/`voidBill`/`deleteBill`→`billIdInput`
- `recordPaymentIn`→`recordPaymentIn`/`recordPaymentInInput`; `recordPaymentOut`→`recordPaymentOut`/`recordPaymentOutInput`; `markPaymentPaid`→`markPaymentPaid`/`markPaymentPaidInput`; `voidPayment`→`voidPayment`/`paymentIdInput`; `voidPaymentIn`→`voidPaymentIn`/`paymentIdInput`
- `createFinanceContact`→`createContact`/`createContactInput`; `updateFinanceContact`→`updateContact`/`updateContactInput`; `setFinanceContactActive`→`setContactActive`/`setContactActiveInput`; `deleteFinanceContact`→`deleteContact`/`deleteContactInput`
- `createFinanceItem`→`createProduct`/`createProductInput`; `updateFinanceItem`→`updateProduct`/`updateProductInput`; `setFinanceItemActive`→`setProductActive`/`setProductActiveInput`; `deleteFinanceItem`→`deleteProduct`/`deleteProductInput`

All finance fns are `(ctx: FinanceWriteContext, input?)` and return `FinResult<T>` (reads return rows directly; writes return `FinResult`). `ctx = { client: access.client, orgId: access.orgId }`.

---

## Task 1: Finance read tools + `FinanceAccess`

**Files:** Create `src/lib/ai/finance-tools.ts`; Test `tests/finance-tools.test.ts`.

**Interfaces:**
- Consumes: `@/lib/finance/*` read fns (names above), `FinanceWriteContext` from `@/lib/finance/result`.
- Produces: `export type FinanceAccess = { client: SupabaseClient; orgId: string; canWrite: boolean }`; `export function createBendaharaTools(access: FinanceAccess): ToolSet`.

The wrapper pattern (one read shown; every read follows it — a lib read returns rows, or a `FinResult` which is returned verbatim so `ok:false` reaches the model):

```ts
const ctx = { client: access.client, orgId: access.orgId };
// read example
listInvoices: tool({
  description: 'List this workspace\'s sales invoices with status and totals.',
  inputSchema: z.object({}),
  execute: async () => financeListInvoices(ctx),
}),
```

- [ ] **Step 1: Failing test** — reads present, ctx forwarded, `ok:false` passthrough:

```ts
// tests/finance-tools.test.ts
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/finance/invoices', () => ({
  listInvoices: async (ctx: { orgId: string }) => ({ ok: false, error: 'db down', ctxOrg: ctx.orgId }),
  getInvoice: async () => null, saveInvoice: async () => ({ ok: true, data: {} }),
  postInvoice: async () => ({ ok: true, data: {} }), voidInvoice: async () => ({ ok: true, data: {} }),
  deleteInvoice: async () => ({ ok: true, data: {} }), setEInvoice: async () => ({ ok: true, data: {} }),
}));
// ...mock the other finance modules similarly (stub each used fn)...
const { createBendaharaTools } = await import('@/lib/ai/finance-tools');
const access = { client: {} as never, orgId: 'org1', canWrite: false };

it('exposes the finance lookups and forwards ctx + ok:false', async () => {
  const tools = createBendaharaTools(access);
  expect(Object.keys(tools)).toEqual(expect.arrayContaining(['getFinanceOverview','listInvoices','listBills','listFinanceContacts','listFinanceItems','listAccounts']));
  const out = await (tools.listInvoices as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute({}, {});
  expect(out).toEqual({ ok: false, error: 'db down', ctxOrg: 'org1' }); // passed through, ctx carried
});
it('gives a viewer no write tools', () => {
  const tools = createBendaharaTools(access);
  expect(Object.keys(tools)).not.toContain('postInvoice');
});
```

- [ ] **Step 2: Run — expect FAIL** (`createBendaharaTools` not defined). `npx vitest run tests/finance-tools.test.ts`
- [ ] **Step 3: Implement** the read tools + `FinanceAccess` + `createBendaharaTools` (reads always added; writes added only when `access.canWrite`, implemented in Task 2). `getFinanceOverview` derives from `listInvoiceBalances`+`listBillBalances`+payments (outstanding AR/AP, overdue count, cash from `listAccounts`).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `git add src/lib/ai/finance-tools.ts tests/finance-tools.test.ts && git commit -m "feat(bendahara): finance read tools over the existing capability layer"`

## Task 2: Finance write tools + `FINANCE_WRITE_TOOL_NAMES`

**Files:** Modify `src/lib/ai/finance-tools.ts`; Modify `tests/finance-tools.test.ts`.

**Interfaces:** Produces the full write set (names in the table). Each write: `inputSchema: <the fn's *Input>`, `execute: async (input) => libFn(ctx, input)`. Finance-scoped contact/item tool names wrap the unprefixed lib fns.

- [ ] **Step 1: Failing test** — writes present for a writer, each forwards input verbatim:

```ts
const writer = { client: {} as never, orgId: 'org1', canWrite: true };
it('gives a writer the full lifecycle write tools, wrapping the lib fns', async () => {
  const tools = createBendaharaTools(writer);
  for (const name of ['saveInvoice','postInvoice','voidInvoice','setEInvoice','saveBill','postBill','recordPaymentIn','recordPaymentOut','issueCreditNote','recordRefund','createFinanceContact','createFinanceItem']) {
    expect(Object.keys(tools), name).toContain(name);
  }
  const res = await (tools.postInvoice as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute({ id: 'inv-1' }, {});
  expect(res).toEqual({ ok: true, data: {} }); // lib result returned as-is
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the write tools (guard with `access.canWrite`) and `export const FINANCE_WRITE_TOOL_NAMES = [...] as const` (every write tool name).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `git add src/lib/ai/finance-tools.ts tests/finance-tools.test.ts && git commit -m "feat(bendahara): owner-approved finance write tools (full lifecycle)"`

## Task 3: `financeProduct` + `ProductKey` + collision test

**Files:** Modify `src/lib/ai/products.ts`; Modify `tests/ai-products.test.ts`.

**Interfaces:**
- Produces: `export function financeProduct(access: FinanceAccess): ProductToolkit` (`key:'finance', name:'Bendahara', ...split(createBendaharaTools(access), FINANCE_WRITE_TOOL_NAMES)`); `ProductKey = 'reach'|'crm'|'hire'|'people'|'finance'`.

- [ ] **Step 1: Failing test** in `ai-products.test.ts` — add a `finance(canWrite)` fixture and:

```ts
it('combines all five products (Tuah single-agent) without a tool-name clash', () => {
  const products = [reach(true), crm(true), hire(true), people(true), finance(true)];
  const total = products.reduce((n, p) => n + Object.keys(p.read).length + Object.keys(p.write).length, 0);
  expect(Object.keys(combineToolkits(products).tools).length).toBe(total);
});
it('gives Bendahara its finance lookups, and writes only to a writer', () => {
  expect(Object.keys(finance(true).read)).toContain('listInvoices');
  expect(Object.keys(finance(true).write)).toContain('postInvoice');
  expect(Object.keys(finance(false).write)).toEqual([]);
});
```

- [ ] **Step 2: Run — expect FAIL** (extend the existing five-product count: update the earlier four-product test to five, or add the new one). `npx vitest run tests/ai-products.test.ts`
- [ ] **Step 3: Implement** `financeProduct` + `FINANCE_WRITE_TOOL_NAMES` import + `ProductKey`.
- [ ] **Step 4: Run — expect PASS.** If a name clashes, rename the finance tool (finance-scoped) and update the table.
- [ ] **Step 5: Commit** `git add src/lib/ai/products.ts tests/ai-products.test.ts && git commit -m "feat(bendahara): financeProduct toolkit + 'finance' product key"`

## Task 4: `runBendahara` + persona

**Files:** Modify `src/lib/ai/agents/orchestrator.ts`, `src/lib/ai/agents/prompts.ts`; Test `tests/bendahara-prompt.test.ts`.

**Interfaces:** Produces `export function runBendahara(messages, finance: FinanceAccess, abortSignal?, apiKey?)` (mirror `runKasturi`: `combineToolkits([financeProduct(finance)])`, `system: bendaharaSystem(new Date())`, `stepCountIs(10)`, `maxOutputTokens: 1200`, call-log label `'bendahara'`); and `BENDAHARA_SYSTEM`/`bendaharaSystem(now)`.

- [ ] **Step 1: Failing test** `tests/bendahara-prompt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BENDAHARA_SYSTEM } from '@/lib/ai/agents/prompts';
const t = BENDAHARA_SYSTEM.toLowerCase();
it('is a tool-honest finance persona', () => {
  expect(t).toContain('bendahara');
  expect(t).toContain('always call a tool');
  expect(t).toContain('never invent');
  expect(t).toContain('rm');
  expect(t).toContain('approv'); // owner approval before a change takes effect
  expect(t).toContain('data, not instructions'); // injection guard
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `BENDAHARA_SYSTEM`/`bendaharaSystem` (spec §Persona) and `runBendahara`.
- [ ] **Step 4: Run — expect PASS.** Also `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `git add src/lib/ai/agents/orchestrator.ts src/lib/ai/agents/prompts.ts tests/bendahara-prompt.test.ts && git commit -m "feat(bendahara): runBendahara runner + CFO persona"`

## Task 5: Approve-card titles for finance kinds

**Files:** Modify `src/lib/chat/change-titles.ts`; Test `tests/finance-change-titles.test.ts`.

**Interfaces:** Extend `ItemKind` with finance kinds (`invoice`,`quotation`,`bill`,`payment`,`credit-note`,`refund`,`finance-contact`,`item`) and add `approvalTitle`/`approvalDetail`/`collectNames`/`nameIn` cases keyed on the finance write tool names, so a prepared/approved finance change renders a specific card.

- [ ] **Step 1: Failing test**:

```ts
import { describe, expect, it } from 'vitest';
import { approvalTitle } from '@/lib/chat/change-titles';
it('titles finance changes specifically, not generically', () => {
  const title = approvalTitle('postInvoice', { id: 'inv-1' }, () => 'INV-001');
  expect(title.toLowerCase()).toContain('invoice');
  expect(title.toLowerCase()).not.toContain('make this change'); // the generic fallback
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the finance cases in `change-titles.ts`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `git add src/lib/chat/change-titles.ts tests/finance-change-titles.test.ts && git commit -m "feat(bendahara): approve-card titles for finance changes"`

## Task 6: `/api/finance/chat` route

**Files:** Create `src/app/api/finance/chat/route.ts`; Test `tests/finance-chat-route.test.ts`.

**Interfaces:** Mirror `src/app/api/crm/chat/route.ts`: `prepareChat`; `org = hasSupabaseEnv() ? getCurrentOrg(supabase) : null`; `finance = org ? { client: supabase, orgId: org.orgId, canWrite: org.role !== 'viewer' } : null`; if supabase env and no org, a 409 like `/api/people/chat`; call `runBendahara`; `toUIMessageStreamResponse` with a code-only error log.

- [ ] **Step 1: Failing test** `tests/finance-chat-route.test.ts` (mock `@/lib/ai/provider`, `@/lib/supabase/server`, `@/lib/auth/current-org`, `@/lib/auth/viewer` like `crm-chat-route.test.ts`): a writer org gets the write tools; a `viewer` org gets lookups only; 200 on a valid body.

```ts
it('gives a viewer lookups only', async () => {
  ctl.org = { orgId: 'org1', role: 'viewer' };
  const { POST } = await import('@/app/api/finance/chat/route');
  await (await POST(post(validBody))).text();
  expect(ctl.calls[0].tools).toContain('listInvoices');
  expect(ctl.calls[0].tools).not.toContain('postInvoice');
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the route (copy `crm/chat/route.ts`, swap `runKasturi`→`runBendahara`, label `[ask-bendahara]`).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `git add src/app/api/finance/chat/route.ts tests/finance-chat-route.test.ts && git commit -m "feat(bendahara): /api/finance/chat endpoint"`

## Task 7: Finance assistant screen

**Files:** Modify `src/screens/finance/assistant.tsx` (+ any small helper); if the finance assistant route isn't shared-screen-gated, confirm `src/config/live-screens.ts`.

**Interfaces:** Replace the static hero with the shared chat surface (mirror `src/screens/reach/assistant.tsx`): `isLiveChatAllowed` gate, `AskHero` pointed at `/api/finance/chat`, persona "Bendahara". Keep the existing page copy/branding; no purple.

- [ ] **Step 1:** Read `src/screens/reach/assistant.tsx` and `src/components/reach/ask-jebat-hero.tsx` for the exact wiring.
- [ ] **Step 2: Implement** the chat surface in `assistant.tsx`.
- [ ] **Step 3: Verify** `npx tsc --noEmit` + `pnpm lint` on the file; if a screen test exists for assistant screens, mirror it, else a light render assertion. Smoke the route set with `node scripts/smoke-routes.mjs` if quick.
- [ ] **Step 4: Commit** `git add src/screens/finance/assistant.tsx && git commit -m "feat(bendahara): make the finance assistant screen a live chat"`

### PR CUT — 1b-i
Run `pnpm test` (full suite green) + `npx tsc --noEmit` + `pnpm lint`. Then finishing-a-development-branch: PR `feat-127-ask-bendahara`, squash-merge (no Closes line — confirm `gh issue list` has no matching tracking issue). This ships a working **Ask-Bendahara**, not yet in Tuah.

---

## Task 8: Wire Bendahara into Tuah (new branch `feat-128-bendahara-into-tuah` off updated main)

**Files:** Modify `src/lib/ai/agents/orchestrator.ts`, `src/app/api/chat/route.ts`; Test `tests/tuah-tools.test.ts`, `tests/tuah-team.test.ts`.

**Interfaces:** `runTuah` gains a `finance?: FinanceAccess | null` param (10th positional, after `people`); products array gets `...(finance ? [financeProduct(finance)] : [])`; `TEAM_AREA.finance` string. Route builds `finance` org-gated like `crm` and passes it as the 10th arg.

- [ ] **Step 1: Failing test** — team roster includes `askBendahara` when finance passed; single-agent Tuah holds finance tools:

```ts
// tuah-team.test.ts
const finance = () => ({ client: {} as never, orgId: 'org1', canWrite: true });
it('adds Bendahara to the roster when finance is passed', async () => {
  seen.tuahTools = [];
  await runTuah(ask, reach(), undefined, undefined, null, crm(), team(), null, null, finance()).consumeStream();
  expect(seen.tuahTools[0]).toContain('askBendahara');
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the `runTuah` finance param + products entry + `TEAM_AREA.finance`, and the route's finance block + 10th arg. (The `hire-chat-route.test.ts` Tuah capture reads positional args — a 10th arg at `args[9]` does not shift the existing `args[6..8]` assertions; verify.)
- [ ] **Step 4: Run — expect PASS** (`tuah-tools`, `tuah-team`, `hire-chat-route`).
- [ ] **Step 5: Commit** `git add src/lib/ai/agents/orchestrator.ts src/app/api/chat/route.ts tests/tuah-tools.test.ts tests/tuah-team.test.ts && git commit -m "feat(bendahara): orchestrate Bendahara from Tuah"`

## Task 9: `SPECIALIST_RULES.finance`, `AREA.finance`, blind-spot removal

**Files:** Modify `src/lib/ai/agents/prompts.ts`, `src/lib/ai/agents/specialists.ts`; Test `tests/tuah-prompt.test.ts`, `tests/tuah-hire.test.ts`, `tests/bendahara-prompt.test.ts`.

**Interfaces:** `AREA.finance` (specialists), `SPECIALIST_RULES.finance` (sub-agent persona: finance scope, RM 2dp, lookup-before-id, owner-approval, SST/e-Invoice caution, injection guard); remove finance from `TUAH_SYSTEM`/`tuahSystem`/`tuahTeamSystem` blind spots and name finance among reachable products.

- [ ] **Step 1: Failing test** — Tuah no longer blind to finance; the sub-agent has finance rules:

```ts
// tuah-prompt.test.ts
it('no longer keeps finance in the blind spot', () => {
  expect(TUAH_SYSTEM.toLowerCase()).not.toContain("cannot see the workspace's finance yet");
  expect(TUAH_SYSTEM.toLowerCase()).toContain('finance');
});
// bendahara-prompt.test.ts
import { subAgentSystem } from '@/lib/ai/agents/prompts';
it('gives the finance sub-agent its rules', () => {
  expect(subAgentSystem('finance', true).toLowerCase()).toContain('bendahara');
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the prompt edits; update any now-stale finance blind-spot assertions in `tuah-hire.test.ts` (the `keeps only finance in the blind spot` test becomes "no blind spot left" — adjust to assert the whole workspace is now reachable).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `git add src/lib/ai/agents/prompts.ts src/lib/ai/agents/specialists.ts tests/tuah-prompt.test.ts tests/tuah-hire.test.ts tests/bendahara-prompt.test.ts && git commit -m "feat(bendahara): Tuah delegates finance to Bendahara; blind spot closed"`

### PR CUT — 1b-ii
Full suite green + tsc + lint. PR `feat-128-bendahara-into-tuah`, squash-merge. **Tuah now orchestrates all four products** — Phase 1 (parity) complete. Update the `standardise-products-to-jebat` memory.

---

## Self-Review notes
- Spec coverage: every spec deliverable step (1b-i 1-7, 1b-ii 8-12) maps to Tasks 1-9. `getFinanceOverview` in Task 1; change-titles in Task 5; UI in Task 7.
- Type consistency: `FinanceAccess` defined in Task 1 and used in Tasks 3/4/6/8; `FINANCE_WRITE_TOOL_NAMES` defined Task 2, used Task 3.
- Review Focus: collision (Task 3), viewer gating (Tasks 1/2/6), ok:false passthrough (Task 1), money units (Task 2), card titles (Task 5), blind spot (Task 9) — all have owning tests.
- Open at impl: confirm the exact id-input schema for refunds (`markRefundPaid`/`voidRefund`/`deleteRefund`) and whether `voidPaymentIn` vs `voidPayment` applies per payment direction — read the fn signatures when wiring Task 2.
