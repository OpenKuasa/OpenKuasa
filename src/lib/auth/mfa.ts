import { createHash, randomInt } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { safeAppPath } from '@/lib/security/safe-path';

/** Where a signed-in user with 2FA goes to enter their code. */
export const MFA_VERIFY_PATH = '/mfa/verify';
export const MFA_RECOVER_PATH = '/mfa/recover';

/** Only same-site paths may be used as a post-verification destination. */
export const safeNextPath = safeAppPath;

/** The code prompt, returning to `next` once the code is accepted. */
export function mfaVerifyHref(next?: string): string {
  const safe = safeNextPath(next);
  return safe
    ? `${MFA_VERIFY_PATH}?next=${encodeURIComponent(safe)}`
    : MFA_VERIFY_PATH;
}

export const RECOVERY_CODE_COUNT = 10;

// No 0/O/1/I/L, so a code survives being read aloud or written down.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUP = 5;

/** One code like `K7QMX-2HVBD`: ten symbols, about 49 bits. */
export function generateRecoveryCode(): string {
  const symbols = Array.from(
    { length: GROUP * 2 },
    () => ALPHABET[randomInt(ALPHABET.length)],
  ).join('');
  return `${symbols.slice(0, GROUP)}-${symbols.slice(GROUP)}`;
}

export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
}

/** Canonical form for hashing: uppercase, no spaces or dashes. */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Whether the input could be a recovery code at all (cheap pre-check). */
export function isRecoveryCodeShape(input: string): boolean {
  const code = normalizeRecoveryCode(input);
  return (
    code.length === GROUP * 2 && [...code].every((c) => ALPHABET.includes(c))
  );
}

/** SHA-256 hex of the normalised code; the only form the database stores. */
export function hashRecoveryCode(input: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(input)).digest('hex');
}

export type MfaFactor = { id: string; friendlyName: string | null };

export type MfaStatus = {
  /** The session has passed the second factor. */
  verified: boolean;
  /** A verified authenticator exists but this session has not used it yet. */
  challengeRequired: boolean;
  /** Authenticators that completed setup. */
  factors: MfaFactor[];
  /** Setups that were started but never confirmed; safe to discard. */
  pendingFactors: MfaFactor[];
};

/** Reads the session's assurance level and the user's TOTP factors. */
export async function getMfaStatus(supabase: SupabaseClient): Promise<MfaStatus> {
  const [{ data: aal }, { data: listed }] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    supabase.auth.mfa.listFactors(),
  ]);

  const all = listed?.all ?? [];
  const toFactor = (f: { id: string; friendly_name?: string | null }) => ({
    id: f.id,
    friendlyName: f.friendly_name ?? null,
  });
  const totp = all.filter((f) => f.factor_type === 'totp');

  return {
    verified: aal?.currentLevel === 'aal2',
    challengeRequired:
      aal?.currentLevel === 'aal1' && aal?.nextLevel === 'aal2',
    factors: totp.filter((f) => f.status === 'verified').map(toFactor),
    pendingFactors: totp.filter((f) => f.status !== 'verified').map(toFactor),
  };
}
