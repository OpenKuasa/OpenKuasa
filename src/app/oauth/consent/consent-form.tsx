'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { allowAction, denyAction, type ConsentState } from './actions';

/** The two answers. The workspace id only lets the server check it is still the one shown; it is never stored from here. */
export function ConsentForm({ authorizationId, orgId }: { authorizationId: string; orgId: string }) {
  const [allowState, allow, allowing] = useActionState<ConsentState, FormData>(allowAction, undefined);
  const [denyState, deny, denying] = useActionState<ConsentState, FormData>(denyAction, undefined);
  const error = allowState?.error ?? denyState?.error;
  const busy = allowing || denying;

  return (
    <div className="space-y-3">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <form action={allow}>
        <input type="hidden" name="authorization_id" value={authorizationId} />
        <input type="hidden" name="org_id" value={orgId} />
        <Button type="submit" className="w-full" size="lg" disabled={busy}>
          {allowing ? 'Allowing…' : 'Allow'}
        </Button>
      </form>
      <form action={deny}>
        <input type="hidden" name="authorization_id" value={authorizationId} />
        <Button type="submit" variant="outline" className="w-full" size="lg" disabled={busy}>
          {denying ? 'Sending you back…' : "Don't allow"}
        </Button>
      </form>
    </div>
  );
}
