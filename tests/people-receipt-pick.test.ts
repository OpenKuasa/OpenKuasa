import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { pickReceipt, userMessageBefore } from '@/lib/people/receipts';
import { receiptStateFor } from '@/components/chat/tool-parts';
import { receiptFromMessages } from '@/lib/ai/people-tools';

const url = (text: string) => `data:application/octet-stream;base64,${Buffer.from(text).toString('base64')}`;
const part = (mediaType: string, text = 'bytes') => ({ mediaType, url: url(text) });

describe('pickReceipt: the one rule for which file is the receipt', () => {
  it('is none when nothing is an image or a PDF', () => {
    expect(pickReceipt([])).toEqual({ state: 'none' });
    expect(pickReceipt([part('text/csv')])).toEqual({ state: 'none' });
  });

  it('is the first USABLE image or PDF, not merely the first', () => {
    expect(pickReceipt([part('image/gif'), part('image/png')])).toEqual({ state: 'attached', index: 1 });
    expect(pickReceipt([part('text/csv'), part('application/pdf')])).toEqual({ state: 'attached', index: 1 });
    expect(pickReceipt([part('image/png'), part('application/pdf')])).toEqual({ state: 'attached', index: 0 });
  });

  it('is unusable, with the reason, when every image or PDF is refused', () => {
    expect(pickReceipt([part('image/gif')])).toEqual({
      state: 'unusable',
      problem: 'Attach a photo (JPEG, PNG, WebP or HEIC) or a PDF.',
    });
    expect(pickReceipt([{ mediaType: 'image/png', url: 'data:image/png;base64,' }])).toMatchObject({ state: 'unusable', problem: 'That file is empty.' });
    const big = { mediaType: 'application/pdf', url: `data:application/pdf;base64,${'A'.repeat(7 * 1024 * 1024)}` };
    expect(pickReceipt([big])).toMatchObject({ state: 'unusable' });
    expect((pickReceipt([big]) as { problem: string }).problem).toContain('5 MB');
  });

  it('takes a stored link on its type alone, since its size is not known in the browser', () => {
    expect(pickReceipt([{ mediaType: 'image/png', url: 'https://example.test/signed' }])).toEqual({ state: 'attached', index: 0 });
    expect(pickReceipt([{ mediaType: 'image/gif', url: 'https://example.test/signed' }])).toMatchObject({ state: 'unusable' });
  });

  it('ignores the case and parameters of a media type', () => {
    expect(pickReceipt([part('IMAGE/PNG; charset=x')])).toEqual({ state: 'attached', index: 0 });
  });
});

const user = (id: string, ...parts: UIMessage['parts']): UIMessage => ({ id, role: 'user', parts });
const file = (mediaType: string, text = 'bytes') => ({ type: 'file' as const, mediaType, url: url(text) });
const card = (id: string, approvalId: string): UIMessage => ({
  id,
  role: 'assistant',
  parts: [
    { type: 'tool-submitClaim', toolCallId: `t-${id}`, state: 'approval-requested', input: {}, approval: { id: approvalId } } as unknown as UIMessage['parts'][number],
  ],
});

describe('which question a claim belongs to', () => {
  it('is the nearest user message before the message that carries the claim', () => {
    const messages = [user('u1'), card('a1', 'x'), user('u2')];
    expect(userMessageBefore(messages, 1)?.id).toBe('u1');
    expect(userMessageBefore(messages, 0)).toBeNull();
  });

  it('gives the card and the tool the same file, even after a newer question', () => {
    const messages = [user('u1', file('image/png', 'older')), card('a1', 'ap1'), user('u2', file('application/pdf', 'newer'))];
    expect(receiptStateFor(messages, 'ap1')).toEqual({ state: 'attached' });
    expect(receiptFromMessages(messages)?.bytes.toString()).toBe('older');
    expect(receiptFromMessages(messages)?.mediaType).toBe('image/png');
  });

  it('says none for the card and gives the tool nothing when the claim’s own question had no file', () => {
    const messages = [user('u1'), card('a1', 'ap1'), user('u2', file('image/png'))];
    expect(receiptStateFor(messages, 'ap1')).toEqual({ state: 'none' });
    expect(receiptFromMessages(messages)).toBeNull();
  });

  it('says unusable for the card, and hands the tool the refused file so it can say why', () => {
    const messages = [user('u1', file('image/gif')), card('a1', 'ap1')];
    expect(receiptStateFor(messages, 'ap1')).toMatchObject({ state: 'unusable' });
    expect(receiptFromMessages(messages)?.mediaType).toBe('image/gif');
  });

  it('prefers the first usable file over an earlier refused one, for both', () => {
    const messages = [user('u1', file('image/gif', 'bad'), file('image/jpeg', 'good')), card('a1', 'ap1')];
    expect(receiptStateFor(messages, 'ap1')).toEqual({ state: 'attached' });
    expect(receiptFromMessages(messages)?.bytes.toString()).toBe('good');
  });

  it('uses the newest question when no claim has been proposed yet, and has no state for an unknown approval', () => {
    expect(receiptFromMessages([user('u1', file('image/png', 'x'))])?.bytes.toString()).toBe('x');
    expect(receiptStateFor([user('u1'), card('a1', 'ap1')], 'nope')).toBeUndefined();
  });
});

describe('pickReceipt with an empty type', () => {
  it("works the type out from the part's file name", () => {
    expect(pickReceipt([{ mediaType: '', filename: 'IMG_1.HEIC', url: url('x') }])).toEqual({ state: 'attached', index: 0 });
    expect(pickReceipt([{ mediaType: 'application/octet-stream', filename: 'a.pdf', url: url('x') }])).toEqual({ state: 'attached', index: 0 });
  });

  it('treats a real image/heif like HEIC, which the bucket takes', () => {
    expect(pickReceipt([{ mediaType: 'image/heif', url: url('x') }])).toEqual({ state: 'attached', index: 0 });
  });

  it('hands an oversized file with an empty type to the tool too, so the card and the tool agree', () => {
    const big = { type: 'file' as const, mediaType: '', filename: 'big.heic', url: `data:application/octet-stream;base64,${'A'.repeat(7 * 1024 * 1024)}` };
    expect(pickReceipt([big])).toMatchObject({ state: 'unusable' });
    expect(receiptFromMessages([user('u1', big)])).not.toBeNull();
  });

  it('still ignores a file with no usable name or type', () => {
    expect(pickReceipt([{ mediaType: '', filename: 'a.txt', url: url('x') }])).toEqual({ state: 'none' });
    expect(pickReceipt([{ mediaType: '', url: url('x') }])).toEqual({ state: 'none' });
  });
});
