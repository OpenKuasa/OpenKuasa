import { PublicFormNotice, PublicFormShell } from '@/components/reach/public-form-shell';

/** A link with no page behind it. Says so, and offers nothing of the app. */
export default function PublicLandingPageNotFound() {
  return (
    <PublicFormShell>
      <PublicFormNotice title="Page not found">
        There is no page at this link. Check that you copied the whole link.
      </PublicFormNotice>
    </PublicFormShell>
  );
}
