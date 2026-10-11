import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'ai';
import { approvalSubject, approvalTitle } from '@/components/chat/tool-parts';
import { storedPathOf } from '@/lib/chat/attachment-store';
import { collapseResumes, storedParts } from '@/lib/chat/stored-parts';

describe('storedParts', () => {
  it('keeps words, finished lookups and changes waiting for an answer', () => {
    const parts = [
      { type: 'step-start' },
      { type: 'text', text: 'Let me check...' },
      {
        type: 'tool-getCampaigns',
        toolCallId: 'c1',
        state: 'output-available',
        input: {},
        output: [{ id: 'a', name: 'Raya Sale' }],
        callProviderMetadata: { secret: true },
      },
      {
        type: 'tool-deleteCampaign',
        toolCallId: 'c2',
        state: 'approval-requested',
        input: { id: 'a' },
        approval: { id: 'ap1' },
      },
    ];
    expect(storedParts(parts)).toEqual([
      { type: 'text', text: 'Let me check...' },
      {
        type: 'tool-getCampaigns',
        toolCallId: 'c1',
        state: 'output-available',
        input: {},
        output: [{ id: 'a', name: 'Raya Sale' }],
      },
      {
        type: 'tool-deleteCampaign',
        toolCallId: 'c2',
        state: 'approval-requested',
        input: { id: 'a' },
        approval: { id: 'ap1' },
      },
    ]);
  });

  it('drops what cannot be shown or answered later', () => {
    expect(
      storedParts([
        { type: 'text', text: '   ' },
        { type: 'reasoning', text: 'thinking' },
        { type: 'tool-getCampaigns', toolCallId: 'c1', state: 'input-streaming' },
        { type: 'tool-deleteCampaign', toolCallId: 'c2', state: 'approval-requested', input: {} },
        { type: 'tool-getCampaigns', state: 'output-available', output: [] },
        { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
        null,
      ]),
    ).toEqual([]);
    expect(storedParts('nope')).toEqual([]);
  });

  it('keeps a stored file by its path and never its data', () => {
    expect(
      storedParts([{ type: 'file', mediaType: 'image/png', filename: 'a.png', path: 'u/t/f', url: 'x' }]),
    ).toEqual([{ type: 'file', mediaType: 'image/png', filename: 'a.png', path: 'u/t/f' }]);
  });

  it('saves a CV read as the small answer it is: no file, no data, no path', async () => {
    // What the tool really returns, so this fails if the bytes ever ride in its result.
    const { createHireTools } = await import('@/lib/ai/hire-tools');
    const { createSeedHireData } = await import('@/lib/hire/seed');
    const bytes = new TextEncoder().encode('%PDF-1.4\nSENTINEL-CV-BODY\n');
    const cvPath = 'org-folder/job-folder/secret-file-name.pdf';
    const tools = createHireTools(createSeedHireData(), new Date(), undefined, undefined, {
      readCv: async () => ({ state: 'ok', bytes, candidate: 'Aisyah Rahman', job: 'Sales Executive' }),
    });
    const input = { applicationId: '11111111-1111-4111-8111-111111111111' };
    const output = await (
      tools.readCandidateCv as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }
    ).execute(input, { toolCallId: 'cv1', messages: [] });

    const part = { type: 'tool-readCandidateCv', toolCallId: 'cv1', state: 'output-available', input, output };
    const kept = storedParts([part]);
    expect(kept).toEqual([part]);
    expect(kept[0]).toMatchObject({ output: { ok: true, candidate: 'Aisyah Rahman', job: 'Sales Executive' } });
    const json = JSON.stringify(kept);
    expect(json).not.toContain('%PDF');
    expect(json).not.toContain('SENTINEL');
    expect(json).not.toContain(Buffer.from(bytes).toString('base64'));
    expect(json).not.toContain('data:');
    expect(json).not.toContain(cvPath);
    expect(json).not.toContain('"path"');
    expect(kept.some((p) => p.type === 'file')).toBe(false);
  });

  it('does not keep a very long result', () => {
    const [part] = storedParts([
      {
        type: 'tool-listContacts',
        toolCallId: 'c1',
        state: 'output-available',
        input: {},
        output: 'x'.repeat(40_000),
      },
    ]);
    expect((part as { output: unknown }).output).toEqual({ note: 'Result too long to keep.' });
  });
});

describe('collapseResumes', () => {
  it('keeps the finished answer of one that paused for an approval', () => {
    const rows = [
      { id: 1, role: 'user' as const },
      { id: 2, role: 'assistant' as const },
      { id: 3, role: 'assistant' as const },
      { id: 4, role: 'user' as const },
      { id: 5, role: 'assistant' as const },
    ];
    expect(collapseResumes(rows).map((r) => r.id)).toEqual([1, 3, 4, 5]);
  });
});

describe('approvalSubject', () => {
  const messages = [
    {
      parts: [
        {
          type: 'tool-getCampaigns',
          toolCallId: 'c1',
          state: 'output-available',
          input: {},
          output: [
            { id: 'a', name: 'Raya Sale' },
            { id: 'b', name: 'Brand Awareness' },
          ],
        },
      ],
    },
  ] as unknown as UIMessage[];

  it('names the item from an earlier listing', () => {
    expect(approvalSubject({ id: 'b' }, messages)).toBe('Brand Awareness');
    expect(approvalTitle('deleteCampaign', { id: 'b' }, 'Brand Awareness')).toBe(
      'Delete campaign “Brand Awareness”?',
    );
    expect(approvalTitle('setFormStatus', { id: 'f', status: 'paused' }, 'Contact us')).toBe(
      'Pause lead form “Contact us”?',
    );
  });

  it('names an item the assistant created earlier in the chat', () => {
    const created = [
      {
        parts: [
          {
            type: 'tool-createCampaign',
            toolCallId: 'c9',
            state: 'output-available',
            input: { name: 'Saved Card Check' },
            output: { ok: true, data: { id: 'n1', name: 'Saved Card Check' } },
          },
        ],
      },
    ] as unknown as UIMessage[];
    expect(approvalSubject({ id: 'n1' }, created)).toBe('Saved Card Check');
  });

  it('falls back to the plain wording when the name is not known', () => {
    expect(approvalSubject({ id: 'zzz' }, messages)).toBeNull();
    expect(approvalSubject({}, messages)).toBeNull();
    expect(approvalTitle('deleteCampaign', { id: 'zzz' }, null)).toBe('Delete this campaign?');
  });
});

describe('storedPathOf', () => {
  const user = '11111111-1111-4111-8111-111111111111';
  const path = `${user}/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333`;
  const base = 'https://project.supabase.co';
  afterEach(() => vi.unstubAllEnvs());

  it('reads the path out of a link to our own storage', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', base);
    expect(
      storedPathOf(`${base}/storage/v1/object/sign/chat-attachments/${path}?token=abc`, user),
    ).toBe(path);
  });

  it('refuses any other link, and anyone else’s folder', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', base);
    const other = '99999999-9999-4999-8999-999999999999';
    expect(storedPathOf(`https://evil.example/storage/v1/object/sign/chat-attachments/${path}`, user)).toBeNull();
    expect(storedPathOf(`${base}/storage/v1/object/sign/avatars/${path}?token=abc`, user)).toBeNull();
    expect(storedPathOf(`${base}/storage/v1/object/sign/chat-attachments/${path}?token=abc`, other)).toBeNull();
    expect(storedPathOf(`${base}/storage/v1/object/sign/chat-attachments/${user}/../x?token=a`, user)).toBeNull();
    expect(storedPathOf('http://169.254.169.254/latest/meta-data', user)).toBeNull();
  });
});
