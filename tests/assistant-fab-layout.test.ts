import { expect, test } from 'vitest';
import {
  ASSISTANT_FAB_CLEARANCE_REM,
  ASSISTANT_FAB_HEIGHT_REM,
  ASSISTANT_FAB_OFFSET_REM,
  showsAssistantFab,
} from '@/components/app/assistant-fab-layout';

test('the scrolling area reserves at least the button height plus its offset', () => {
  expect(ASSISTANT_FAB_CLEARANCE_REM).toBeGreaterThanOrEqual(
    ASSISTANT_FAB_HEIGHT_REM + ASSISTANT_FAB_OFFSET_REM,
  );
});

test('nothing is reserved on the Command page, where the button is not drawn', () => {
  expect(showsAssistantFab('/command')).toBe(false);
  expect(showsAssistantFab('/people/public-holidays')).toBe(true);
  expect(showsAssistantFab('/command/history')).toBe(true);
});
