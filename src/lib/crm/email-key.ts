/**
 * A workspace's own email-provider key (Resend) and the sender it sends as.
 *
 * The key is sealed for the workspace before it is stored and is only ever
 * opened on the server, with the service-role client, for a workspace id the
 * caller has already resolved from the verified session. Nothing here logs a
 * key. Members may know that a key is set, its last four characters and the
 * sender address; nothing more.
 */
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptApiKey, encryptApiKey, hasKeySecret } from '@/lib/ai/key-crypto';

export const SENDER_NAME_MAX = 80;
export const SENDER_EMAIL_MAX = 254;

export const EMAIL_KEY_MESSAGES = {
  key: 'That does not look like a Resend API key. It should start with re_.',
  senderEmail: 'Enter the email address to send from, on a domain you have verified with Resend.',
  senderName: 'Enter the name recipients will see the email is from.',
  senderNameTooLong: `Keep the sender name to ${SENDER_NAME_MAX} characters or fewer.`,
  senderNameChars: 'The sender name cannot contain <, > or quotation marks.',
} as const;

const M = EMAIL_KEY_MESSAGES;

/** What members may know about the workspace's email key. */
export type EmailKeyStatus = { keyHint: string; senderEmail: string; senderName: string };

export type EmailSettings = { apiKey: string; senderEmail: string; senderName: string };

export type WorkspaceEmailKey =
  /** The workspace has not stored a key. */
  | { status: 'none' }
  | ({ status: 'ok' } & EmailSettings)
  /** A key is stored but this server cannot open it for this workspace. */
  | { status: 'unusable' }
  /** The stored key could not be read. */
  | { status: 'error' };

/** Resend keys look like `re_…`; a cheap check before any network call. */
export function isResendKeyShape(input: string): boolean {
  return /^re_[A-Za-z0-9_-]{16,200}$/.test(input.trim());
}

/** What we show back to people: never more than the last four characters. */
export function emailKeyHint(apiKey: string): string {
  return `re_…${apiKey.trim().slice(-4)}`;
}

/** A problem with what was typed, safe to show beside the form. */
export class EmailSettingsError extends Error {}

/** Validates the settings form. The same rules are checked again by the database. */
export function parseEmailSettings(formData: FormData): EmailSettings {
  const apiKey = String(formData.get('apiKey') ?? '').trim();
  const senderEmail = String(formData.get('senderEmail') ?? '').trim().toLowerCase();
  const senderName = String(formData.get('senderName') ?? '').replace(/\s+/g, ' ').trim();

  if (!isResendKeyShape(apiKey)) throw new EmailSettingsError(M.key);
  if (senderEmail.length > SENDER_EMAIL_MAX || !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(senderEmail)) {
    throw new EmailSettingsError(M.senderEmail);
  }
  if (!senderName) throw new EmailSettingsError(M.senderName);
  if (senderName.length > SENDER_NAME_MAX) throw new EmailSettingsError(M.senderNameTooLong);
  if (/[<>"]/.test(senderName)) throw new EmailSettingsError(M.senderNameChars);
  return { apiKey, senderEmail, senderName };
}

/** Seals a key for one workspace, as an email key and nothing else. */
export function sealEmailKey(apiKey: string, orgId: string): string {
  return encryptApiKey(apiKey, orgId, process.env, 'org-email-key');
}

/**
 * Whether the caller's workspace has an email key, read as the signed-in
 * member. Null when none is set (or the status could not be read).
 */
export async function getEmailKeyStatus(session: SupabaseClient): Promise<EmailKeyStatus | null> {
  const { data, error } = await session.rpc('org_email_key_status');
  if (error) {
    console.error('[email-key] status could not be read:', error.code);
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { key_hint: string | null; sender_email: string | null; sender_name: string | null }
    | null
    | undefined;
  if (!row?.key_hint || !row.sender_email || !row.sender_name) return null;
  return { keyHint: row.key_hint, senderEmail: row.sender_email, senderName: row.sender_name };
}

/**
 * `service` MUST be the service-role client and `orgId` MUST come from
 * server-side state. Only `ok` carries a key; callers treat `unusable` and
 * `error` as "this workspace has a key that cannot be used", never as "no key".
 */
export async function readEmailKey(service: SupabaseClient, orgId: string): Promise<WorkspaceEmailKey> {
  const { data, error } = await service
    .from('org_email_keys')
    .select('ciphertext,sender_email,sender_name')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) return { status: 'error' };

  const row = data as { ciphertext?: unknown; sender_email?: unknown; sender_name?: unknown } | null;
  if (!row || typeof row.ciphertext !== 'string' || !row.ciphertext) return { status: 'none' };

  const apiKey = hasKeySecret() ? decryptApiKey(row.ciphertext, orgId, process.env, 'org-email-key') : null;
  if (!apiKey || typeof row.sender_email !== 'string' || typeof row.sender_name !== 'string') {
    return { status: 'unusable' };
  }
  return { status: 'ok', apiKey, senderEmail: row.sender_email, senderName: row.sender_name };
}
