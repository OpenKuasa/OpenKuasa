'use client';

import { submitOwnClaimAction } from '@/app/(app)/people/pay-actions';
import type { ClaimFormInput } from '@/lib/people/claim-forms';
import { ClaimForm } from './claim-form';
import { discardUploadedReceipt, uploadOwnReceipt } from './receipt-client';
import { RequestDialog } from './request-dialog';

/** "New Claim": the claim form for the signed-in member's own expense claim. */
export function NewClaimDialog() {
  return (
    <RequestDialog
      label="New Claim"
      title="New claim"
      description="Say what you spent and attach the receipt if you have one."
      submit={(input: ClaimFormInput) => submitOwnClaimAction(input)}
      render={({ disabled, error, onCancel, onSubmit }) => (
        <ClaimForm
          disabled={disabled}
          error={error}
          onUpload={uploadOwnReceipt}
          onDiscard={discardUploadedReceipt}
          onCancel={onCancel}
          onSubmit={onSubmit}
        />
      )}
    />
  );
}
