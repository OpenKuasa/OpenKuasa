'use client';

import { submitOwnClaimAction } from '@/app/(app)/people/pay-actions';
import type { CapResult } from '@/lib/people/capabilities';
import type { ClaimFormInput } from '@/lib/people/claim-forms';
import { uploadReceipt } from '@/lib/people/receipts';
import { createClient } from '@/lib/supabase/client';
import { ClaimForm } from './claim-form';
import { RequestDialog } from './request-dialog';

const UPLOAD_FAILED = 'That file could not be uploaded.';

/** Uploads into the signed-in user's own receipts folder with the browser's client. */
async function uploadOwnReceipt(file: File): Promise<CapResult<{ path: string }>> {
  try {
    const client = createClient();
    const { data } = await client.auth.getUser();
    if (!data.user) return { ok: false, error: UPLOAD_FAILED };
    return await uploadReceipt(client, data.user.id, file, file.type);
  } catch {
    return { ok: false, error: UPLOAD_FAILED };
  }
}

/** "New Claim": the claim form for the signed-in member's own expense claim. */
export function NewClaimDialog() {
  return (
    <RequestDialog
      label="New Claim"
      title="New claim"
      description="Say what you spent and attach the receipt if you have one."
      submit={(input: ClaimFormInput) => submitOwnClaimAction(input)}
      render={({ disabled, error, onCancel, onSubmit }) => (
        <ClaimForm disabled={disabled} error={error} onUpload={uploadOwnReceipt} onCancel={onCancel} onSubmit={onSubmit} />
      )}
    />
  );
}
