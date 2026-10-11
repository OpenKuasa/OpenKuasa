// tests/ai-call-log.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logModelError, modelErrorCode } from '@/lib/ai/call-log';

/** Shaped like the SDK's APICallError: the request it failed on rides along, files and all. */
const apiError = () =>
  Object.assign(new Error('The provider could not process the CV of Aisyah Rahman.'), {
    name: 'AI_APICallError',
    statusCode: 500,
    url: 'https://provider.example/v1/chat/completions',
    requestBodyValues: {
      messages: [{ content: [{ file: { file_data: 'data:application/pdf;base64,JVBERi0=' } }] }],
    },
    responseBody: '{"error":"internal"}',
  });

afterEach(() => vi.restoreAllMocks());

describe('modelErrorCode', () => {
  it('gives the status of a failed provider call and nothing else of it', () => {
    const code = modelErrorCode(apiError());
    expect(code).toEqual({ code: 500 });
    expect(Reflect.ownKeys(code)).toEqual(['code']);
    const json = JSON.stringify(code);
    expect(json).not.toContain('JVBERi0');
    expect(json).not.toContain('Aisyah');
  });

  it('falls back to an error’s own code, then to its name', () => {
    expect(modelErrorCode(Object.assign(new Error('socket hang up on /a/path.pdf'), { code: 'ECONNRESET' }))).toEqual({
      code: 'ECONNRESET',
    });
    expect(modelErrorCode(new Error('something about Aisyah Rahman'))).toEqual({ code: 'Error' });
    expect(modelErrorCode(new TypeError('bad'))).toEqual({ code: 'TypeError' });
  });

  it('cuts a string code to 64 characters', () => {
    const long = 'x'.repeat(200);
    const got = modelErrorCode(Object.assign(new Error('boom'), { code: long }));
    expect(got).toEqual({ code: 'x'.repeat(64) });
    expect((got.code as string).length).toBe(64);
  });

  it('answers for a value that is no error at all', () => {
    expect(modelErrorCode(null)).toEqual({ code: undefined });
    expect(modelErrorCode(undefined)).toEqual({ code: undefined });
    expect(modelErrorCode('a string naming Aisyah Rahman')).toEqual({ code: undefined });
  });
});

describe('logModelError', () => {
  it('logs who failed and the code, never the error', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    logModelError('lekir')({ error: apiError() });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[ai] lekir model call failed:', { code: 500 });
  });
});
