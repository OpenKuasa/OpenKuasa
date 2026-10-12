import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptApiKey, encryptApiKey } from '@/lib/ai/key-crypto';
import {
  EMAIL_KEY_MESSAGES as M,
  emailKeyHint,
  isResendKeyShape,
  parseEmailSettings,
  readEmailKey,
  sealEmailKey,
} from '@/lib/crm/email-key';
import {
  canSignUnsubscribe,
  oneClickUnsubscribePath,
  unsubscribePath,
  unsubscribeToken,
  verifyUnsubscribeToken,
} from '@/lib/crm/unsubscribe';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const OTHER_CONTACT = '44444444-4444-4444-8444-444444444444';
const KEY = 're_AbCdEfGh_1234567890abcd';
const ENV = { AI_KEYS_ENCRYPTION_SECRET: 'a-test-secret-that-is-long-enough-123' };

beforeEach(() => {
  vi.stubEnv('AI_KEYS_ENCRYPTION_SECRET', ENV.AI_KEYS_ENCRYPTION_SECRET);
});

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

function fakeService(row: Record<string, unknown> | null, error: unknown = null) {
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.maybeSingle = async () => ({ data: row, error });
  return { from: () => builder } as never;
}

describe('a sealed key has one purpose', () => {
  it('an email key opens as an email key, for its own workspace only', () => {
    const sealed = sealEmailKey(KEY, ORG_A);
    expect(sealed.startsWith('v2.')).toBe(true);
    expect(decryptApiKey(sealed, ORG_A, ENV, 'org-email-key')).toBe(KEY);
    expect(decryptApiKey(sealed, ORG_B, ENV, 'org-email-key')).toBeNull();
  });

  it('an email key never opens as an AI key, nor an AI key as an email key', () => {
    expect(decryptApiKey(sealEmailKey(KEY, ORG_A), ORG_A, ENV)).toBeNull();
    expect(decryptApiKey(encryptApiKey('sk-or-v1-abcdefghijklmnop', ORG_A, ENV), ORG_A, ENV, 'org-email-key')).toBeNull();
  });

  it('AI keys seal and open exactly as before', () => {
    const sealed = encryptApiKey('sk-or-v1-abcdefghijklmnop', ORG_A, ENV);
    expect(decryptApiKey(sealed, ORG_A, ENV)).toBe('sk-or-v1-abcdefghijklmnop');
    expect(decryptApiKey(sealed, ORG_A, ENV, 'org-ai-key')).toBe('sk-or-v1-abcdefghijklmnop');
  });
});

describe('the email settings form', () => {
  const valid = { apiKey: ` ${KEY} `, senderEmail: ' Hello@Rimba.MY ', senderName: '  Rimba   Ventures ' };

  it('tidies what was typed', () => {
    expect(parseEmailSettings(form(valid))).toEqual({
      apiKey: KEY,
      senderEmail: 'hello@rimba.my',
      senderName: 'Rimba Ventures',
    });
  });

  it('refuses a key that is not a Resend key, without repeating it', () => {
    expect(isResendKeyShape('sk-or-v1-abcdefghijklmnop')).toBe(false);
    expect(isResendKeyShape('re_short')).toBe(false);
    let message = '';
    try {
      parseEmailSettings(form({ ...valid, apiKey: 'sk-or-v1-secretsecretsecret' }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(M.key);
    expect(message).not.toContain('secret');
  });

  it('refuses a sender that could not be an address, or a name that could break the From line', () => {
    expect(() => parseEmailSettings(form({ ...valid, senderEmail: 'not-an-address' }))).toThrow(M.senderEmail);
    expect(() => parseEmailSettings(form({ ...valid, senderEmail: 'a@b.c>, x@y.z' }))).toThrow(M.senderEmail);
    expect(() => parseEmailSettings(form({ ...valid, senderName: '' }))).toThrow(M.senderName);
    expect(() => parseEmailSettings(form({ ...valid, senderName: 'Rimba <x@y.z>' }))).toThrow(M.senderNameChars);
    expect(() => parseEmailSettings(form({ ...valid, senderName: 'x'.repeat(81) }))).toThrow(M.senderNameTooLong);
    // A line break in the name is folded to a space, never passed through.
    expect(parseEmailSettings(form({ ...valid, senderName: 'Rimba\r\nBcc: x@y.z' })).senderName).toBe('Rimba Bcc: x@y.z');
  });

  it('shows no more than the last four characters of a key', () => {
    expect(emailKeyHint(KEY)).toBe('re_…abcd');
  });
});

describe('reading a workspace’s email key', () => {
  it('opens the key sealed for that workspace', async () => {
    const row = { ciphertext: sealEmailKey(KEY, ORG_A), sender_email: 'hello@rimba.my', sender_name: 'Rimba' };
    expect(await readEmailKey(fakeService(row), ORG_A)).toEqual({
      status: 'ok',
      apiKey: KEY,
      senderEmail: 'hello@rimba.my',
      senderName: 'Rimba',
    });
  });

  it('says there is none, or that it cannot be used, and never mistakes one for the other', async () => {
    expect(await readEmailKey(fakeService(null), ORG_A)).toEqual({ status: 'none' });
    const row = { ciphertext: sealEmailKey(KEY, ORG_A), sender_email: 'hello@rimba.my', sender_name: 'Rimba' };
    // Stored against another workspace, or an AI key put in its place.
    expect(await readEmailKey(fakeService(row), ORG_B)).toEqual({ status: 'unusable' });
    expect(
      await readEmailKey(fakeService({ ...row, ciphertext: encryptApiKey('sk-or-v1-abcdefghijklmnop', ORG_A) }), ORG_A),
    ).toEqual({ status: 'unusable' });
    expect(await readEmailKey(fakeService(null, { code: 'XX000' }), ORG_A)).toEqual({ status: 'error' });
  });
});

describe('unsubscribe links', () => {
  it('name the contact they were made for, and nothing else opens them', () => {
    const token = unsubscribeToken(CONTACT);
    expect(token.startsWith(`${CONTACT}.`)).toBe(true);
    expect(verifyUnsubscribeToken(token)).toBe(CONTACT);
    expect(unsubscribePath(token)).toBe(`/u/${token}`);
    expect(oneClickUnsubscribePath(token)).toBe(`/u/${token}/one-click`);
  });

  it('a contact’s id alone is not a link, and one contact’s signature does not work for another', () => {
    const [, signature] = unsubscribeToken(CONTACT).split('.');
    expect(verifyUnsubscribeToken(CONTACT)).toBeNull();
    expect(verifyUnsubscribeToken(`${OTHER_CONTACT}.${signature}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${CONTACT}.${'A'.repeat(43)}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${CONTACT}.${signature}.extra`)).toBeNull();
    expect(verifyUnsubscribeToken('')).toBeNull();
  });

  it('made under another secret do not open, and none can be made without one', () => {
    const token = unsubscribeToken(CONTACT);
    expect(verifyUnsubscribeToken(token, { AI_KEYS_ENCRYPTION_SECRET: 'another-secret-that-is-long-enough-456' })).toBeNull();
    expect(canSignUnsubscribe({})).toBe(false);
    expect(() => unsubscribeToken(CONTACT, {})).toThrow();
    expect(verifyUnsubscribeToken(token, {})).toBeNull();
  });
});
