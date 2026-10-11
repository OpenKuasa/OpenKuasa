import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({
  user: null as { id: string; is_anonymous: boolean } | null,
  org: null as { orgId: string; role: string } | null,
  slug: 'acme' as string,
  linkedEmployee: null as { id: string; name?: string } | null,
  freeRemaining: 2 as number,
  sealedKey: null as string | null,
  providerKey: true,
  usedKeys: [] as (string | undefined)[],
  calls: [] as { system: string; tools: string[] }[],
  freeConsumed: 0,
  /** Tables the provider read, to prove which data the tools were given. */
  tablesRead: [] as string[],
  /** What the route handed to the runner. */
  captured: null as null | import('@/lib/ai/products').PeopleAccess,
  orgFails: false,
  orgLookups: 0,
  /** What the claim write path was given, and what the receipt upload was given. */
  submitted: [] as unknown[],
  uploaded: [] as { userId: string; bytes: string; mediaType: string }[],
}));

vi.mock('@/lib/people/pay-requests', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/people/pay-requests')>()),
  submitClaim: async (_ctx: unknown, input: unknown) => {
    ctl.submitted.push(input);
    return { ok: true as const, data: { id: 'c1', status: 'pending', has_receipt: true } };
  },
}));
vi.mock('@/lib/people/receipts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/people/receipts')>()),
  uploadReceipt: async (_client: unknown, userId: string, body: Buffer, mediaType: string) => {
    ctl.uploaded.push({ userId, bytes: body.toString(), mediaType });
    return { ok: true as const, data: { path: `${userId}/uploaded.png` } };
  },
}));

vi.mock('@/lib/ai/agents/orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/agents/orchestrator')>();
  return {
    ...actual,
    runLekiu: ((messages, people, ...rest) => {
      ctl.captured = people;
      return actual.runLekiu(messages, people, ...rest);
    }) as typeof actual.runLekiu,
  };
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: ctl.user }, error: null }) },
    rpc: async (name: string) => {
      if (name === 'org_ai_key_ciphertext') return { data: ctl.sealedKey, error: null };
      if (name === 'consume_free_question') {
        ctl.freeConsumed += 1;
        return { data: ctl.freeRemaining, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
    from: (table: string) => {
      ctl.tablesRead.push(table);
      const query = {
        select: () => query,
        eq: () => query,
        gte: () => query,
        lte: () => query,
        order: () => query,
        range: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({
          data: table === 'orgs' ? { slug: ctl.slug } : table === 'hr_employees' ? ctl.linkedEmployee : null,
          error: null,
        }),
      };
      return query;
    },
  }),
}));

vi.mock('@/lib/auth/current-org', () => ({ getCurrentOrg: async () => {
    ctl.orgLookups += 1;
    if (ctl.orgFails) throw new Error('secret db detail');
    return ctl.org;
  },
}));
vi.mock('@/lib/auth/viewer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/viewer')>()),
  hasSupabaseEnv: () => true,
}));

vi.mock('@/lib/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/provider')>();
  const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
  return {
    ...actual,
    hasProviderKey: () => ctl.providerKey,
    getModel: (_layer: string, apiKey?: string) => {
      ctl.usedKeys.push(apiKey);
      return new MockLanguageModelV4({
        doStream: async (options: {
          prompt: { role: string; content: unknown }[];
          tools?: { name: string }[];
        }) => {
          ctl.calls.push({
            system: String(options.prompt.find((m) => m.role === 'system')?.content ?? ''),
            tools: (options.tools ?? []).map((tool) => tool.name),
          });
          return {
            stream: simulateReadableStream({
              initialDelayInMs: 0,
              chunkDelayInMs: 0,
              chunks: [
                { type: 'text-start', id: '0' },
                { type: 'text-delta', id: '0', delta: 'Ada 3 orang cuti hari ini.' },
                { type: 'text-end', id: '0' },
                { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 12, totalTokens: 22 } },
              ],
            }),
          };
        },
      } as unknown as ConstructorParameters<typeof MockLanguageModelV4>[0]);
    },
  };
});

