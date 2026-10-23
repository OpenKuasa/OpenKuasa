'use server';

import { redirect } from 'next/navigation';
import { currentOrgFor } from '@/lib/auth/current-org';
import { logFailure } from '@/lib/mcp/shared';
import {
  EXPIRED,
  FAILED,
  NOT_VALID,
  NO_WORKSPACE,
  OTHER_ACCOUNT,
  WORKSPACE_CHANGED,
  answeringPerson,
  authorizationIdOf,
} from './consent';

export type ConsentState = { error?: string } | undefined;

const log = (operation: string, error: unknown) => logFailure('oauth-consent', operation, error);

/**
 * Allow: record, as the person, that this client acts in the workspace they have open (the one the screen named),
 * then tell the auth server yes and go back to the client. If the record cannot be written, nothing is approved.
 * The client and the workspace come from the auth server and the database, never from the form.
 */
export async function allowAction(_prev: ConsentState, formData: FormData): Promise<ConsentState> {
  const authorizationId = authorizationIdOf(formData.get('authorization_id'));
  if (!authorizationId) return { error: NOT_VALID };

  const gate = await answeringPerson(authorizationId);
  if (gate.kind === 'redirect') redirect(gate.to);
  if (gate.kind === 'refuse') return { error: gate.message };
  const { supabase, user } = gate;

  const { data: details, error: detailsError } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
  if (detailsError || !details) return { error: EXPIRED };
  // Already allowed earlier: the auth server sends the person straight back.
  if (!('authorization_id' in details)) redirect(details.redirect_url);
  if (details.user.id !== user.id) return { error: OTHER_ACCOUNT };

  let orgId: string;
  try {
    const current = await currentOrgFor(supabase, user.id);
    if (!current) return { error: NO_WORKSPACE };
    orgId = current.orgId;
  } catch (error) {
    log('read workspace', error);
    return { error: FAILED };
  }
  // The person must be allowing the workspace the screen showed them.
  if (formData.get('org_id') !== orgId) return { error: WORKSPACE_CHANGED };

  // One row per person and client. Replaced before approving on purpose: clicking Allow chose this workspace.
  const clientId = details.client.id;
  const { error: deleteError } = await supabase
    .from('mcp_oauth_bindings')
    .delete()
    .eq('user_id', user.id)
    .eq('client_id', clientId);
  if (deleteError) {
    log('clear binding', deleteError);
    return { error: FAILED };
  }
  const { error: insertError } = await supabase
    .from('mcp_oauth_bindings')
    .insert({ user_id: user.id, client_id: clientId, org_id: orgId });
  if (insertError) {
    log('write binding', insertError);
    return { error: FAILED };
  }

  const { data: approved, error: approveError } = await supabase.auth.oauth.approveAuthorization(authorizationId, {
    skipBrowserRedirect: true,
  });
  if (approveError || !approved?.redirect_url) return { error: EXPIRED };
  redirect(approved.redirect_url);
}

/** Don't allow: tell the auth server no and go back to the client, which hears the request was denied. */
export async function denyAction(_prev: ConsentState, formData: FormData): Promise<ConsentState> {
  const authorizationId = authorizationIdOf(formData.get('authorization_id'));
  if (!authorizationId) return { error: NOT_VALID };

  // The same gate as Allow: signed in, not the demo, second factor done.
  const gate = await answeringPerson(authorizationId);
  if (gate.kind === 'redirect') redirect(gate.to);
  if (gate.kind === 'refuse') return { error: gate.message };
  const { supabase } = gate;

  const { data: denied, error } = await supabase.auth.oauth.denyAuthorization(authorizationId, {
    skipBrowserRedirect: true,
  });
  if (error || !denied?.redirect_url) return { error: EXPIRED };
  redirect(denied.redirect_url);
}
