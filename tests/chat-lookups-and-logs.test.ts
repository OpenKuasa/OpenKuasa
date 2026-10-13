import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { errorCodeOf } from '@/lib/ai/call-log';

const calls = vi.hoisted(() => ({ ensured: 0, listed: 0, pipelines: [] as unknown[] }));

vi.mock('@/lib/crm/pipelines', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crm/pipelines')>();
  return {
    ...actual,
    listCrmPipelines: async () => {
      calls.listed += 1;
      return calls.pipelines;
    },
    ensureDefaultPipeline: async () => {
      calls.ensured += 1;
    },
  };
});

const { createCrmTools, ensureCrmPipeline } = await import('@/lib/ai/crm-tools');

/** A client that fails the test the moment anything is written through it. */
const readOnlyClient = () => {
  const refuse = (what: string) => () => {
    throw new Error(`a lookup tried to ${what}`);
  };
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'or', 'ilike', 'order', 'limit', 'range', 'gte', 'lte', 'is', 'not']) {
    query[method] = () => query;
  }
  query.maybeSingle = async () => ({ data: null, error: null });
  query.single = async () => ({ data: null, error: null });
  query.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: 0 });
  for (const write of ['insert', 'update', 'upsert', 'delete']) query[write] = refuse(write);
  return { from: () => query, rpc: refuse('call a function') };
};

describe('CRM lookups', () => {
  it('listPipelines reads and nothing more, in a workspace that has no pipeline yet', async () => {
    calls.ensured = 0;
    calls.pipelines = [];
    const tools = createCrmTools({ client: readOnlyClient() as never, orgId: 'org1', userId: 'u1', canWrite: true });
    const run = (tools.listPipelines as unknown as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute;
    await run({}, { toolCallId: 't1', messages: [] });
    expect(calls.listed).toBeGreaterThan(0);
    expect(calls.ensured).toBe(0);
  });

  it('the starting pipeline is set up by the route step, once, and only when there is none', async () => {
    calls.ensured = 0;
    calls.pipelines = [];
    await ensureCrmPipeline({} as never, 'org1');
    expect(calls.ensured).toBe(1);
    calls.pipelines = [{ id: 'p1', name: 'Sales', stages: [{ id: 's1', name: 'New' }] }];
    await ensureCrmPipeline({} as never, 'org1');
    expect(calls.ensured).toBe(1);
  });
});

describe('what a failed read or write leaves in the log', () => {
  it('is a code, never the message or the details', () => {
    const dbError = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "crm_contacts_email_key"',
      details: 'Key (email)=(aina@example.com) already exists.',
    };
    expect(errorCodeOf(dbError)).toBe('23505');
    expect(errorCodeOf(new TypeError('Cannot read aina@example.com'))).toBe('TypeError');
    expect(errorCodeOf({ statusCode: 413, message: 'payslip.pdf is too large' })).toBe('413');
    expect(errorCodeOf('aina@example.com')).toBe('unknown');
    expect(errorCodeOf(null)).toBe('unknown');
  });

  // The chat routes and the files their tools run through. A line here that logs an error object, or its message,
  // can put a prompt, a contact's details or a file into the server log.
  const ROOT = join(__dirname, '..', 'src');
  const FILES = [
    ...['chat', 'crm/chat', 'hire/chat', 'people/chat', 'reach/chat'].map((dir) => `app/api/${dir}/route.ts`),
    ...readdirSync(join(ROOT, 'lib/ai')).filter((f) => f.endsWith('.ts')).map((f) => `lib/ai/${f}`),
    ...readdirSync(join(ROOT, 'lib/ai/agents')).filter((f) => f.endsWith('.ts')).map((f) => `lib/ai/agents/${f}`),
    ...readdirSync(join(ROOT, 'lib/chat')).filter((f) => f.endsWith('.ts')).map((f) => `lib/chat/${f}`),
    'lib/reach/capabilities.ts',
    'lib/hire/capabilities.ts',
    'lib/agents/apply-proposal.ts',
  ];
  // A helper call, a plain string, or a template is fine; a bare identifier or `.message` is the error itself.
  const RAW = /console\.(error|warn|log)\([^)]*,\s*(error|err|e|[a-zA-Z]*Err(or)?)(\s*\)|\s*instanceof Error \? \2\.message|\??\.message)/;
  // Messages written by this project's own database functions and the provider's key check, which quote no user data.
  const KNOWN = new Set(['lib/ai/gate.ts', 'lib/ai/rate-limit.ts', 'lib/ai/workspace-key.ts']);

  it.each(FILES.filter((f) => !KNOWN.has(f)))('%s logs no error object and no error message', (file) => {
    const offenders = readFileSync(join(ROOT, file), 'utf8')
      .split('\n')
      .map((line, i) => ({ line: line.trim(), at: i + 1 }))
      .filter(({ line }) => RAW.test(line));
    expect(offenders).toEqual([]);
  });
});
