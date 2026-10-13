'use client';

import { previewOwnOvertimeAction, submitOwnOvertimeAction } from '@/app/(app)/people/pay-actions';
import type { OvertimeFormInput } from '@/lib/people/overtime-forms';
import { OvertimeForm } from './overtime-form';
import { RequestDialog } from './request-dialog';

/** "Claim OT": the overtime form for the signed-in member's own overtime. */
export function NewOvertimeDialog() {
  return (
    <RequestDialog
      label="Claim OT"
      title="Claim overtime"
      description="Choose the day and the hours. The pay is worked out for you."
      submit={(input: OvertimeFormInput) => submitOwnOvertimeAction(input)}
      render={({ disabled, error, onCancel, onSubmit }) => (
        <OvertimeForm
          disabled={disabled}
          error={error}
          onCancel={onCancel}
          onPreview={(input) => previewOwnOvertimeAction(input)}
          onSubmit={onSubmit}
        />
      )}
    />
  );
}