const SECRET = 'test-secret-for-sealing-workspace-keys-0123456789';
const { encryptApiKey } = await import('@/lib/ai/key-crypto');
const { PEOPLE_TOOL_NAMES } = await import('@/lib/ai/people-tools');
const { PEOPLE_WRITE_TOOL_NAMES } = await import('@/lib/ai/products');
const { POST } = await import('@/app/api/people/chat/route');
const { DEMO_ORG_SLUG } = await import('@/lib/people/types');

/** What a linked member holds besides the lookups: their own leave, and nothing that decides. */
const SELF_TOOLS = [
  'previewLeave', 'previewOvertime', 'applyLeave', 'applyTimeOff', 'cancelLeaveRequest', 'cancelTimeOffRequest',
  'submitClaim', 'cancelClaim', 'submitOvertime', 'cancelOvertime',
  'clockIn', 'clockOut', 'getMyAttendanceToday',
];
/** Anyone linked to an employee record holds these, an owner or admin included. */
const CLOCK_TOOLS = ['clockIn', 'clockOut', 'getMyAttendanceToday'];
/** What an owner or admin with no employee record holds: every change tool but the clock ones, and the settings lookup. */
const UNLINKED_OWNER_TOOLS = [
  ...PEOPLE_TOOL_NAMES, 'previewLeave', 'previewOvertime', 'getAttendanceSettings',
  ...PEOPLE_WRITE_TOOL_NAMES.filter((name) => name !== 'clockIn' && name !== 'clockOut'),
];

function post(body: unknown): Request {
  return new Request('http://localhost/api/people/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = {
  messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'siapa cuti hari ini?' }] }],
};

beforeEach(() => {
  ctl.user = { id: 'u1', is_anonymous: false };
  ctl.org = { orgId: 'org1', role: 'owner' };
  ctl.slug = 'acme';
  ctl.linkedEmployee = null;
  ctl.freeRemaining = 2;
  ctl.sealedKey = null;
  ctl.providerKey = true;
  ctl.usedKeys = [];
  ctl.calls = [];
  ctl.freeConsumed = 0;
  ctl.tablesRead = [];
  ctl.captured = null;
  ctl.orgFails = false;
  ctl.orgLookups = 0;
  ctl.submitted = [];
  ctl.uploaded = [];
  process.env.AI_KEYS_ENCRYPTION_SECRET = SECRET;
});

describe('POST /api/people/chat gating', () => {
  it('401 when not signed in', async () => {
    ctl.user = null;
    expect((await POST(post(validBody))).status).toBe(401);
  });

  it('403 for a demo / anonymous viewer, without calling a model', async () => {
    ctl.user = { id: 'u2', is_anonymous: true };
    expect((await POST(post(validBody))).status).toBe(403);
    expect(ctl.usedKeys).toEqual([]);
  });

  it('402 key_required when the free questions are used up', async () => {
    ctl.freeRemaining = -1;
    const res = await POST(post(validBody));
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'key_required' });
    expect(ctl.usedKeys).toEqual([]);
  });

  it('does not spend a free question on a malformed request', async () => {
    expect((await POST(post({ messages: [] }))).status).toBe(400);
    expect(ctl.freeConsumed).toBe(0);
  });

  it('fails closed when the workspace key cannot be opened on this server', async () => {
    ctl.sealedKey = encryptApiKey('sk-or-v1-workspace-key-aaaaaaaaaaaa');
    process.env.AI_KEYS_ENCRYPTION_SECRET = 'a-different-secret-than-the-one-used-to-seal-it';
    const res = await POST(post(validBody));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'key_unavailable' });
    expect(ctl.usedKeys).toEqual([]);
  });

  it('409 for someone in no workspace, without calling a model or reading HR data', async () => {
    ctl.org = null;
    const res = await POST(post(validBody));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'no_workspace' });
    expect(ctl.usedKeys).toEqual([]);
    expect(ctl.tablesRead.filter((table) => table.startsWith('hr_'))).toEqual([]);
  });

  it('503 data_unavailable when the workspace lookup throws, without calling a model', async () => {
    ctl.orgFails = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(post(validBody));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ code: 'data_unavailable' });
    expect(text).not.toContain('secret db detail');
    expect(ctl.usedKeys).toEqual([]);
    expect(spy).toHaveBeenCalledWith('[ask-lekiu] could not load the workspace:', 'secret db detail');
    spy.mockRestore();
  });
});

