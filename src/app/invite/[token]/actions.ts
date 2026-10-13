'use server';

import { cookies, headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { REMEMBER_COOKIE } from '@/lib/supabase/remember';
import { getMfaStatus, mfaVerifyHref } from '@/lib/auth/mfa';
import {
  INVITE_CONFIRM_FIRST,
  INVITE_CONFIRM_NOTICE,
  friendlyRpcError,
  getInvite,
  inviteConfirmUrl,
  inviteProblem,
  originFromHeaders,
  type InviteAcceptState,
} from '@/lib/account/invites';
import { signInLimited, signUpLimited } from '@/lib/security/limits';

type ServerClient = Awaited<ReturnType<typeof createClient>>;

const INVALID_LINK = 'This invite link is not valid.';

const tokenSchema = z.uuid();

// Same lifetime as a "remember me" sign-in (see the auth actions).
async function setRememberCookie() {
  const store = await cookies();
  store.set(REMEMBER_COOKIE, '1', {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 400,
  });
}

// The email always comes from the invite itself, never from the form.
async function pendingInvite(
  supabase: ServerClient,
  formData: FormData,
): Promise<{ token: string; email: string; error?: undefined } | { error: string }> {
  const token = tokenSchema.safeParse(String(formData.get('token') ?? ''));
  if (!token.success) return { error: INVALID_LINK };

  const invite = await getInvite(supabase, token.data);
  if (!invite) return { error: INVALID_LINK };
  const problem = inviteProblem(invite.status);
  if (problem) return { error: problem };
  return { token: token.data, email: invite.email };
}

// Joins the workspace as the signed-in user; returns a message on failure.
async function accept(
  supabase: ServerClient,
  token: string,
): Promise<string | null> {
  const { error } = await supabase.rpc('accept_invite', { p_token: token });
  if (error) {
    return friendlyRpcError(error, 'Could not join the workspace. Please try again.');
  }
  revalidatePath('/', 'layout');
  return null;
}

export async function acceptInviteAction(
  _prev: InviteAcceptState,
  formData: FormData,
): Promise<InviteAcceptState> {
  const supabase = await createClient();
  const invite = await pendingInvite(supabase, formData);
  if (invite.error !== undefined) return { error: invite.error };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Please sign in to accept this invite.' };

  // Someone who signed up from this invite and has just confirmed their
  // address gave their name at sign-up; it was not saved then (no session).
  const metaName = user.user_metadata?.full_name;
  if (typeof metaName === 'string' && metaName.trim()) {
    await supabase
      .from('profiles')
      .update({ full_name: metaName.trim().slice(0, 120) })
      .eq('user_id', user.id)
      .is('full_name', null);
  }

  const failure = await accept(supabase, invite.token);
  if (failure) return { error: failure };
  redirect('/command');
}

const signInSchema = z.object({
  password: z.string().min(1, 'Please enter your password.'),
});

export async function signInAndAcceptAction(
  _prev: InviteAcceptState,
  formData: FormData,
): Promise<InviteAcceptState> {
  const parsed = signInSchema.safeParse({
    password: String(formData.get('password') ?? ''),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  await setRememberCookie();
  const supabase = await createClient({ remember: true });
  const invite = await pendingInvite(supabase, formData);
  if (invite.error !== undefined) return { error: invite.error };
  const limited = await signInLimited(invite.email);
  if (limited) return { error: limited };

  const { error } = await supabase.auth.signInWithPassword({
    email: invite.email,
    password: parsed.data.password,
  });
  if (error) {
    // The account exists but its address was never confirmed: say so, rather
    // than sending them to create an account that already exists.
    if (error.code === 'email_not_confirmed') return { error: INVITE_CONFIRM_FIRST };
    return {
      error:
        'Incorrect password, or there is no account for this email yet. If you are new, choose "Create my account".',
    };
  }

  // With two-factor on, the password is only the first step: finish it, then
  // come back to this invite to join.
  if ((await getMfaStatus(supabase)).challengeRequired) {
    redirect(mfaVerifyHref(`/invite/${invite.token}`));
  }

  const failure = await accept(supabase, invite.token);
  if (failure) return { error: failure };
  redirect('/command');
}

const signUpSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(1, 'Please enter your name.')
    .max(120, 'Name must be 120 characters or fewer.'),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
});

export async function signUpAndAcceptAction(
  _prev: InviteAcceptState,
  formData: FormData,
): Promise<InviteAcceptState> {
  const fullName = String(formData.get('fullName') ?? '').trim();
  const parsed = signUpSchema.safeParse({
    fullName,
    password: String(formData.get('password') ?? ''),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message, fullName };
  }

  await setRememberCookie();
  const supabase = await createClient({ remember: true });
  const invite = await pendingInvite(supabase, formData);
  if (invite.error !== undefined) return { error: invite.error, fullName };
  const limited = await signUpLimited(invite.email);
  if (limited) return { error: limited, fullName };

  // Where email confirmation is on, the link in the confirmation email comes
  // back to this invite, signed in, so joining is one more click.
  const origin = originFromHeaders(await headers());
  const { data, error } = await supabase.auth.signUp({
    email: invite.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: inviteConfirmUrl(origin, invite.token),
    },
  });
  if (error) {
    return {
      error:
        'Could not create your account. If you already have one, choose "I already have an account".',
      fullName,
    };
  }
  // With email confirmation on, an existing account comes back as a user
  // with no identities and no email is sent, so do not ask them to wait.
  if (!data.session && data.user?.identities?.length === 0) {
    return {
      error:
        'An account with this email already exists. Choose "I already have an account" to sign in.',
      fullName,
    };
  }
  if (!data.session) {
    return { notice: INVITE_CONFIRM_NOTICE, fullName };
  }

  // Invited people join the inviting workspace; they do not get their own.
  if (data.user) {
    await supabase
      .from('profiles')
      .update({ full_name: parsed.data.fullName })
      .eq('user_id', data.user.id);
  }

  const failure = await accept(supabase, invite.token);
  if (failure) return { error: failure, fullName };
  redirect('/command');
}

/** Ends the current session and returns to the invite, so it is not lost. */
export async function signOutToInviteAction(formData: FormData): Promise<void> {
  const token = tokenSchema.safeParse(String(formData.get('token') ?? ''));
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect(token.success ? `/invite/${token.data}` : '/login');
}
