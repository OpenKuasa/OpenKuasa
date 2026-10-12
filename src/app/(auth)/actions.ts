'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { REMEMBER_COOKIE } from '@/lib/supabase/remember';
import { recordEvent } from '@/lib/events';
import { MFA_VERIFY_PATH, getMfaStatus } from '@/lib/auth/mfa';
import { createWorkspaceError, workspaceNameSchema } from '@/lib/auth/workspace-name';

// Persist the "remember me" choice so token refreshes (in the proxy) keep the
// same cookie lifetime. A session cookie itself clears on browser close.
async function setRememberCookie(persist: boolean) {
  const store = await cookies();
  store.set(REMEMBER_COOKIE, persist ? '1' : '0', {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    ...(persist ? { maxAge: 60 * 60 * 24 * 400 } : {}),
  });
}

// Absolute origin of the current request, for building email redirect targets.
async function requestOrigin(): Promise<string> {
  const h = await headers();
  const origin = h.get('origin');
  if (origin) return origin;
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'https';
  return host ? `${proto}://${host}` : 'https://openkuasa.com';
}

export type AuthState =
  | {
      error?: string;
      notice?: string;
      values?: { email?: string; orgName?: string };
    }
  | undefined;

const emailSchema = z
  .string()
  .trim()
  .email('Please enter a valid email address.');

// Login only checks presence: the signup password policy must not lock out
// existing accounts.
const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Please enter your password.'),
});

const signUpSchema = z.object({
  email: emailSchema,
  password: z.string().min(8, 'Password must be at least 8 characters.'),
  orgName: workspaceNameSchema,
});

export async function signInAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const remember = formData.get('remember') === 'on';
  const values = { email };

  const parsed = signInSchema.safeParse({ email, password });
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message, values };
  }

  await setRememberCookie(remember);
  const supabase = await createClient({ remember });
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) return { error: 'Incorrect email or password.', values };

  // With an authenticator enrolled the password is only half of signing in;
  // 'Signed in' is recorded once the code is verified (see mfa/actions.ts).
  const { challengeRequired } = await getMfaStatus(supabase);
  if (challengeRequired) redirect(MFA_VERIFY_PATH);

  await recordEvent(supabase, { action: 'Signed in', category: 'auth' });
  redirect('/command');
}

export async function signUpAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const orgName = String(formData.get('orgName') ?? '').trim();
  const values = { email, orgName };

  const parsed = signUpSchema.safeParse({ email, password, orgName });
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message, values };
  }

  await setRememberCookie(true);
  const supabase = await createClient({ remember: true });

  // A prior attempt may have signed the user in without creating an org.
  // Skip signUp in that case so a retry does not hit "already registered".
  const { data: existing } = await supabase.auth.getUser();
  if (!existing.user || existing.user.is_anonymous) {
    const { data, error: signUpErr } = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
    });
    if (signUpErr) {
      return { error: 'Could not sign up. Try a different email.', values };
    }
    if (!data.session) {
      return {
        notice: 'Check your email to confirm your account, then sign in.',
        values,
      };
    }
  }

  const { error: orgErr } = await supabase.rpc('create_org_for_current_user', {
    org_name: parsed.data.orgName,
  });
  if (orgErr) {
    return { error: createWorkspaceError(orgErr), values };
  }
  await recordEvent(supabase, {
    action: 'Created the workspace',
    category: 'team',
    target: parsed.data.orgName,
  });

  redirect('/command');
}

export async function demoSignInAction(): Promise<AuthState> {
  if (process.env.NEXT_PUBLIC_DEMO_ENABLED !== '1') {
    return { error: 'Demo is not available.' };
  }
  await setRememberCookie(true);
  const supabase = await createClient({ remember: true });
  const { error: anonErr } = await supabase.auth.signInAnonymously();
  if (anonErr) return { error: 'Demo is unavailable right now.' };
  const { error: joinErr } = await supabase.rpc('join_demo_org');
  if (joinErr) {
    await supabase.auth.signOut();
    return { error: 'Demo is unavailable right now.' };
  }
  redirect('/command');
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}

const resetRequestSchema =z.object({ email: emailSchema });
const newPasswordSchema = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters.'),
});

// Step 1 of recovery: email the user a reset link (handled by /auth/confirm).
export async function requestPasswordResetAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = String(formData.get('email') ?? '').trim();
  const parsed = resetRequestSchema.safeParse({ email });
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message, values: { email } };
  }

  const supabase = await createClient();
  const origin = await requestOrigin();
  // The custom recovery template links to /auth/confirm with a token_hash;
  // redirectTo only backs the fallback PKCE `code` flow.
  await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${origin}/auth/confirm?next=/reset-password`,
  });

  // Always report success so the form never reveals whether an email is registered.
  return {
    notice: 'If that email has an account, a reset link is on its way.',
    values: { email },
  };
}

// Step 2 of recovery: the user arrives with a recovery session and sets a new password.
export async function updatePasswordAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const password = String(formData.get('password') ?? '');
  const parsed = newPasswordSchema.safeParse({ password });
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Your reset link has expired. Request a new one.' };
  }

  const { error } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });
  if (error) {
    return { error: 'Could not update your password. Please try again.' };
  }
  await recordEvent(supabase, {
    action: 'Reset password by email',
    category: 'security',
    notify: {
      to: 'self',
      event: 'security',
      title: 'Your password was reset',
      href: '/account/security',
    },
  });
  redirect('/command');
}
