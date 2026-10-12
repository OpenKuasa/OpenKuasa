import { expect, test } from 'vitest';
import { safeAppPath } from '@/lib/security/safe-path';
import { safeNextPath } from '@/lib/auth/mfa';
import { isAppHref } from '@/lib/account/notifications';

test('keeps an in-app path, with its query and fragment', () => {
  expect(safeAppPath('/command')).toBe('/command');
  expect(safeAppPath('/invite/abc')).toBe('/invite/abc');
  expect(safeAppPath('/account/security?notice=recovered#codes')).toBe(
    '/account/security?notice=recovered#codes',
  );
  expect(safeAppPath('/')).toBe('/');
});

test('rejects anything that is not a string starting with one slash', () => {
  expect(safeAppPath(null)).toBeNull();
  expect(safeAppPath(undefined)).toBeNull();
  expect(safeAppPath(['/a', '/b'])).toBeNull();
  expect(safeAppPath('')).toBeNull();
  expect(safeAppPath('account')).toBeNull();
  expect(safeAppPath('https://other.example')).toBeNull();
  expect(safeAppPath('javascript:alert(1)')).toBeNull();
  expect(safeAppPath('//other.example')).toBeNull();
  expect(safeAppPath('///other.example')).toBeNull();
});

test('rejects backslashes anywhere', () => {
  expect(safeAppPath('/\\other.example')).toBeNull();
  expect(safeAppPath('\\other.example')).toBeNull();
  expect(safeAppPath('/a\\b')).toBeNull();
});

test('rejects control characters and whitespace', () => {
  expect(safeAppPath('/\t/other.example')).toBeNull();
  expect(safeAppPath('/\n/other.example')).toBeNull();
  expect(safeAppPath('/\r/other.example')).toBeNull();
  expect(safeAppPath('/\u0000/other.example')).toBeNull();
  expect(safeAppPath('/a\u007fb')).toBeNull();
  expect(safeAppPath('/a\u0085b')).toBeNull();
  expect(safeAppPath(' /command')).toBeNull();
  expect(safeAppPath('/command ')).toBeNull();
  expect(safeAppPath('/a b')).toBeNull();
  expect(safeAppPath('/a b')).toBeNull();
  expect(safeAppPath('/a b')).toBeNull();
});

test('rejects a path that only becomes another host once normalised', () => {
  expect(safeAppPath('/..//other.example')).toBeNull();
  expect(safeAppPath('/.//other.example')).toBeNull();
  expect(safeAppPath('/a/..//other.example')).toBeNull();
});

test('returns the normalised form of the path', () => {
  expect(safeAppPath('/a/../b')).toBe('/b');
  expect(safeAppPath('/a/./b?x=1')).toBe('/a/b?x=1');
});

test('every caller-facing check uses the same rules', () => {
  const rejected = [
    '/\t/other.example',
    '/\\other.example',
    '/..//other.example',
    '//other.example',
  ];
  for (const bad of rejected) {
    expect(safeNextPath(bad)).toBeNull();
    expect(isAppHref(bad)).toBe(false);
  }
  expect(safeNextPath('/invite/abc')).toBe('/invite/abc');
  expect(isAppHref('/account/security')).toBe(true);
});
