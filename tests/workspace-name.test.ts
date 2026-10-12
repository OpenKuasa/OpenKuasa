import { describe, expect, test } from 'vitest';
import {
  WORKSPACE_NAME_MAX,
  createWorkspaceError,
  workspaceNameSchema,
} from '@/lib/auth/workspace-name';

describe('workspaceNameSchema', () => {
  test('trims the name', () => {
    expect(workspaceNameSchema.parse('  Acme Sdn Bhd \n')).toBe('Acme Sdn Bhd');
  });

  test('refuses an empty or blank name', () => {
    for (const value of ['', '   ', '\n\t']) {
      const parsed = workspaceNameSchema.safeParse(value);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0].message).toBe('Please enter your business name.');
    }
  });

  test('allows exactly the longest name and refuses one more character', () => {
    expect(WORKSPACE_NAME_MAX).toBe(120);
    expect(workspaceNameSchema.safeParse('a'.repeat(WORKSPACE_NAME_MAX)).success).toBe(true);
    const parsed = workspaceNameSchema.safeParse('a'.repeat(WORKSPACE_NAME_MAX + 1));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].message).toBe(
      'Business name must be 120 characters or fewer.',
    );
  });
});

describe('createWorkspaceError', () => {
  test('tells a demo guest to sign up', () => {
    expect(createWorkspaceError({ message: 'demo guests cannot create a workspace' })).toBe(
      'The demo is read-only. Sign up with your email to create your own workspace.',
    );
  });

  test('repeats the form messages for a name the database refused', () => {
    expect(createWorkspaceError({ message: 'workspace name required' })).toBe(
      'Please enter your business name.',
    );
    expect(createWorkspaceError({ message: 'workspace name too long' })).toBe(
      'Business name must be 120 characters or fewer.',
    );
  });

  test('keeps the shared sentences for sign-in problems', () => {
    expect(createWorkspaceError({ message: 'second factor required' })).toBe(
      'Enter the code from your authenticator app first, then try again.',
    );
    expect(createWorkspaceError({ message: 'not authenticated' })).toBe(
      'Please sign in and try again.',
    );
  });

  test('matches whatever the case or padding, and never echoes an unknown message', () => {
    expect(createWorkspaceError({ message: '  Workspace Name Required ' })).toBe(
      'Please enter your business name.',
    );
    const unknown = [{ message: 'relation "orgs" does not exist' }, { message: null }, null, undefined];
    for (const error of unknown) {
      expect(createWorkspaceError(error)).toBe('Could not create your workspace. Please try again.');
    }
  });
});
