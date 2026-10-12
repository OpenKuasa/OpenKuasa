import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PublicFormNotice, PublicFormShell } from '@/components/reach/public-form-shell';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { decodeToken, unsubscribeTarget, verifyUnsubscribeToken } from '@/lib/crm/unsubscribe';
import { confirmUnsubscribeAction } from './actions';
import { UnsubscribeForm } from './unsubscribe-form';

/**
 * The unsubscribe page a broadcast email links to: /u/<token>. Anyone holding
 * the link can open it; it sits outside the signed-in app and shows none of
 * it. Opening it changes nothing, because mail scanners open every link in a
 * message: the opt-out is recorded when the button is pressed.
 */

type Props = { params: Promise<{ token: string }> };

export const metadata: Metadata = {
  title: 'Unsubscribe',
  description: null,
  robots: { index: false, follow: false },
  openGraph: { title: 'Unsubscribe' },
  twitter: { card: 'summary', title: 'Unsubscribe' },
};

export default async function UnsubscribePage({ params }: Props) {
  const token = decodeToken((await params).token);
  // A link this server did not make has nothing behind it.
  const recipientId = token && hasSupabaseEnv() ? verifyUnsubscribeToken(token) : null;
  if (!token || !recipientId) notFound();

  const found = await unsubscribeTarget(recipientId);
  if (found.status === 'failed') {
    return (
      <PublicFormShell>
        <PublicFormNotice title="Something went wrong">
          This page could not be loaded, and nothing has changed: you are still subscribed. Please try the
          link again in a moment.
        </PublicFormNotice>
      </PublicFormShell>
    );
  }
  if (found.status === 'gone') {
    // The sender's whole workspace, and its list with it, has been removed.
    return (
      <PublicFormShell>
        <PublicFormNotice title="Nothing to unsubscribe">
          The sender of this email no longer has a list here, so no more broadcast emails will come from it.
        </PublicFormNotice>
      </PublicFormShell>
    );
  }
  if (found.target.already) {
    return (
      <PublicFormShell>
        <PublicFormNotice title="You are unsubscribed">
          {found.target.orgName} will not send broadcast emails to this address.
        </PublicFormNotice>
      </PublicFormShell>
    );
  }

  return (
    <PublicFormShell>
      <UnsubscribeForm action={confirmUnsubscribeAction.bind(null, token)} orgName={found.target.orgName} />
    </PublicFormShell>
  );
}
