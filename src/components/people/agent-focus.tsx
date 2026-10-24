'use client';

import { confirmPeopleFocusAction, savePeopleFocusAction } from '@/app/(app)/people/agent-actions';
import { FocusBox, type FocusView } from '@/components/agents/focus-box';

const ACTIONS = { save: savePeopleFocusAction, confirm: confirmPeopleFocusAction };

/** Lekiu's focus box (see {@link FocusBox}). */
export function PeopleAgentFocus(props: {
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
      inputId="people-agent-focus"
      placeholder="For example: contracts expiring in the next month, and leave waiting more than 3 days."
    />
  );
}
