import { expect, test } from 'vitest';
import {
  isRecoveryMarkerValid,
  issueRecoveryMarker,
} from '@/lib/auth/recovery-marker';

const NOW = Date.parse('2026-10-12T09:00:00.000Z');
const MINUTE = 60_000;
const own = { AUTH_COOKIE_SECRET: 'a-dedicated-secret-of-32-characters!' };
const shared = { AI_KEYS_ENCRYPTION_SECRET: 'the-key-sealing-secret-32-characters' };

test('a marker is good for its user for fifteen minutes', () => {
  const marker = issueRecoveryMarker('user-1', NOW, own);
  expect(isRecoveryMarkerValid(marker, 'user-1', NOW, own)).toBe(true);
  expect(isRecoveryMarkerValid(marker, 'user-1', NOW + 14 * MINUTE, own)).toBe(true);
  expect(isRecoveryMarkerValid(marker, 'user-1', NOW + 16 * MINUTE, own)).toBe(false);
  expect(isRecoveryMarkerValid(marker, 'user-2', NOW, own)).toBe(false);
});

test('a marker cannot be re-dated or made up', () => {
  const marker = issueRecoveryMarker('user-1', NOW, own);
  const signature = marker.split('.')[1];
  const later = NOW + 60 * MINUTE;
  expect(isRecoveryMarkerValid(`${later}.${signature}`, 'user-1', later, own)).toBe(false);
  expect(isRecoveryMarkerValid(`${NOW}.`, 'user-1', NOW, own)).toBe(false);
  expect(isRecoveryMarkerValid(`${NOW}.${signature}.x`, 'user-1', NOW, own)).toBe(false);
  expect(isRecoveryMarkerValid('', 'user-1', NOW, own)).toBe(false);
  expect(isRecoveryMarkerValid(undefined, 'user-1', NOW, own)).toBe(false);
  expect(isRecoveryMarkerValid(`${NOW + 60 * MINUTE}.${signature}`, 'user-1', NOW, own)).toBe(false);
});

test('a marker signed under one secret does not pass under another', () => {
  const marker = issueRecoveryMarker('user-1', NOW, own);
  expect(isRecoveryMarkerValid(marker, 'user-1', NOW, shared)).toBe(false);
  expect(isRecoveryMarkerValid(marker, 'user-1', NOW, {})).toBe(false);
});

test('falls back to the key-sealing secret, then to a per-process key', () => {
  const viaShared = issueRecoveryMarker('user-1', NOW, shared);
  expect(isRecoveryMarkerValid(viaShared, 'user-1', NOW, shared)).toBe(true);

  // A secret that is too short is ignored rather than used.
  const weak = { AUTH_COOKIE_SECRET: 'short' };
  const viaProcess = issueRecoveryMarker('user-1', NOW, weak);
  expect(isRecoveryMarkerValid(viaProcess, 'user-1', NOW, {})).toBe(true);
  expect(isRecoveryMarkerValid(viaProcess, 'user-1', NOW, own)).toBe(false);
});
