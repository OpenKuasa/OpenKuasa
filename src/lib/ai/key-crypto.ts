/**
 * Encryption for workspace OpenRouter keys (bring-your-own-key).
 *
 * Keys are sealed with AES-256-GCM under a server-only secret
 * (`AI_KEYS_ENCRYPTION_SECRET`) before they are stored, so what sits in the
 * database is useless without this server. Each sealed value is also bound to
 * the workspace it was sealed for: the workspace id is authenticated alongside
 * the key, so a value stored against any other workspace does not open.
 * Nothing here ever logs a key.
 *
 * The workspace id passed in must come from server-side state (the session's
 * current workspace, or the schedule/run row), never from client input.
 */

import 'server-only';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

type EnvLike = Record<string, string | undefined>;

/** Current format: `v2.<iv>.<tag>.<ciphertext>`, workspace id authenticated. */
const VERSION = 'v2';
/**
 * Earlier format, sealed without a workspace binding. It is only ever read,
 * never written: `readWorkspaceKey` re-seals a v1 value as v2 the first time
 * it opens, and the database refuses to store anything but v2.
 *
 * How long this stays: remove the v1 branch (and `isLegacySealed`) once
 * `select count(*) from org_ai_keys where ciphertext like 'v1.%'` is 0 in
 * production, and in any case at the first release after 2027-01-31. A
 * workspace still on v1 by then has not used chat or an agent since this
 * shipped; its owner saves the key again.
 */
const LEGACY_VERSION = 'v1';
const MIN_SECRET_LENGTH = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True when the server can seal and open workspace keys. */
export function hasKeySecret(env: EnvLike = process.env): boolean {
  return (env.AI_KEYS_ENCRYPTION_SECRET?.trim().length ?? 0) >= MIN_SECRET_LENGTH;
}

function secretKey(env: EnvLike): Buffer {
  const secret = env.AI_KEYS_ENCRYPTION_SECRET?.trim() ?? '';
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error('AI_KEYS_ENCRYPTION_SECRET is not set (32+ characters).');
  }
  return createHash('sha256').update(secret).digest();
}

/**
 * What a sealed value is for. It is authenticated with the value, so a key
 * sealed for one purpose does not open as another: a workspace's email key
 * can never be read back as its AI key, or the other way round.
 */
export type KeyPurpose = 'org-ai-key' | 'org-email-key';

/**
 * The bytes authenticated with a v2 key. An empty or malformed id would be no
 * binding at all, so anything that is not a uuid is refused.
 */
function workspaceBinding(orgId: string, purpose: KeyPurpose): Buffer {
  const id = typeof orgId === 'string' ? orgId.trim().toLowerCase() : '';
  if (!UUID.test(id)) throw new Error('A workspace id is required to seal or open a key.');
  return Buffer.from(`openkuasa:${purpose}:${VERSION}:${id}`, 'utf8');
}

/** Seals a key for one workspace as `v2.<iv>.<tag>.<ciphertext>` (base64url parts). */
export function encryptApiKey(
  apiKey: string,
  orgId: string,
  env: EnvLike = process.env,
  purpose: KeyPurpose = 'org-ai-key',
): string {
  const binding = workspaceBinding(orgId, purpose);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', secretKey(env), iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(binding);
  const sealed = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), sealed]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

/** True for a value in the earlier, unbound format, which should be sealed again. */
export function isLegacySealed(sealed: string): boolean {
  return sealed.startsWith(`${LEGACY_VERSION}.`);
}

/**
 * Opens a key sealed for `orgId`. Returns null if it is malformed, tampered
 * with, sealed under another secret, or sealed for another workspace.
 */
export function decryptApiKey(
  sealed: string,
  orgId: string,
  env: EnvLike = process.env,
  purpose: KeyPurpose = 'org-ai-key',
): string | null {
  const [version, iv, tag, data, ...rest] = sealed.split('.');
  if (rest.length > 0 || !iv || !tag || !data) return null;
  if (version !== VERSION && version !== LEGACY_VERSION) return null;
  // The earlier format carries no purpose, and only AI keys were ever sealed in it.
  if (version === LEGACY_VERSION && purpose !== 'org-ai-key') return null;
  try {
    // Required for both formats, so a caller without a workspace opens nothing.
    const binding = workspaceBinding(orgId, purpose);
    const ivBytes = Buffer.from(iv, 'base64url');
    const tagBytes = Buffer.from(tag, 'base64url');
    if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) return null;

    const decipher = createDecipheriv('aes-256-gcm', secretKey(env), ivBytes, {
      authTagLength: TAG_BYTES,
    });
    if (version === VERSION) decipher.setAAD(binding);
    decipher.setAuthTag(tagBytes);
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/** OpenRouter keys look like `sk-or-v1-…`; a cheap check before any network call. */
export function isOpenRouterKeyShape(input: string): boolean {
  return /^sk-or-[A-Za-z0-9_-]{16,300}$/.test(input.trim());
}

/** What we show back to people: never more than the last four characters. */
export function keyHint(apiKey: string): string {
  return `sk-or-…${apiKey.trim().slice(-4)}`;
}
