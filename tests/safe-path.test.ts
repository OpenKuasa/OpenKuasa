import { expect, test } from 'vitest';
import { safeAppPath, signInReturnPath } from '@/lib/security/safe-path';
import { sariAskPath } from '@/lib/docs/ask';
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

test('sign-in may return to Sari with a question, and nowhere else new', () => {
  const ok = sariAskPath('How do I run payroll?');
  expect(signInReturnPath(ok)).toBe(ok);
  expect(signInReturnPath('/oauth/consent?x=1')).toBe('/oauth/consent?x=1');
  for (const bad of ['/command', '/command?chat=1', '/command?ask=x&next=//evil.com', '/command?ask=a&ask=b', '/command/x?ask=a', '//evil.com/command?ask=a', `/command?ask=${'a'.repeat(301)}`, '/command?ask=x#y', '/people/payroll?ask=x']) {
    expect(signInReturnPath(bad), bad).toBeNull();
  }
});

test('the Sari return only takes a question already in its cleaned form', () => {
  for (const bad of ['/command?ask=', '/command?ask=%20a', '/command?ask=a%0Ab', '/command?ask=a%20%20b', '/command?ask=a%00', '/command?team=0&ask=a', '/Command?ask=a']) {
    expect(signInReturnPath(bad), bad).toBeNull();
  }
  // Characters a browser re-encodes still make a path sign-in accepts.
  for (const question of ["What's the leave policy?", 'Gaji & KWSP: 50% #1?', 'Bayar gaji 😀']) {
    const path = signInReturnPath(sariAskPath(question));
    expect(path, question).not.toBeNull();
    expect(new URL(path!, 'http://x.invalid').searchParams.get('ask')).toBe(question);
  }
});