describe('POST /api/people/chat happy path', () => {
  it('answers as Lekiu, with the HR lookups and nothing else', async () => {
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('3 orang cuti');
    expect(ctl.freeConsumed).toBe(1);

    const [call] = ctl.calls;
    expect(call.system).toMatch(/^You are Lekiu/);
    expect(call.tools.sort()).toEqual([...UNLINKED_OWNER_TOOLS].sort());
    expect(call.tools).not.toContain('getCampaigns');
    expect(call.tools).not.toContain('listDeals');
    expect(call.tools).not.toContain('listJobs');

    // A user in a workspace reads the hr_ tables.
    await ctl.captured!.data.listEmployees();
    expect(ctl.tablesRead).toContain('hr_employees');
  });

  it('tells the tools an owner is HR', async () => {
    await (await POST(post(validBody))).text();
    expect(ctl.captured!.viewer).toEqual({ employeeId: null, isHr: true, isDemo: false });
  });

  it('tells the tools a member is not HR, and which employee they are', async () => {
    ctl.org = { orgId: 'org1', role: 'member' };
    ctl.linkedEmployee = { id: 'emp-7' };
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    await res.text();
    expect(ctl.captured!.viewer).toEqual({ employeeId: 'emp-7', isHr: false, isDemo: false });
    // Same lookups for everyone (the database limits what a member reads), plus their own leave tools.
    expect(ctl.calls[0].tools.sort()).toEqual([...PEOPLE_TOOL_NAMES, ...SELF_TOOLS].sort());
  });

  it('resolves the workspace exactly once', async () => {
    await (await POST(post(validBody))).text();
    expect(ctl.orgLookups).toBe(1);
  });

  it('ignores a workspace or viewer named in the request body', async () => {
    ctl.org = { orgId: 'org1', role: 'member' };
    const res = await POST(
      post({
        ...validBody,
        orgId: 'someone-elses-org',
        org_id: 'someone-elses-org',
        viewer: { employeeId: 'x', isHr: true, isDemo: true },
      }),
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(ctl.captured!.viewer).toEqual({ employeeId: null, isHr: false, isDemo: false });
  });

  it.each(['owner', 'admin'])('gives an %s the change tools, bound to their own workspace', async (role) => {
    ctl.org = { orgId: 'org1', role };
    await (await POST(post({ ...validBody, orgId: 'someone-elses-org' }))).text();
    for (const name of UNLINKED_OWNER_TOOLS) expect(ctl.calls[0].tools).toContain(name);
    expect(ctl.captured!.write?.tier).toBe('hr');
    expect(ctl.captured!.write?.ctx.orgId).toBe('org1');
  });

  it.each(['member', 'viewer'])('gives a %s the lookups only', async (role) => {
    ctl.org = { orgId: 'org1', role };
    await (await POST(post(validBody))).text();
    expect(ctl.captured!.write).toBeUndefined();
    expect(ctl.calls[0].tools.sort()).toEqual([...PEOPLE_TOOL_NAMES].sort());
    for (const name of ctl.calls[0].tools) expect(name).toMatch(/^(get|list)/);
  });

  it.each(['member', 'viewer'])('gives a linked %s their own leave tools, bound to their own employee record', async (role) => {
    ctl.org = { orgId: 'org1', role };
    ctl.linkedEmployee = { id: 'emp-7' };
    await (await POST(post({ ...validBody, employeeId: 'emp-9', employee_id: 'emp-9' }))).text();
    expect(ctl.captured!.write).toMatchObject({ tier: 'self', employeeId: 'emp-7' });
    expect(ctl.captured!.write?.ctx.orgId).toBe('org1');
    expect(ctl.calls[0].tools.sort()).toEqual([...PEOPLE_TOOL_NAMES, ...SELF_TOOLS].sort());
    for (const name of ['decideLeave', 'decideTimeOff', 'setLeaveEntitlement', 'createEmployee', 'deleteDepartment', 'decideClaim', 'decideOvertime', 'markClaimPaid', 'unmarkClaimPaid']) {
      expect(ctl.calls[0].tools).not.toContain(name);
    }
    // Linked, so the clock tools are theirs; never the owner tools for corrections, holidays and settings.
    for (const name of CLOCK_TOOLS) expect(ctl.calls[0].tools).toContain(name);
    for (const name of ['correctAttendance', 'saveHoliday', 'removeHoliday', 'saveAttendanceSettings', 'getAttendanceSettings']) {
      expect(ctl.calls[0].tools).not.toContain(name);
    }
  });

  it('gives a member in the demo workspace the lookups only, even with a linked record', async () => {
    ctl.org = { orgId: 'org1', role: 'member' };
    ctl.slug = DEMO_ORG_SLUG;
    ctl.linkedEmployee = { id: 'emp-7' };
    await (await POST(post(validBody))).text();
    expect(ctl.captured!.write).toBeUndefined();
    expect(ctl.calls[0].tools.sort()).toEqual([...PEOPLE_TOOL_NAMES].sort());
  });

  it.each(['owner', 'admin', 'member'])('gives a %s in the demo workspace the lookups only, which the database keeps read-only', async (role) => {
    ctl.org = { orgId: 'org1', role };
    ctl.slug = DEMO_ORG_SLUG;
    await (await POST(post(validBody))).text();
    expect(ctl.captured!.write).toBeUndefined();
    expect(ctl.calls[0].tools.sort()).toEqual([...PEOPLE_TOOL_NAMES].sort());
  });

  it('gives an owner who is also an employee the hr tier, and their own employee id', async () => {
    ctl.org = { orgId: 'org1', role: 'owner' };
    ctl.linkedEmployee = { id: 'emp-3' };
    await (await POST(post(validBody))).text();
    expect(ctl.captured!.write).toMatchObject({ tier: 'hr', employeeId: 'emp-3' });
    // Their own record is linked, so they hold the clock tools too, for that record.
    for (const name of CLOCK_TOOLS) expect(ctl.calls[0].tools).toContain(name);
  });

  it('gives an owner with no employee record the owner tools but no clock tool', async () => {
    ctl.org = { orgId: 'org1', role: 'owner' };
    await (await POST(post(validBody))).text();
    for (const name of CLOCK_TOOLS) expect(ctl.calls[0].tools).not.toContain(name);
    for (const name of ['correctAttendance', 'saveHoliday', 'removeHoliday', 'saveAttendanceSettings', 'getAttendanceSettings']) {
      expect(ctl.calls[0].tools).toContain(name);
    }
  });

  it('tells the tools the name of the employee who is asking', async () => {
    ctl.org = { orgId: 'org1', role: 'member' };
    ctl.linkedEmployee = { id: 'emp-7', name: 'Farah Idris' };
    await (await POST(post(validBody))).text();
    expect(ctl.captured!.viewer).toEqual({ employeeId: 'emp-7', isHr: false, isDemo: false, employeeName: 'Farah Idris' });
  });

  it('runs on the workspace key without touching the free allowance', async () => {
    ctl.sealedKey = encryptApiKey('sk-or-v1-workspace-key-aaaaaaaaaaaa');
    ctl.freeRemaining = -1;
    ctl.providerKey = false;
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    await res.text();
    expect(ctl.freeConsumed).toBe(0);
    expect(ctl.usedKeys).toEqual(['sk-or-v1-workspace-key-aaaaaaaaaaaa']);
  });
});

describe('POST /api/people/chat claims and overtime', () => {
  const MEMBER_PAY = ['previewOvertime', 'submitClaim', 'submitOvertime', 'cancelClaim', 'cancelOvertime'];
  const DECIDING = ['decideClaim', 'decideOvertime', 'markClaimPaid', 'unmarkClaimPaid'];
  const toolsOf = async (body: unknown = validBody) => {
    await (await POST(post(body))).text();
    return ctl.calls[0].tools;
  };

  it.each(['owner', 'admin'])('gives an %s every claim and overtime tool, deciding and paid marks included', async (role) => {
    ctl.org = { orgId: 'org1', role };
    const held = await toolsOf();
    for (const name of [...MEMBER_PAY, ...DECIDING]) expect(held, name).toContain(name);
  });

  it.each(['member', 'viewer'])('gives a linked %s the submit and cancel tools for themselves, and nothing that decides', async (role) => {
    ctl.org = { orgId: 'org1', role };
    ctl.linkedEmployee = { id: 'emp-7' };
    const held = await toolsOf();
    for (const name of MEMBER_PAY) expect(held, name).toContain(name);
    for (const name of DECIDING) expect(held, name).not.toContain(name);
  });

  it('gives an unlinked member none of them', async () => {
    ctl.org = { orgId: 'org1', role: 'member' };
    const held = await toolsOf();
    for (const name of [...MEMBER_PAY, ...DECIDING]) expect(held, name).not.toContain(name);
  });

  it.each(['owner', 'member'])('gives a %s in the demo workspace none of them', async (role) => {
    ctl.org = { orgId: 'org1', role };
    ctl.slug = DEMO_ORG_SLUG;
    ctl.linkedEmployee = { id: 'emp-7' };
    const held = await toolsOf();
    for (const name of [...MEMBER_PAY, ...DECIDING]) expect(held, name).not.toContain(name);
  });

  const PHOTO = 'data:image/png;base64,' + Buffer.from('the photo').toString('base64');
  const question = {
    id: 'm1',
    role: 'user',
    parts: [
      { type: 'text', text: 'tuntut teksi RM 85' },
      { type: 'file', mediaType: 'image/png', url: PHOTO, filename: 'receipt.png' },
    ],
  };

  it('hands the tools the photo on the newest question, bound to the signed-in user', async () => {
    ctl.org = { orgId: 'org1', role: 'member' };
    ctl.linkedEmployee = { id: 'emp-7' };
    await (await POST(post({ messages: [question] }))).text();
    const write = ctl.captured!.write!;
    expect(write.userId).toBe('u1');
    expect(write.receipt?.mediaType).toBe('image/png');
    expect(write.receipt?.bytes.toString()).toBe('the photo');
  });

  it('hands the tools no receipt when the newest question has no file, and none from the request body', async () => {
    ctl.org = { orgId: 'org1', role: 'owner' };
    await (await POST(post({ ...validBody, receipt: { bytes: 'x', mediaType: 'image/png' }, receipt_path: 'u/x.png' }))).text();
    expect(ctl.captured!.write!.receipt).toBeNull();
  });

  it('still has the receipt when the approval is answered in a later request, and attaches it', async () => {
    ctl.org = { orgId: 'org1', role: 'member' };
    ctl.linkedEmployee = { id: 'emp-7' };
    const input = { category: 'travel', amount_cents: 8500, claim_date: '2026-10-09', description: 'Teksi' };
    const card = (state: 'approval-requested' | 'approval-responded') => ({
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-submitClaim',
          toolCallId: 't1',
          state,
          input,
          approval: state === 'approval-responded' ? { id: 'ap1', approved: true } : { id: 'ap1' },
        },
      ],
    });
    // The first request proposes the claim: nothing is saved while the card waits.
    await (await POST(post({ messages: [question, card('approval-requested')] }))).text();
    expect(ctl.captured!.write!.receipt?.bytes.toString()).toBe('the photo');
    expect(ctl.submitted).toEqual([]);
    // The second request carries the answer. The newest user message is still the question with the photo.
    ctl.captured = null;
    await (await POST(post({ messages: [question, card('approval-responded')] }))).text();
    expect(ctl.captured!.write!.receipt?.bytes.toString()).toBe('the photo');
    expect(ctl.uploaded).toEqual([{ userId: 'u1', bytes: 'the photo', mediaType: 'image/png' }]);
    expect(ctl.submitted).toEqual([
      expect.objectContaining({ employee_id: 'emp-7', amount_cents: 8500, receipt_path: 'u1/uploaded.png' }),
    ]);
  });

  it('keeps a claim’s receipt as the file on ITS question: a newer question with another file, or none, is not picked up', async () => {
    ctl.org = { orgId: 'org1', role: 'member' };
    ctl.linkedEmployee = { id: 'emp-7' };
    const input = { category: 'travel', amount_cents: 8500, claim_date: '2026-10-09' };
    const waiting = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'tool-submitClaim', toolCallId: 't1', state: 'approval-requested', input, approval: { id: 'ap1' } }],
    };
    const newerWithFile = {
      id: 'm2',
      role: 'user',
      parts: [
        { type: 'text', text: 'dan satu lagi' },
        { type: 'file', mediaType: 'application/pdf', url: 'data:application/pdf;base64,' + Buffer.from('newer file').toString('base64') },
      ],
    };
    await (await POST(post({ messages: [question, waiting, newerWithFile] }))).text();
    expect(ctl.captured!.write!.receipt?.bytes.toString()).toBe('the photo');
    expect(ctl.captured!.write!.receipt?.mediaType).toBe('image/png');
    ctl.captured = null;
    await (await POST(post({ messages: [question, waiting, { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'hello' }] }] }))).text();
    expect(ctl.captured!.write!.receipt?.bytes.toString()).toBe('the photo');
    // And a claim whose own question had no file never takes a newer question's file.
    ctl.captured = null;
    const plain = { id: 'm0', role: 'user', parts: [{ type: 'text', text: 'tuntut teksi' }] };
    await (await POST(post({ messages: [plain, waiting, newerWithFile] }))).text();
    expect(ctl.captured!.write!.receipt).toBeNull();
  });
});

