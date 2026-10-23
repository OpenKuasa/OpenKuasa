import { afterEach, expect, test, vi } from 'vitest';
import { signInEnabled } from '@/lib/mcp/flags';

afterEach(() => {
  vi.unstubAllEnvs();
});

test('sign-in connections are on only when MCP_SIGN_IN_ENABLED is exactly "true"', () => {
  vi.stubEnv('MCP_SIGN_IN_ENABLED', 'true');
  expect(signInEnabled()).toBe(true);
  for (const value of ['', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true ']) {
    vi.stubEnv('MCP_SIGN_IN_ENABLED', value);
    expect(signInEnabled()).toBe(false);
  }
  vi.stubEnv('MCP_SIGN_IN_ENABLED', undefined);
  expect(signInEnabled()).toBe(false);
});
