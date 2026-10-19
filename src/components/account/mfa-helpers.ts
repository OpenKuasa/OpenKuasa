import { z } from 'zod';

// Framework-free pieces of the two-factor setup, shared by the server actions
// and the card so they can be unit-tested without a session.

export const WRONG_CODE_ERROR =
  'That code is not right. Check your authenticator app and try again.';
export const RATE_LIMIT_ERROR =
  'Too many attempts. Wait a minute and try again.';
export const MFA_DEMO_ERROR =
  'Two-factor authentication is not available in the demo workspace. Sign up to use it.';

/** The six digits an authenticator app shows; spaces from pasting are dropped. */
export const totpCodeSchema = z
  .string()
  .transform((value) => value.replace(/\s/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your app.'));

export const factorIdSchema = z.uuid('This setup has expired. Start again.');

/** What `startMfaSetupAction` hands the card to draw the QR step. */
export type MfaSetup = { factorId: string; qrCode: string; secret: string };

export type MfaStartResult = { error: string } | MfaSetup;

/**
 * `enabled` says whether the authenticator ended up on, which can be true
 * alongside an `error` when the codes could not be stored.
 */
export type MfaCodesResult = {
  error?: string;
  enabled?: boolean;
  codes?: string[];
};

export type MfaResult = { error?: string; notice?: string };

type AuthErrorLike = { code?: string; status?: number; message?: string } | null;

/**
 * Turns a Supabase auth error from a challenge or verify call into a sentence
 * for the user. Raw messages are never passed through.
 */
export function mfaVerifyErrorMessage(
  error: AuthErrorLike,
  fallback = 'Could not check that code. Please try again.',
): string {
  if (!error) return fallback;
  if (error.status === 429 || error.code?.includes('rate_limit')) {
    return RATE_LIMIT_ERROR;
  }
  if (
    error.code === 'mfa_verification_failed' ||
    error.code === 'mfa_challenge_expired' ||
    error.code === 'mfa_verification_rejected' ||
    /invalid totp code|challenge.*expired/i.test(error.message ?? '')
  ) {
    return WRONG_CODE_ERROR;
  }
  return fallback;
}

/**
 * auth-js returns the QR as `data:image/svg+xml;utf-8,<raw svg>`. Raw markup
 * can contain `#`, which a URL reads as a fragment, so re-encode the payload.
 */
export function qrImageSrc(dataUri: string): string {
  const comma = dataUri.indexOf(',');
  if (!dataUri.startsWith('data:image/svg+xml') || comma === -1) return dataUri;
  const header = dataUri.slice(0, comma);
  const payload = dataUri.slice(comma + 1);
  if (header.includes(';base64')) return dataUri;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(payload)}`;
}

/** Splits the setup key into groups of four so it is easier to type. */
export function formatSecret(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret;
}

/** Contents of the downloaded recovery-codes text file. */
export function recoveryCodesFileText(codes: string[]): string {
  return [
    'OpenKuasa recovery codes',
    '',
    'Each code works once. If you lose your phone, a recovery code signs you',
    'in. Using one turns two-factor authentication off, so you will need to',
    'set it up again.',
    '',
    ...codes,
    '',
  ].join('\n');
}
