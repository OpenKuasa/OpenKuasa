'use client';

import { confirmHireFocusAction, saveHireFocusAction } from '@/app/(app)/hire/agent-actions';
import { FocusBox, type FocusView } from '@/components/agents/focus-box';

const ACTIONS = { save: saveHireFocusAction, confirm: confirmHireFocusAction };

/** Lekir's focus box (see {@link FocusBox}). */
export function HireAgentFocus(props: {
  focus: FocusView;
  starters: readonly string[];
  maxChars: number;
  canManage: boolean;
  hasKey: boolean;
}) {
  return (
    <FocusBox
      {...props}
      actions={ACTIONS}
      inputId="hire-agent-focus"
      placeholder="For example: anyone waiting more than 5 days to be screened, and interviews with no feedback."
    />
  );
}