describe('POST /api/people/chat payroll tools', () => {
  const PAYROLL_TOOLS = ['runPayroll', 'recalculatePayroll', 'savePayslipLine', 'removePayslipLine', 'setPayslipStatutory', 'removePayslip'];
  const held = async () => {
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    await res.text();
    return ctl.calls[0].tools;
  };

  it.each(['owner', 'admin'])('gives an %s all six, linked to an employee record or not', async (role) => {
    ctl.org = { orgId: 'org1', role };
    for (const linked of [null, { id: 'emp-3' }]) {
      ctl.calls = [];
      ctl.linkedEmployee = linked;
      const tools = await held();
      for (const name of PAYROLL_TOOLS) expect(tools, name).toContain(name);
    }
  });

  it.each(['member', 'viewer'])('gives a %s none, linked to an employee record or not: absent, not disabled', async (role) => {
    ctl.org = { orgId: 'org1', role };
    for (const linked of [null, { id: 'emp-7' }]) {
      ctl.calls = [];
      ctl.linkedEmployee = linked;
      const tools = await held();
      for (const name of PAYROLL_TOOLS) expect(tools, name).not.toContain(name);
    }
  });

  it.each(['owner', 'admin', 'member', 'viewer'])('gives a %s in the demo workspace none, linked or not', async (role) => {
    ctl.org = { orgId: 'org1', role };
    ctl.slug = DEMO_ORG_SLUG;
    for (const linked of [null, { id: 'emp-7' }]) {
      ctl.calls = [];
      ctl.linkedEmployee = linked;
      const tools = await held();
      for (const name of PAYROLL_TOOLS) expect(tools, name).not.toContain(name);
    }
  });

  it('gives nobody a tool for marking a run paid, undoing paid, reopening or deleting a draft', async () => {
    ctl.org = { orgId: 'org1', role: 'owner' };
    ctl.linkedEmployee = { id: 'emp-3' };
    const tools = await held();
    for (const name of tools) {
      if (/payroll|payslip|run/i.test(name)) expect(name, name).not.toMatch(/paid|reopen|undo|delete/i);
    }
    expect(tools.filter((name: string) => /payroll|payslip/i.test(name)).sort()).toEqual(
      [...PAYROLL_TOOLS, 'getPayrollSummary', 'listPayslips'].sort(),
    );
  });

  it('every payroll change tool is on the list of tools that wait for approval', () => {
    for (const name of PAYROLL_TOOLS) expect(PEOPLE_WRITE_TOOL_NAMES).toContain(name);
  });

  it('sends the model the payroll rules and no longer says payroll cannot be run', async () => {
    ctl.org = { orgId: 'org1', role: 'owner' };
    await held();
    expect(ctl.calls[0].system).toContain('\nPAYROLL\n');
    expect(ctl.calls[0].system).not.toContain('You cannot run payroll');
  });
});
