'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import type { UnsubscribeState } from './actions';

/** The one button on the unsubscribe page. Opening the page changes nothing; pressing this does. */
export function UnsubscribeForm({
  action,
  orgName,
}: {
  /** The confirm action, already tied to this link. */
  action: (prev: UnsubscribeState, formData: FormData) => Promise<UnsubscribeState>;
  orgName: string;
}) {
  const [state, formAction, pending] = useActionState<UnsubscribeState, FormData>(action, undefined);

  if (state?.done) {
    return (
      <div className="space-y-2" role="status">
        <h1 className="text-xl font-semibold tracking-tight">You are unsubscribed</h1>
        <p className="text-sm text-muted-foreground">
          {orgName} will not send broadcast emails to this address again.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Unsubscribe from {orgName}?</h1>
        <p className="text-sm text-muted-foreground">
          You will stop receiving broadcast emails from {orgName} at this address.
        </p>
      </div>
      <Button type="submit" size="lg" className="h-10 w-full" disabled={pending}>
        {pending ? 'Unsubscribing…' : 'Unsubscribe'}
      </Button>
      {state?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
