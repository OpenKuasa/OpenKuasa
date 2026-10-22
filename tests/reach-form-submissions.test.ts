import { describe, expect, it } from 'vitest';
import {
  HONEYPOT_FIELD,
  SUBMISSION_MESSAGES,
  formatSubmissionTime,
  malaysiaDay,
  mapFormSubmission,
  originFromHeaders,
  parseSubmission,
  publicFormPath,
  publicFormUrl,
  splitName,
  submissionOutcome,
  submissionsToday,
  submissionsTrend,
  submissionsTrendStart,
} from '@/lib/reach/form-submissions';

const ID = '11111111-1111-4111-8111-111111111111';
const typed = (over: Partial<Record<'name' | 'email' | 'phone' | 'message', string>> = {}) => ({
  name: 'Siti Aisyah',
  email: 'siti@example.com',
  phone: '',
  message: '',
  ...over,
});

describe('the public link', () => {
  it('is /f/ and the form id', () => {
    expect(publicFormPath(ID)).toBe(`/f/${ID}`);
  });

  it('joins onto the site address without doubling the slash', () => {
    expect(publicFormUrl('https://openkuasa.com', ID)).toBe(`https://openkuasa.com/f/${ID}`);
    expect(publicFormUrl('https://openkuasa.com/', ID)).toBe(`https://openkuasa.com/f/${ID}`);
    expect(publicFormUrl('http://localhost:3000', ID)).toBe(`http://localhost:3000/f/${ID}`);
  });

  it('reads the site address from the request, preferring what a proxy forwarded', () => {
    const from = (headers: Record<string, string>) =>
      originFromHeaders((name) => headers[name] ?? null);
    expect(from({ host: 'openkuasa.com' })).toBe('https://openkuasa.com');
    expect(from({ host: 'localhost:3982' })).toBe('http://localhost:3982');
    expect(from({ host: '127.0.0.1:3000' })).toBe('http://127.0.0.1:3000');
    expect(from({ host: 'internal:8080', 'x-forwarded-host': 'app.example.my', 'x-forwarded-proto': 'https' }))
      .toBe('https://app.example.my');
    expect(from({ host: 'app.example.my', 'x-forwarded-proto': 'http' })).toBe('http://app.example.my');
    // A proxy chain lists the outermost first.
    expect(from({ 'x-forwarded-host': 'a.example.my, b.internal', 'x-forwarded-proto': 'https, http' }))
      .toBe('https://a.example.my');
  });

  it('gives no address rather than a made-up one', () => {
    const from = (headers: Record<string, string>) =>
      originFromHeaders((name) => headers[name] ?? null);
    expect(from({})).toBeNull();
    expect(from({ host: 'evil.example/path?x=<script>' })).toBeNull();
    expect(from({ host: 'openkuasa.com', 'x-forwarded-proto': 'javascript' })).toBe('https://openkuasa.com');
  });
});

describe('parseSubmission', () => {
  it('accepts a name and an email, and tidies what was typed', () => {
    expect(parseSubmission(typed({ name: '  Siti   Nur\tAisyah ', email: ' Siti@Example.COM ', phone: ' 012  345 ', message: '  Hello\nthere  ' })))
      .toEqual({
        ok: true,
        input: { name: 'Siti Nur Aisyah', email: 'siti@example.com', phone: '012 345', message: 'Hello\nthere' },
      });
  });

  it('leaves the optional fields empty as null', () => {
    expect(parseSubmission(typed())).toEqual({
      ok: true,
      input: { name: 'Siti Aisyah', email: 'siti@example.com', phone: null, message: null },
    });
  });

  it('asks for a name and an email in words a person can act on', () => {
    expect(parseSubmission(typed({ name: '   ', email: '' }))).toEqual({
      ok: false,
      errors: { name: 'Enter your name.', email: 'Enter your email address.' },
    });
  });

  it('explains an email that is not one', () => {
    for (const email of ['siti', 'siti@', '@example.com', 'siti@example', 'si ti@example.com', 'a@b@c.com']) {
      expect(parseSubmission(typed({ email })), email).toEqual({
        ok: false,
        errors: { email: 'Enter an email address like name@example.com.' },
      });
    }
  });

  it('holds each field to its limit, and says what the limit is', () => {
    expect(parseSubmission(typed({ name: 'n'.repeat(120) })).ok).toBe(true);
    expect(parseSubmission(typed({ name: 'n'.repeat(121) }))).toEqual({
      ok: false,
      errors: { name: 'Keep your name to 120 characters or fewer.' },
    });
    const longEmail = `${'e'.repeat(249)}@b.com`;
    expect(longEmail).toHaveLength(255);
    expect(parseSubmission(typed({ email: longEmail }))).toEqual({
      ok: false,
      errors: { email: 'Keep the email address to 254 characters or fewer.' },
    });
    expect(parseSubmission(typed({ phone: '1'.repeat(40) })).ok).toBe(true);
    expect(parseSubmission(typed({ phone: '1'.repeat(41) }))).toEqual({
      ok: false,
      errors: { phone: 'Keep the phone number to 40 characters or fewer.' },
    });
    expect(parseSubmission(typed({ message: 'm'.repeat(2000) })).ok).toBe(true);
    expect(parseSubmission(typed({ message: 'm'.repeat(2001) }))).toEqual({
      ok: false,
      errors: { message: 'Keep the message to 2,000 characters or fewer.' },
    });
  });

  it('counts characters the way the database does, not UTF-16 units', () => {
    // 120 emoji are 240 UTF-16 units but 120 characters.
    expect(parseSubmission(typed({ name: '😀'.repeat(120) })).ok).toBe(true);
    expect(parseSubmission(typed({ name: '😀'.repeat(121) })).ok).toBe(false);
  });

  it('reports every field with a problem at once', () => {
    const parsed = parseSubmission({ name: '', email: 'x', phone: '1'.repeat(41), message: 'm'.repeat(2001) });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(Object.keys(parsed.errors).sort()).toEqual(['email', 'message', 'name', 'phone']);
  });

  it('has no exclamation marks in what it says', () => {
    for (const message of Object.values(SUBMISSION_MESSAGES)) expect(message).not.toContain('!');
  });
});

