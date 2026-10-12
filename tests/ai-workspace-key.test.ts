import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptApiKey, encryptApiKey } from '@/lib/ai/key-crypto';
import { readWorkspaceKey } from '@/lib/ai/workspace-key';

const secret = 'a-server-only-secret-of-32-characters-or-more';
const key = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function sealV1(apiKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  const data = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return ['v1', ...[iv, cipher.getAuthTag(), data].map((p) => p.toString('base64url'))].join('.');
}

type Update = { patch: Record<string, unknown>; eqs: [string, unknown][] };

/** A stand-in for the service client holding each workspace's stored key. */
function fakeService(opts: {
  rows: Record<string, string>;
  readError?: boolean;
  writeError?: boolean;
}) {
  const reads: [string, unknown][][] = [];
  const updates: Update[] = [];
  const client = {
    from(table: string) {
      if (table !== 'org_ai_keys') throw new Error(`unexpected table ${table}`);
      return {
        select() {
          const eqs: [string, unknown][] = [];
          const b = {
            eq(c: string, v: unknown) {
              eqs.push([c, v]);
              return b;
            },
            maybeSingle: async () => {
              reads.push(eqs);
              if (opts.readError) return { data: null, error: { message: 'boom' } };
              const org = eqs.find(([c]) => c === 'org_id')?.[1] as string;
              const ciphertext = opts.rows[org];
              return { data: ciphertext ? { ciphertext } : null, error: null };
            },
          };
          return b;
        },
        update(patch: Record<string, unknown>) {
          const eqs: [string, unknown][] = [];
          const b = {
            eq(c: string, v: unknown) {
              eqs.push([c, v]);
              return b;
            },
            then(resolve: (v: { error: { message: string } | null }) => void) {
              updates.push({ patch, eqs });
              if (opts.writeError) return resolve({ error: { message: 'permission denied' } });
              const org = eqs.find(([c]) => c === 'org_id')?.[1] as string;
              const expected = eqs.find(([c]) => c === 'ciphertext')?.[1];
              if (opts.rows[org] === expected) opts.rows[org] = patch.ciphertext as string;
              resolve({ error: null });
            },
          };
          return b;
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, reads, updates };
}

beforeEach(() => {
  vi.stubEnv('AI_KEYS_ENCRYPTION_SECRET', secret);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test('a workspace without a stored key has none', async () => {
  const { client, reads, updates } = fakeService({ rows: {} });
  expect(await readWorkspaceKey(client, ORG_A)).toEqual({ status: 'none' });
  expect(reads[0]).toContainEqual(['org_id', ORG_A]);
  expect(updates).toHaveLength(0);
});

test('a key sealed for the workspace opens and is left as stored', async () => {
  const { client, updates } = fakeService({ rows: { [ORG_A]: encryptApiKey(key, ORG_A) } });
  expect(await readWorkspaceKey(client, ORG_A)).toEqual({ status: 'ok', apiKey: key });
  expect(updates).toHaveLength(0);
});

test('a key sealed for another workspace is unusable', async () => {
  const { client, updates } = fakeService({ rows: { [ORG_B]: encryptApiKey(key, ORG_A) } });
  expect(await readWorkspaceKey(client, ORG_B)).toEqual({ status: 'unusable' });
  expect(updates).toHaveLength(0);
});

test('a key in the earlier format opens once and is stored again bound to its workspace', async () => {
  const legacy = sealV1(key);
  const rows = { [ORG_A]: legacy };
  const { client, updates } = fakeService({ rows });

  expect(await readWorkspaceKey(client, ORG_A)).toEqual({ status: 'ok', apiKey: key });

  expect(updates).toHaveLength(1);
  // Only the row that still holds the value that was read is replaced.
  expect(updates[0].eqs).toContainEqual(['org_id', ORG_A]);
  expect(updates[0].eqs).toContainEqual(['ciphertext', legacy]);
  expect(Object.keys(updates[0].patch)).toEqual(['ciphertext']);
  expect(rows[ORG_A]).toMatch(/^v2\./);
  expect(decryptApiKey(rows[ORG_A], ORG_A)).toBe(key);
  expect(decryptApiKey(rows[ORG_A], ORG_B)).toBeNull();

  // The next read finds the bound value and writes nothing.
  expect(await readWorkspaceKey(client, ORG_A)).toEqual({ status: 'ok', apiKey: key });
  expect(updates).toHaveLength(1);
});

test('the key is still usable when storing it again fails', async () => {
  const legacy = sealV1(key);
  const rows = { [ORG_A]: legacy };
  const { client, updates } = fakeService({ rows, writeError: true });
  expect(await readWorkspaceKey(client, ORG_A)).toEqual({ status: 'ok', apiKey: key });
  expect(updates).toHaveLength(1);
  expect(rows[ORG_A]).toBe(legacy);
});

test('a failed read, a missing secret or a missing workspace id never yields a key', async () => {
  const sealed = encryptApiKey(key, ORG_A);
  expect(await readWorkspaceKey(fakeService({ rows: {}, readError: true }).client, ORG_A)).toEqual({
    status: 'error',
  });
  expect(await readWorkspaceKey(fakeService({ rows: { '': sealed } }).client, '')).toEqual({
    status: 'unusable',
  });
  vi.stubEnv('AI_KEYS_ENCRYPTION_SECRET', '');
  expect(await readWorkspaceKey(fakeService({ rows: { [ORG_A]: sealed } }).client, ORG_A)).toEqual({
    status: 'unusable',
  });
});

test('nothing about the key is logged when storing it again fails', async () => {
  const legacy = sealV1(key);
  const { client } = fakeService({ rows: { [ORG_A]: legacy }, writeError: true });
  await readWorkspaceKey(client, ORG_A);
  const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
  expect(logged).not.toContain(key);
  expect(logged).not.toContain(legacy);
});
