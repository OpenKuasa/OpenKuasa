import { expect, test } from 'vitest';
import {
  INVITE_CONFIRM_FIRST,
  INVITE_CONFIRM_NOTICE,
  friendlyRpcError,
  inviteConfirmUrl,
  inviteProblem,
  inviteUrl,
  isPendingInvite,
  originFromHeaders,
} from '@/lib/account/invites';

const headersOf = (values: Record<string, string>) => ({
  get: (name: string) => values[name] ?? null,
});

test('database messages become friendly sentences', () => {
  expect(friendlyRpcError({ message: 'already a member' })).toBe(
    'That person is already a member of this workspace.',
  );
  expect(friendlyRpcError({ message: 'cannot remove the owner' })).toBe(
    'The owner cannot be removed.',
  );
  expect(friendlyRpcError({ message: 'Invite is for another email ' })).toBe(
    'This invite was sent to a different email address.',
  );
});

test('unknown database errors never leak', () => {
  const raw = 'duplicate key value violates unique constraint "org_invites_pkey"';
  expect(friendlyRpcError({ message: raw })).toBe(
    'Something went wrong. Please try again.',
  );
  expect(friendlyRpcError({ message: raw }, 'Could not do that.')).toBe(
    'Could not do that.',
  );
  expect(friendlyRpcError(null, 'Could not do that.')).toBe('Could not do that.');
});

test('only pending invites can be used', () => {
  expect(inviteProblem('pending')).toBeNull();
  expect(inviteProblem('accepted')).toMatch(/already been accepted/);
  expect(inviteProblem('revoked')).toMatch(/cancelled/);
  expect(inviteProblem('expired')).toMatch(/expired/);
});

test('an invite is pending until accepted, revoked or expired', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const open = {
    accepted_at: null,
    revoked_at: null,
    expires_at: '2026-10-17T00:00:00Z',
  };
  const past = '2026-10-09T00:00:00Z';
  expect(isPendingInvite(open, now)).toBe(true);
  expect(isPendingInvite({ ...open, accepted_at: past }, now)).toBe(false);
  expect(isPendingInvite({ ...open, revoked_at: past }, now)).toBe(false);
  expect(isPendingInvite({ ...open, expires_at: past }, now)).toBe(false);
});

test('the invite link uses the request origin', () => {
  expect(originFromHeaders(headersOf({ origin: 'http://localhost:3000' }))).toBe(
    'http://localhost:3000',
  );
  expect(
    originFromHeaders(
      headersOf({ 'x-forwarded-host': 'openkuasa.com', host: 'internal:8080' }),
    ),
  ).toBe('https://openkuasa.com');
  expect(
    originFromHeaders(
      headersOf({ host: 'localhost:3000', 'x-forwarded-proto': 'http' }),
    ),
  ).toBe('http://localhost:3000');
  expect(originFromHeaders(headersOf({}))).toBe('https://openkuasa.com');
  expect(inviteUrl('https://openkuasa.com/', 'abc')).toBe(
    'https://openkuasa.com/invite/abc',
  );
});

test('joining before the address is confirmed says what to do next', () => {
  expect(friendlyRpcError({ message: 'email not confirmed' }, 'Could not join.')).toBe(
    INVITE_CONFIRM_FIRST,
  );
  expect(INVITE_CONFIRM_FIRST).toMatch(/come back to this invite/);
  expect(INVITE_CONFIRM_NOTICE).toMatch(/brings you back to this invite/);
});

test('the confirmation link returns to the same invite', () => {
  const token = '7b1f6c0e-3a52-4d0b-9c1e-2f4a5b6c7d8e';
  const url = inviteConfirmUrl('https://openkuasa.com/', token);
  expect(url).toBe(`https://openkuasa.com/auth/confirm?next=%2Finvite%2F${token}`);
  // The confirm route only follows a same-origin relative path.
  expect(new URL(url).searchParams.get('next')).toBe(`/invite/${token}`);
});
