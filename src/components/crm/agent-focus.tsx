'use client';

import { confirmFocusAction, saveFocusAction } from '@/app/(app)/crm/agent-actions';
import { FocusBox } from '@/components/agents/focus-box';
import type { CrmFocusView } from '@/screens/crm/agents-view';

const ACTIONS = { save: saveFocusAction, confirm: confirmFocusAction };

/** Kasturi's focus box (see {@link FocusBox}). */
export function AgentFocus(props: {
  focus: CrmFocusView;
  starters: readonly string[];
  maxChars: number;
  canManage: boolean;
  hasKey: boolean;
}) {
  return (
    <FocusBox
      {...props}
      actions={ACTIONS}
      inputId="crm-agent-focus"
      placeholder="For example: deals quiet for a week, and new contacts nobody has called."
    />
  );
}
