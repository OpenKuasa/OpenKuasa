import { PublicFormNotice, PublicFormShell } from '@/components/reach/public-form-shell';

/** A link this site did not make. Says so, and offers nothing of the app. */
export default function UnsubscribeNotFound() {
  return (
    <PublicFormShell>
      <PublicFormNotice title="Link not valid">
        This unsubscribe link is not valid. Use the link in the email you received.
      </PublicFormNotice>
    </PublicFormShell>
  );
}