describe('splitName', () => {
  it('splits on the first space', () => {
    expect(splitName('Siti Nur Aisyah')).toEqual({ first: 'Siti', last: 'Nur Aisyah' });
    expect(splitName('Faiz Hakim')).toEqual({ first: 'Faiz', last: 'Hakim' });
  });
  it('keeps a single name whole', () => {
    expect(splitName('Madonna')).toEqual({ first: 'Madonna', last: null });
  });
  it('ignores extra spaces around and between the words', () => {
    expect(splitName('  Siti    Aisyah  ')).toEqual({ first: 'Siti', last: 'Aisyah' });
  });
});

describe('submissionOutcome', () => {
  it('reads each word the database answers with', () => {
    expect(submissionOutcome('ok')).toEqual({ kind: 'ok' });
    expect(submissionOutcome('not_found')).toEqual({ kind: 'not_found' });
    expect(submissionOutcome('closed')).toEqual({ kind: 'closed' });
    expect(submissionOutcome('throttled')).toEqual({ kind: 'throttled' });
  });
  it('puts a refused field beside its own message', () => {
    expect(submissionOutcome('invalid_name')).toEqual({ kind: 'invalid', errors: { name: 'Enter your name.' } });
    expect(submissionOutcome('name_too_long')).toEqual({
      kind: 'invalid', errors: { name: 'Keep your name to 120 characters or fewer.' },
    });
    expect(submissionOutcome('invalid_email')).toEqual({
      kind: 'invalid', errors: { email: 'Enter an email address like name@example.com.' },
    });
    expect(submissionOutcome('email_too_long')).toMatchObject({ kind: 'invalid', errors: { email: expect.any(String) } });
    expect(submissionOutcome('phone_too_long')).toMatchObject({ kind: 'invalid', errors: { phone: expect.any(String) } });
    expect(submissionOutcome('message_too_long')).toMatchObject({ kind: 'invalid', errors: { message: expect.any(String) } });
  });
  it('treats anything else as a failure, never as success', () => {
    for (const odd of [null, undefined, '', 'OK', 'yes', 1, {}, 'constructor', 'toString']) {
      expect(submissionOutcome(odd), String(odd)).toEqual({ kind: 'failed' });
    }
  });
});

