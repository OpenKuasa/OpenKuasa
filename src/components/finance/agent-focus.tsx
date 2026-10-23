'use client';

import { confirmFinanceFocusAction, saveFinanceFocusAction } from '@/app/(app)/finance/agent-actions';
import { FocusBox, type FocusView } from '@/components/agents/focus-box';

const ACTIONS = { save: saveFinanceFocusAction, confirm: confirmFinanceFocusAction };

/** Bendahara's focus box (see {@link FocusBox}). */
export function FinanceAgentFocus(props: {
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
      inputId="finance-agent-focus"
      placeholder="For example: invoices overdue more than two weeks, and bills due this week."
    />
  );
}
