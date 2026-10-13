// tests/hire-browser-only.test.ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText, downloadTextFile } from '@/screens/hire/browser-only';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('copyText', () => {
  it('writes the text to the clipboard and answers true', async () => {
    const written: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: async (text: string) => { written.push(text); } } });
    expect(await copyText('Hi Aina Rahman,\n\nYou are invited.')).toBe(true);
    expect(written).toEqual(['Hi Aina Rahman,\n\nYou are invited.']);
  });
  it('answers false, and never throws, when the browser refuses or has no clipboard', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } });
    expect(await copyText('x')).toBe(false);
    vi.stubGlobal('navigator', { clipboard: { writeText: () => { throw new Error('thrown at once'); } } });
    expect(await copyText('x')).toBe(false);
    // A page that is not served securely has no `navigator.clipboard` at all.
    vi.stubGlobal('navigator', {});
    expect(await copyText('x')).toBe(false);
    vi.stubGlobal('navigator', undefined);
    expect(await copyText('x')).toBe(false);
  });
});

describe('downloadTextFile', () => {
  it('clicks a temporary link to a blob of that text and type, named as asked, and lets go of the blob afterwards', async () => {
    vi.useFakeTimers();
    const blobs: Blob[] = [];
    const made = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return 'blob:test';
    });
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const link = { href: '', download: '', hidden: false, click: vi.fn(), remove: vi.fn() };
    const appended: unknown[] = [];
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        expect(tag).toBe('a');
        return link;
      },
      body: { appendChild: (node: unknown) => { appended.push(node); } },
    });

    downloadTextFile('interview-aina-rahman-2026-10-20.ics', 'text/calendar;charset=utf-8', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');

    expect(made).toHaveBeenCalledTimes(1);
    expect(blobs[0].type).toBe('text/calendar;charset=utf-8');
    expect(await blobs[0].text()).toBe('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
    expect(link).toMatchObject({ href: 'blob:test', download: 'interview-aina-rahman-2026-10-20.ics', hidden: true });
    expect(appended).toEqual([link]);
    expect(link.click).toHaveBeenCalledTimes(1);
    expect(link.remove).toHaveBeenCalledTimes(1);
    // Not at once: a browser may start the download a moment after the click.
    expect(revoked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoked).toHaveBeenCalledWith('blob:test');
  });
});

describe('where the browser\'s clipboard and downloads are touched', () => {
  it('nowhere in the interview and application files but browser-only.ts', () => {
    const root = process.cwd();
    const files = [
      ...readdirSync(join(root, 'src/screens/hire')).map((name) => join('src/screens/hire', name)),
      ...readdirSync(join(root, 'src/lib/hire')).map((name) => join('src/lib/hire', name)),
    ].filter((path) => /\/(interview|application)[^/]*\.tsx?$/.test(path));
    // The four files this piece writes are among them, or this test checks nothing.
    expect(files).toEqual(expect.arrayContaining([
      'src/screens/hire/interview-dialog.tsx', 'src/screens/hire/interview-actions.tsx', 'src/screens/hire/interviews.tsx',
      'src/lib/hire/interview-dialog-state.ts', 'src/lib/hire/interview-invite.ts',
    ]));
    for (const path of files) {
      expect(readFileSync(join(root, path), 'utf8'), path).not.toMatch(/navigator\.clipboard|createObjectURL|new Blob\(|\.download\s*=|document\.createElement/);
    }
    // Final-review fix pass. The invitation and the calendar file are made on the server, from the interview as stored
    // at the press. No screen file imports or calls the builders, or makes their source out of a row: a row can be stale.
    const screens = readdirSync(join(root, 'src/screens/hire')).map((name) => join('src/screens/hire', name));
    expect(screens).toEqual(expect.arrayContaining(['src/screens/hire/interview-dialog.tsx', 'src/screens/hire/interview-actions.tsx']));
    for (const path of [...screens, 'src/lib/hire/interview-dialog-state.ts']) {
      expect(readFileSync(join(root, path), 'utf8'), path)
        .not.toMatch(/interview-invite|invitationText|interviewIcs|icsFileName|inviteSourceOf|InviteSource|calendarOfChange/);
    }
    // The builders are called in one file, which only the server runs.
    const callers = [
      ...readdirSync(join(root, 'src/lib/hire')).map((name) => join('src/lib/hire', name)),
    ].filter((path) => /\.tsx?$/.test(path) && /\b(interviewIcs|icsFileName)\(/.test(readFileSync(join(root, path), 'utf8')));
    expect(callers.sort()).toEqual(['src/lib/hire/capabilities.ts', 'src/lib/hire/interview-invite.ts']);
    const only = readFileSync(join(root, 'src/screens/hire/browser-only.ts'), 'utf8');
    expect(only).toMatch(/navigator\.clipboard/);
    expect(only).toMatch(/createObjectURL/);
    // Nothing is uploaded or fetched: the file is made from text already on the page.
    expect(only).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon/);
  });
});