describe('mapFormSubmission', () => {
  const row = { id: 's1', form_id: 'f1', contact_id: 'c1', created_at: '2026-10-10T01:00:00Z' };
  it('reads the four fields out of the payload', () => {
    expect(mapFormSubmission({ ...row, payload: { name: 'Siti', email: 'siti@example.com', phone: '012', message: 'Hi', extra: 'ignored' } }))
      .toEqual({
        ...row, name: 'Siti', email: 'siti@example.com', phone: '012', message: 'Hi',
        consent_text: null, consented_at: null,
      });
  });
  it('reads what was agreed to, and when', () => {
    const agreed = { consent_text: 'I agree that Kedai may keep these details.', consented_at: '2026-10-10T01:00:00Z' };
    expect(mapFormSubmission({ ...row, payload: {}, ...agreed })).toMatchObject(agreed);
  });
  it('shows no consent unless both the wording and the time are there', () => {
    for (const half of [
      { consent_text: 'Words only', consented_at: null },
      { consent_text: null, consented_at: '2026-10-10T01:00:00Z' },
      { consent_text: '', consented_at: '2026-10-10T01:00:00Z' },
    ]) {
      expect(mapFormSubmission({ ...row, payload: {}, ...half })).toMatchObject({ consent_text: null, consented_at: null });
    }
  });
  it('copes with a payload that is missing, empty or the wrong shape', () => {
    for (const payload of [null, undefined, 'text', 5, [], {}, { name: 5, email: null, phone: '', message: '  ' }]) {
      expect(mapFormSubmission({ ...row, contact_id: null, payload })).toEqual({
        ...row, contact_id: null, name: '', email: '', phone: null, message: null,
        consent_text: null, consented_at: null,
      });
    }
  });
});

describe('days are counted in Malaysia', () => {
  // 00:30 on 11 October in Kuala Lumpur, which is still 10 October in UTC.
  const now = new Date('2026-10-10T16:30:00Z');

  it('names the calendar day an instant falls on there', () => {
    expect(malaysiaDay(now)).toBe('2026-10-11');
    expect(malaysiaDay('2026-10-10T15:59:59Z')).toBe('2026-10-10');
    expect(malaysiaDay('2026-10-10T16:00:00Z')).toBe('2026-10-11');
    expect(malaysiaDay('not a date')).toBeNull();
  });

  it('counts as new today only what came in since midnight there', () => {
    const times = [
      '2026-10-10T16:00:00Z', // 00:00 on the 11th in Malaysia: today
      '2026-10-10T16:29:00Z', // today
      '2026-10-10T15:59:59Z', // 23:59 on the 10th: yesterday
      '2026-10-10T02:00:00Z', // yesterday, though the same UTC day as `now`
      '2026-10-11T16:00:00Z', // tomorrow
      'nonsense',
    ];
    expect(submissionsToday(times, now)).toBe(2);
    expect(submissionsToday([], now)).toBe(0);
  });

  it('starts the 14-day window at midnight there, 13 days back', () => {
    // 28 September 00:00 in Malaysia.
    expect(submissionsTrendStart(now)).toBe('2026-09-27T16:00:00.000Z');
    expect(submissionsTrendStart(now, 1)).toBe('2026-10-10T16:00:00.000Z');
  });

  it('gives fourteen days, oldest first, ending today, with empty days at zero', () => {
    const trend = submissionsTrend(
      [
        '2026-10-10T16:00:00Z', // 11 Oct
        '2026-10-10T16:10:00Z', // 11 Oct
        '2026-10-10T15:00:00Z', // 10 Oct
        '2026-09-27T16:00:00Z', // 28 Sep, the first day
        '2026-09-27T15:59:59Z', // 27 Sep, before the window
        '2026-10-11T16:00:00Z', // 12 Oct, after it
      ],
      now,
    );
    expect(trend).toHaveLength(14);
    // "Sep" or "Sept", depending on the runtime's locale data.
    expect(trend[0].label).toMatch(/^28 Sept?$/);
    expect(trend[0].submissions).toBe(1);
    expect(trend[12]).toEqual({ label: '10 Oct', submissions: 1 });
    expect(trend[13]).toEqual({ label: '11 Oct', submissions: 2 });
    expect(trend.slice(1, 12).every((day) => day.submissions === 0)).toBe(true);
    expect(trend.reduce((sum, day) => sum + day.submissions, 0)).toBe(4);
    expect(trend.map((day) => day.label).slice(3, 5)).toEqual(['1 Oct', '2 Oct']);
  });

  it('agrees with "new today" on the last point', () => {
    const times = ['2026-10-10T16:00:00Z', '2026-10-10T15:59:59Z', '2026-10-10T16:29:59Z'];
    expect(submissionsTrend(times, now).at(-1)?.submissions).toBe(submissionsToday(times, now));
  });

  it('writes a submission time in Malaysian time', () => {
    expect(formatSubmissionTime('2026-10-10T16:05:00Z')).toBe('11 Oct 2026, 00:05');
    expect(formatSubmissionTime('nonsense')).toBe('—');
  });
});

describe('the honeypot field', () => {
  it('is not a name a browser fills in for people', () => {
    for (const known of ['name', 'email', 'phone', 'tel', 'website', 'url', 'address', 'company', 'organization']) {
      expect(HONEYPOT_FIELD).not.toBe(known);
    }
  });
});
