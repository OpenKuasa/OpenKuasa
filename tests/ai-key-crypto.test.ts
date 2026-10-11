import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  decryptApiKey,
  encryptApiKey,
  hasKeySecret,
  isLegacySealed,
  isOpenRouterKeyShape,
  keyHint,
} from '@/lib/ai/key-crypto';

const secret = 'a-server-only-secret-of-32-characters-or-more';
const env = { AI_KEYS_ENCRYPTION_SECRET: secret };
const key = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

/** The format production held before keys were bound to a workspace. */
function sealV1(apiKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  const data = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return ['v1', ...[iv, cipher.getAuthTag(), data].map((p) => p.toString('base64url'))].join('.');
}

/** Flips the first character, which always changes the decoded bytes. */
const tamper = (part: string) => (part.startsWith('A') ? 'B' : 'A') + part.slice(1);

test('a sealed key opens again for the same workspace under the same secret', () => {
  const sealed = encryptApiKey(key, ORG_A, env);
  expect(sealed).toMatch(/^v2\.[\w-]+\.[\w-]+\.[\w-]+$/);
  expect(sealed).not.toContain(key);
  expect(isLegacySealed(sealed)).toBe(false);
  expect(decryptApiKey(sealed, ORG_A, env)).toBe(key);
  // Workspace ids compare case-insensitively, as uuids do.
  expect(decryptApiKey(sealed, ORG_A.toUpperCase(), env)).toBe(key);
});

test('a key sealed for one workspace does not open for another', () => {
  const sealed = encryptApiKey(key, ORG_A, env);
  expect(decryptApiKey(sealed, ORG_B, env)).toBeNull();
});

test('a workspace id is required to seal or open', () => {
  expect(() => encryptApiKey(key, '', env)).toThrow();
  expect(() => encryptApiKey(key, 'not-a-workspace-id', env)).toThrow();
  const sealed = encryptApiKey(key, ORG_A, env);
  expect(decryptApiKey(sealed, '', env)).toBeNull();
  expect(decryptApiKey(sealed, 'not-a-workspace-id', env)).toBeNull();
  expect(decryptApiKey(sealV1(key), '', env)).toBeNull();
});

test('sealing the same key twice gives different ciphertext', () => {
  expect(encryptApiKey(key, ORG_A, env)).not.toBe(encryptApiKey(key, ORG_A, env));
});

test('a key in the earlier format still opens and is flagged for re-sealing', () => {
  const legacy = sealV1(key);
  expect(isLegacySealed(legacy)).toBe(true);
  expect(decryptApiKey(legacy, ORG_A, env)).toBe(key);
});

test('relabelling a bound key as the earlier format does not open it', () => {
  const sealed = encryptApiKey(key, ORG_A, env);
  const relabelled = sealed.replace(/^v2\./, 'v1.');
  expect(decryptApiKey(relabelled, ORG_A, env)).toBeNull();
  expect(decryptApiKey(relabelled, ORG_B, env)).toBeNull();
});

test('a sealed key does not open under another secret or after tampering', () => {
  const sealed = encryptApiKey(key, ORG_A, env);
  const other = { AI_KEYS_ENCRYPTION_SECRET: 'another-server-secret-of-32-characters-or-more' };
  expect(decryptApiKey(sealed, ORG_A, other)).toBeNull();

  const [version, iv, tag, data] = sealed.split('.');
  expect(decryptApiKey([version, iv, tag, tamper(data)].join('.'), ORG_A, env)).toBeNull();
  expect(decryptApiKey([version, iv, tamper(tag), data].join('.'), ORG_A, env)).toBeNull();
  expect(decryptApiKey('not-a-sealed-key', ORG_A, env)).toBeNull();
  expect(decryptApiKey(`v3.${iv}.${tag}.${data}`, ORG_A, env)).toBeNull();
});

test('a shortened authentication tag is refused in both formats', () => {
  for (const sealed of [encryptApiKey(key, ORG_A, env), sealV1(key)]) {
    const [version, iv, tag, data] = sealed.split('.');
    const short = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url');
    expect(decryptApiKey([version, iv, short, data].join('.'), ORG_A, env)).toBeNull();
  }
});

test('a missing or short secret means keys cannot be stored', () => {
  expect(hasKeySecret(env)).toBe(true);
  expect(hasKeySecret({})).toBe(false);
  expect(hasKeySecret({ AI_KEYS_ENCRYPTION_SECRET: 'too-short' })).toBe(false);
  expect(() => encryptApiKey(key, ORG_A, {})).toThrow();
  expect(decryptApiKey(encryptApiKey(key, ORG_A, env), ORG_A, {})).toBeNull();
});

test('recognises OpenRouter keys and only ever shows the last four characters', () => {
  expect(isOpenRouterKeyShape(key)).toBe(true);
  expect(isOpenRouterKeyShape(`  ${key}  `)).toBe(true);
  expect(isOpenRouterKeyShape('sk-ant-abcdefghijklmnopqrstuvwxyz')).toBe(false);
  expect(isOpenRouterKeyShape('sk-or-short')).toBe(false);
  expect(keyHint(key)).toBe('sk-or-…cdef');
});
