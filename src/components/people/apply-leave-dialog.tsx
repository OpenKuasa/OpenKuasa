'use client';

import {
  applyOwnLeaveAction,
  applyOwnTimeOffAction,
  previewOwnLeaveAction,
} from '@/app/(app)/people/leave-actions';
import type { LeaveFormInput } from '@/lib/people/leave-forms';
import type { TimeOffFormInput } from '@/lib/people/time-off-forms';
import { LeaveForm } from './leave-form';
import { RequestDialog } from './request-dialog';
import { TimeOffForm } from './time-off-form';

/** "Apply Leave": the leave form for the signed-in member's own leave. */
export function ApplyLeaveDialog() {
  return (
    <RequestDialog
      label="Apply Leave"
      title="Apply for leave"
      description="Choose the dates. Working days are counted for you."
      submit={(input: LeaveFormInput) => applyOwnLeaveAction(input)}
      render={({ disabled, error, onCancel, onSubmit }) => (
        <LeaveForm
          disabled={disabled}
          error={error}
          onCancel={onCancel}
          onPreview={(input) => previewOwnLeaveAction(input)}
          onSubmit={onSubmit}
        />
      )}
    />
  );
}

/** "Request Time-Off": the time-off form for the signed-in member. */
export function ApplyTimeOffDialog() {
  return (
    <RequestDialog
      label="Request Time-Off"
      title="Request time-off"
      description="Ask for a few hours off on one day."
      submit={(input: TimeOffFormInput) => applyOwnTimeOffAction(input)}
      render={({ disabled, error, onCancel, onSubmit }) => (
        <TimeOffForm disabled={disabled} error={error} onCancel={onCancel} onSubmit={onSubmit} />
      )}
    />
  );
}
