// A failed model call's error carries the request it failed on: the chat, and any file the user attached.
// So a chat route may log a code or a class name, never the error itself.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamErrorHandler } from '@/lib/ai/call-log';

afterEach(() => vi.restoreAllMocks());

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === 'route.ts' && path.includes('chat') ? [path] : [];
  });
}

describe('streamErrorHandler', () => {
  it('answers with the sentence for the user and logs the tag and a code only', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = Object.assign(new Error('could not send Aisyah Rahman'), {
      name: 'AI_APICallError',
      statusCode: 502,
      requestBodyValues: { messages: [{ content: [{ file: { file_data: 'data:application/pdf;base64,JVBERi0=' } }] }] },
    });
    expect(streamErrorHandler('ask-jebat', 'Jebat ran into a problem.')(error)).toBe('Jebat ran into a problem.');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual(['[ask-jebat] stream error:', { code: 502 }]);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/JVBERi|Aisyah|requestBodyValues/);
  });

  it('copes with something that is not an error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(streamErrorHandler('ask-kasturi', 'Sorry.')('a string with a name in it')).toBe('Sorry.');
    expect(spy.mock.calls[0]).toEqual(['[ask-kasturi] stream error:', { code: undefined }]);
  });
});

describe('every chat route', () => {
  const files = routeFiles(join(process.cwd(), 'src/app/api'));

  it('is found', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files.map((file) => [file.slice(file.indexOf('src/')), file]))('%s never logs an error object', (_name, file) => {
    const source = readFileSync(file, 'utf8');
    // console.error('…', error) and console.error(error): the bare object, with whatever it carries.
    expect(source).not.toMatch(/console\.(error|warn|log)\(\s*(?:(?:'[^']*'|`[^`]*`|"[^"]*")\s*,\s*)?(error|err|e)\s*\)/);
  });
});
