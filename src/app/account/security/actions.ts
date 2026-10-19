'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { getViewer } from '@/lib/auth/viewer';
import {
  generateRecoveryCodes,
  getMfaStatus,
  hashRecoveryCode,
} from '@/lib/auth/mfa';
import { recordEvent } from '@/lib/events';
import {
  MFA_DEMO_ERROR,
  factorIdSchema,
  mfaVerifyErrorMessage,
  qrImageSrc,
  totpCodeSchema,
  type MfaCodesResult,
  type MfaResult,
  type MfaStartResult,
} from '@/components/account/mfa-helpers';

const SECURITY_PATH = '/account/security';

const confirmSchema = z.object({ factorId: factorIdSchema, code: totpCodeSchema });
const codeOnlySchema = z.object({ code: totpCodeSchema });
const cancelSchema = z.object({ factorId: factorIdSchema });

/**
 * Stores a fresh set of recovery codes and returns the plaintext, which exists
 * nowhere else. The database only accepts this from a session that has passed
 * the second factor.
 */
async function issueRecoveryCodes(
  supabase: SupabaseClient,
): Promise<string[] | null> {
  const codes = generateRecoveryCodes();
  const { error } = await supabase.rpc('replace_recovery_codes', {
    p_hashes: codes.map(hashRecoveryCode),
  });
  if (error) {
    console.error('replace_recovery_codes failed:', error.message);
    return null;
  }
  return codes;
}

export async function startMfaSetupAction(): Promise<MfaStartResult> {
  const viewer = await getViewer();
  if (viewer.isDemo) return { error: MFA_DEMO_ERROR };

  const supabase = await createClient();
  const status = await getMfaStatus(supabase);
  if (status.factors.length) {
    revalidatePath(SECURITY_PATH);
    return { error: 'Two-factor authentication is already on.' };
  }

  // Abandoned setups count towards the factor limit, so clear them first.
  for (const factor of status.pendingFactors) {
    await supabase.auth.mfa.unenroll({ factorId: factor.id });
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    issuer: 'OpenKuasa',
    // Reusing a name fails, even for a factor that was never confirmed.
    friendlyName: `Authenticator ${new Date().toISOString()}`,
  });
  if (error || !data?.totp) {
    return { error: 'Could not start setup. Please try again.' };
  }

  return {
    factorId: data.id,
    qrCode: qrImageSrc(data.totp.qr_code),
    secret: data.totp.secret,
  };
}

export async function confirmMfaSetupAction(
  input: unknown,
): Promise<MfaCodesResult> {
  const viewer = await getViewer();
  if (viewer.isDemo) return { error: MFA_DEMO_ERROR };

  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { factorId, code } = parsed.data;

  const supabase = await createClient();
  const status = await getMfaStatus(supabase);
  if (!status.pendingFactors.some((f) => f.id === factorId)) {
    return { error: 'This setup has expired. Start again.' };
  }

  // A successful verify also lifts this session to the second-factor level.
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code,
  });
  if (error) return { error: mfaVerifyErrorMessage(error) };

  const codes = await issueRecoveryCodes(supabase);

  await recordEvent(supabase, {
    action: 'Turned on two-factor authentication',
    category: 'security',
    notify: {
      to: 'self',
      event: 'security',
      title: 'Two-factor authentication is on',
      body: 'You will be asked for a code from your authenticator app when you sign in.',
      href: SECURITY_PATH,
    },
  });
  revalidatePath(SECURITY_PATH);

  if (!codes) {
    return {
      enabled: true,
      error:
        'Two-factor authentication is on, but your recovery codes could not be saved. Regenerate them now so you are not locked out if you lose your phone.',
    };
  }
  return { enabled: true, codes };
}

/** Discards a setup the user backed out of. Never touches a confirmed factor. */
export async function cancelMfaSetupAction(input: unknown): Promise<MfaResult> {
  const viewer = await getViewer();
  if (viewer.isDemo) return { error: MFA_DEMO_ERROR };

  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return {};

  const supabase = await createClient();
  const status = await getMfaStatus(supabase);
  if (status.pendingFactors.some((f) => f.id === parsed.data.factorId)) {
    // Best effort: a leftover is cleared the next time setup starts.
    await supabase.auth.mfa.unenroll({ factorId: parsed.data.factorId });
  }
  return {};
}

export async function regenerateRecoveryCodesAction(
  input: unknown,
): Promise<MfaCodesResult> {
  const viewer = await getViewer();
  if (viewer.isDemo) return { error: MFA_DEMO_ERROR };

  const parsed = codeOnlySchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const status = await getMfaStatus(supabase);
  const factor = status.factors[0];
  if (!factor) {
    revalidatePath(SECURITY_PATH);
    return { error: 'Two-factor authentication is off.' };
  }

  // New codes can sign someone in, so ask for the authenticator again rather
  // than trusting a session that may have been left open.
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId: factor.id,
    code: parsed.data.code,
  });
  if (error) return { error: mfaVerifyErrorMessage(error) };

  const codes = await issueRecoveryCodes(supabase);
  if (!codes) {
    return {
      enabled: true,
      error: 'Could not save new recovery codes. Please try again.',
    };
  }

  await recordEvent(supabase, {
    action: 'Regenerated recovery codes',
    category: 'security',
  });
  revalidatePath(SECURITY_PATH);
  return { enabled: true, codes };
}

export async function disableMfaAction(input: unknown): Promise<MfaResult> {
  const viewer = await getViewer();
  if (viewer.isDemo) return { error: MFA_DEMO_ERROR };

  const parsed = codeOnlySchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const supabase = await createClient();
  const status = await getMfaStatus(supabase);
  const factor = status.factors[0];
  if (!factor) {
    revalidatePath(SECURITY_PATH);
    return { notice: 'Two-factor authentication is already off.' };
  }

  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId: factor.id,
    code: parsed.data.code,
  });
  if (error) return { error: mfaVerifyErrorMessage(error) };

  // Confirmed factors first: if one fails to go, 2FA is still on and the
  // recovery codes must stay.
  for (const { id } of status.factors) {
    const { error: unenrollErr } = await supabase.auth.mfa.unenroll({
      factorId: id,
    });
    if (unenrollErr) {
      revalidatePath(SECURITY_PATH);
      return {
        error:
          'Could not turn off two-factor authentication. Please try again.',
      };
    }
  }
  for (const { id } of status.pendingFactors) {
    await supabase.auth.mfa.unenroll({ factorId: id });
  }

  // The factors are already gone, so a failure here cannot undo turning 2FA
  // off; any leftover codes are replaced by the next setup.
  const { error: clearErr } = await supabase.rpc('clear_recovery_codes');
  if (clearErr) console.error('clear_recovery_codes failed:', clearErr.message);

  await recordEvent(supabase, {
    action: 'Turned off two-factor authentication',
    category: 'security',
    notify: {
      to: 'self',
      event: 'security',
      title: 'Two-factor authentication was turned off',
      body: 'If this was not you, change your password and turn it back on.',
      href: SECURITY_PATH,
    },
  });
  revalidatePath(SECURITY_PATH);
  return { notice: 'Two-factor authentication is off.' };
}
