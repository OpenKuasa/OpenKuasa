// tests/hire-interview-invite.test.ts
import { describe, expect, it } from 'vitest';
import { icsFileName, interviewIcs, invitationText, type InviteSource } from '@/lib/hire/interview-invite';
import { klInstant } from '@/lib/hire/interview-time';

const ID = '7f9c2a10-5b1e-4c3d-9a8e-2d6f4b1c0e55';
/** 3:00 pm on Tuesday 20 October 2026 in Kuala Lumpur, as the database writes it. */
const BASE: InviteSource = {
  id: ID, scheduled_at: '2026-10-20T07:00:00+00:00', duration_minutes: 60, kind: 'video',
  place: 'https://meet.example.com/abc', interviewer_name: 'Farah Lim',
  created_at: '2026-10-12T02:15:00+00:00', updated_at: '2026-10-12T02:15:00+00:00',
  candidate: 'Aina Rahman', job: 'Sales Executive', workspace: 'Rimba Ventures',
};
const text = (...lines: string[]) => lines.join('\n');
const CRLF = '\r\n';
/** The file's physical lines. The file ends with CRLF, so the last piece is empty and is dropped. */
const physical = (ics: string) => ics.split(CRLF).slice(0, -1);
/** The file with every folded line put back together. */
const unfold = (ics: string) => ics.replace(/\r\n /g, '');
const logical = (ics: string) => physical(unfold(ics));
const lineOf = (ics: string, name: string) => logical(ics).find((line) => line.startsWith(`${name}:`));

describe('invitationText', () => {
  it('is the agreed text, with every optional part', () => {
    expect(invitationText(BASE, false)).toBe(text(
      'Hi Aina Rahman,',
      '',
      'You are invited to an interview for the Sales Executive role at Rimba Ventures.',
      '',
      'Date: Tuesday, 20 October 2026',
      'Time: 3:00 pm to 4:00 pm, Kuala Lumpur time (GMT+8)',
      'Length: 1 hour',
      'Type: Video call',
      'Link: https://meet.example.com/abc',
      'With: Farah Lim',
      '',
      'Please reply to confirm, or tell us if you need another time.',
    ));
  });
  it('writes nothing in place of a part that is not there', () => {
    expect(invitationText({ ...BASE, place: null, interviewer_name: null }, false)).toBe(text(
      'Hi Aina Rahman,',
      '',
      'You are invited to an interview for the Sales Executive role at Rimba Ventures.',
      '',
      'Date: Tuesday, 20 October 2026',
      'Time: 3:00 pm to 4:00 pm, Kuala Lumpur time (GMT+8)',
      'Length: 1 hour',
      'Type: Video call',
      '',
      'Please reply to confirm, or tell us if you need another time.',
    ));
    // A blank is not a value.
    expect(invitationText({ ...BASE, place: '   ', interviewer_name: '' }, false)).toBe(invitationText({ ...BASE, place: null, interviewer_name: null }, false));
  });
  it('labels the place by the type', () => {
    expect(invitationText({ ...BASE, kind: 'onsite', place: 'Level 3, Menara Rimba', interviewer_name: null, duration_minutes: 45 }, false)).toBe(text(
      'Hi Aina Rahman,',
      '',
      'You are invited to an interview for the Sales Executive role at Rimba Ventures.',
      '',
      'Date: Tuesday, 20 October 2026',
      'Time: 3:00 pm to 3:45 pm, Kuala Lumpur time (GMT+8)',
      'Length: 45 minutes',
      'Type: In person',
      'Place: Level 3, Menara Rimba',
      '',
      'Please reply to confirm, or tell us if you need another time.',
    ));
    expect(invitationText({ ...BASE, kind: 'phone', place: 'We will call you', duration_minutes: 90 }, false)).toBe(text(
      'Hi Aina Rahman,',
      '',
      'You are invited to an interview for the Sales Executive role at Rimba Ventures.',
      '',
      'Date: Tuesday, 20 October 2026',
      'Time: 3:00 pm to 4:30 pm, Kuala Lumpur time (GMT+8)',
      'Length: 1 hour 30 minutes',
      'Type: Phone call',
      'Details: We will call you',
      'With: Farah Lim',
      '',
      'Please reply to confirm, or tell us if you need another time.',
    ));
  });
  it('says the time is new after a move', () => {
    expect(invitationText({ ...BASE, scheduled_at: '2026-10-22T03:00:00+00:00' }, true)).toBe(text(
      'Hi Aina Rahman,',
      '',
      'Your interview for the Sales Executive role at Rimba Ventures has a new time.',
      '',
      'Date: Thursday, 22 October 2026',
      'Time: 11:00 am to 12:00 pm, Kuala Lumpur time (GMT+8)',
      'Length: 1 hour',
      'Type: Video call',
      'Link: https://meet.example.com/abc',
      'With: Farah Lim',
      '',
      'Please reply to confirm, or tell us if you need another time.',
    ));
  });
  it('leaves the workspace out when it has no name', () => {
    for (const workspace of [null, '', '   ']) {
      expect(invitationText({ ...BASE, workspace, place: null, interviewer_name: null }, false)).toBe(text(
        'Hi Aina Rahman,',
        '',
        'You are invited to an interview for the Sales Executive role.',
        '',
        'Date: Tuesday, 20 October 2026',
        'Time: 3:00 pm to 4:00 pm, Kuala Lumpur time (GMT+8)',
        'Length: 1 hour',
        'Type: Video call',
        '',
        'Please reply to confirm, or tell us if you need another time.',
      ));
    }
    expect(invitationText({ ...BASE, workspace: null }, true).split('\n')[2]).toBe('Your interview for the Sales Executive role has a new time.');
  });
  it('says when the interview ends the next day', () => {
    expect(invitationText({ ...BASE, scheduled_at: klInstant('2026-10-20', '23:30')!, place: null, interviewer_name: null }, false)).toBe(text(
      'Hi Aina Rahman,',
      '',
      'You are invited to an interview for the Sales Executive role at Rimba Ventures.',
      '',
      'Date: Tuesday, 20 October 2026',
      'Time: 11:30 pm to 12:30 am the next day, Kuala Lumpur time (GMT+8)',
      'Length: 1 hour',
      'Type: Video call',
      '',
      'Please reply to confirm, or tell us if you need another time.',
    ));
  });
  it('is the same for the same row, whatever zone the process is in', () => {
    const before = process.env.TZ;
    const here = invitationText(BASE, false);
    try {
      for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
        process.env.TZ = zone;
        expect(invitationText(BASE, false), zone).toBe(here);
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

describe('interviewIcs', () => {
  it('is exactly this file for this row', () => {
    expect(interviewIcs(BASE)).toBe(
      'BEGIN:VCALENDAR\r\n'
      + 'VERSION:2.0\r\n'
      + 'PRODID:-//OpenKuasa//Lekir//EN\r\n'
      + 'CALSCALE:GREGORIAN\r\n'
      + 'METHOD:PUBLISH\r\n'
      + 'BEGIN:VEVENT\r\n'
      + 'UID:7f9c2a10-5b1e-4c3d-9a8e-2d6f4b1c0e55@openkuasa.com\r\n'
      + 'DTSTAMP:20261012T021500Z\r\n'
      + 'SEQUENCE:0\r\n'
      + 'DTSTART:20261020T070000Z\r\n'
      + 'DTEND:20261020T080000Z\r\n'
      + 'SUMMARY:Interview for Sales Executive at Rimba Ventures\r\n'
      + 'LOCATION:https://meet.example.com/abc\r\n'
      + 'DESCRIPTION:Candidate: Aina Rahman\\nType: Video call\\nWith: Farah Lim\r\n'
      + 'STATUS:CONFIRMED\r\n'
      + 'END:VEVENT\r\n'
      + 'END:VCALENDAR\r\n',
    );
  });
  it('ends every line, and the file, with CRLF and has no bare line break', () => {
    for (const row of [BASE, { ...BASE, place: `https://meet.example.com/${'a'.repeat(175)}` }]) {
      const ics = interviewIcs(row);
      expect(ics.endsWith(CRLF)).toBe(true);
      const rest = ics.split(CRLF).join('');
      expect(rest).not.toContain('\n');
      expect(rest).not.toContain('\r');
    }
  });
  it('writes the three times in UTC, ending in Z: 15:00 in Kuala Lumpur is 070000Z', () => {
    const ics = interviewIcs({ ...BASE, scheduled_at: klInstant('2026-10-20', '15:00')!, duration_minutes: 90 });
    expect(lineOf(ics, 'DTSTART')).toBe('DTSTART:20261020T070000Z');
    expect(lineOf(ics, 'DTEND')).toBe('DTEND:20261020T083000Z');
    expect(lineOf(ics, 'DTSTAMP')).toBe('DTSTAMP:20261012T021500Z');
    expect(ics).not.toContain('TZID');
    // Midnight in Kuala Lumpur is the day before in UTC, and an interview can end on the next UTC day.
    const late = interviewIcs({ ...BASE, scheduled_at: klInstant('2026-10-20', '00:00')!, duration_minutes: 480 });
    expect(lineOf(late, 'DTSTART')).toBe('DTSTART:20261019T160000Z');
    expect(lineOf(late, 'DTEND')).toBe('DTEND:20261020T000000Z');
  });
  it('gives the same file whatever zone the process is in', () => {
    const before = process.env.TZ;
    const here = interviewIcs(BASE);
    try {
      for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
        process.env.TZ = zone;
        expect(interviewIcs(BASE), zone).toBe(here);
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
  it('keeps the UID when the time changes, so a calendar updates its entry instead of adding one', () => {
    const moved = interviewIcs({ ...BASE, scheduled_at: '2026-10-22T03:00:00+00:00', updated_at: '2026-10-12T03:15:30+00:00' });
    expect(lineOf(interviewIcs(BASE), 'UID')).toBe(`UID:${ID}@openkuasa.com`);
    expect(lineOf(moved, 'UID')).toBe(`UID:${ID}@openkuasa.com`);
    expect(lineOf(moved, 'DTSTART')).toBe('DTSTART:20261022T030000Z');
  });
  it('numbers a new row 0 and a changed one higher, by whole seconds since it was made', () => {
    expect(lineOf(interviewIcs(BASE), 'SEQUENCE')).toBe('SEQUENCE:0');
    expect(lineOf(interviewIcs({ ...BASE, updated_at: '2026-10-12T03:15:30+00:00' }), 'SEQUENCE')).toBe('SEQUENCE:3630');
    expect(lineOf(interviewIcs({ ...BASE, updated_at: '2026-10-12T03:15:31+00:00' }), 'SEQUENCE')).toBe('SEQUENCE:3631');
    // Part of a second is not a change, and a clock that ran backwards never gives a negative number.
    expect(lineOf(interviewIcs({ ...BASE, updated_at: '2026-10-12T02:15:00.900+00:00' }), 'SEQUENCE')).toBe('SEQUENCE:0');
    expect(lineOf(interviewIcs({ ...BASE, updated_at: '2026-10-12T02:14:00+00:00' }), 'SEQUENCE')).toBe('SEQUENCE:0');
    expect(lineOf(interviewIcs({ ...BASE, updated_at: 'nonsense' }), 'SEQUENCE')).toBe('SEQUENCE:0');
  });
  it('escapes a comma, a semicolon, a backslash and a line break', () => {
    const ics = interviewIcs({ ...BASE, job: 'Sales, Marketing; R\\D\nLead', place: 'Level 3, Menara Rimba; Jalan A\\B' });
    expect(lineOf(ics, 'SUMMARY')).toBe('SUMMARY:Interview for Sales\\, Marketing\\; R\\\\D\\nLead at Rimba Ventures');
    expect(lineOf(ics, 'LOCATION')).toBe('LOCATION:Level 3\\, Menara Rimba\\; Jalan A\\\\B');
    expect(lineOf(interviewIcs({ ...BASE, candidate: 'Tan, Mei Ling', interviewer_name: 'Lim; Farah' }), 'DESCRIPTION'))
      .toBe('DESCRIPTION:Candidate: Tan\\, Mei Ling\\nType: Video call\\nWith: Lim\\; Farah');
  });
  it('drops a carriage return and every other control character', () => {
    const ics = interviewIcs({ ...BASE, place: 'Level 3,\r\nMenara Rimba\u0007 Jalan\tA\u0000B\u007f' });
    expect(lineOf(ics, 'LOCATION')).toBe('LOCATION:Level 3\\,\\nMenara Rimba JalanAB');
    for (const control of ['\u0007', '\t', '\u0000', '\u007f']) expect(ics).not.toContain(control);
    // The only carriage returns left are the ones that end lines.
    expect(ics.split(CRLF).join('')).not.toContain('\r');
  });
  it('folds a 200-character link so that no line is over 75 octets, and unfolding gives it back', () => {
    const place = `https://meet.example.com/${'a'.repeat(175)}`;
    expect(place).toHaveLength(200);
    const ics = interviewIcs({ ...BASE, place });
    for (const line of physical(ics)) expect(Buffer.byteLength(line, 'utf8'), line).toBeLessThanOrEqual(75);
    const folded = physical(ics).filter((line) => line.startsWith(' '));
    expect(folded).toHaveLength(2);
    expect(lineOf(ics, 'LOCATION')).toBe(`LOCATION:${place}`);
    // The first line of a folded value is full: 75 octets, then the rest follows a single space.
    expect(Buffer.byteLength(physical(ics).find((line) => line.startsWith('LOCATION:'))!, 'utf8')).toBe(75);
  });
  it('folds a long name of several octets a character without cutting one, and unfolding gives it back', () => {
    // Four octets (outside the basic plane), three, two and one to a character, mixed.
    const name = '𠮷野家 Nguyễn Thị Ánh '.repeat(8).trim();
    const ics = interviewIcs({ ...BASE, candidate: name, job: name });
    for (const line of physical(ics)) {
      expect(Buffer.byteLength(line, 'utf8'), line).toBeLessThanOrEqual(75);
      // A line cut inside a character would not survive being written out and read back.
      expect(Buffer.from(line, 'utf8').toString('utf8')).toBe(line);
    }
    expect(physical(ics).filter((line) => line.startsWith(' ')).length).toBeGreaterThan(2);
    expect(lineOf(ics, 'DESCRIPTION')).toBe(`DESCRIPTION:Candidate: ${name}\\nType: Video call\\nWith: Farah Lim`);
    expect(lineOf(ics, 'SUMMARY')).toBe(`SUMMARY:Interview for ${name} at Rimba Ventures`);
  });
  it('has no LOCATION line when there is no place, and no With line when there is no interviewer', () => {
    for (const place of [null, '', '   ']) {
      const ics = interviewIcs({ ...BASE, place, interviewer_name: null });
      expect(lineOf(ics, 'LOCATION')).toBeUndefined();
      expect(lineOf(ics, 'DESCRIPTION')).toBe('DESCRIPTION:Candidate: Aina Rahman\\nType: Video call');
    }
  });
  it('leaves the workspace out of the summary when it has no name', () => {
    expect(lineOf(interviewIcs({ ...BASE, workspace: null }), 'SUMMARY')).toBe('SUMMARY:Interview for Sales Executive');
    expect(lineOf(interviewIcs({ ...BASE, workspace: '  ' }), 'SUMMARY')).toBe('SUMMARY:Interview for Sales Executive');
  });
  it('never carries the notes, even when the row it was given has them', () => {
    const withNotes = { ...BASE, notes: 'Salary was the sticking point last time' } as InviteSource;
    expect(interviewIcs(withNotes)).not.toContain('Salary');
    expect(invitationText(withNotes, false)).not.toContain('Salary');
  });
  it('is a published event with no attendee and no organiser', () => {
    const ics = interviewIcs(BASE);
    expect(logical(ics)).toContain('METHOD:PUBLISH');
    expect(logical(ics)).toContain('STATUS:CONFIRMED');
    expect(ics).not.toContain('METHOD:REQUEST');
    expect(ics).not.toContain('ATTENDEE');
    expect(ics).not.toContain('ORGANIZER');
    expect(logical(ics).filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(1);
  });
  it('says the type in words for each type', () => {
    expect(lineOf(interviewIcs({ ...BASE, kind: 'onsite', interviewer_name: null }), 'DESCRIPTION')).toBe('DESCRIPTION:Candidate: Aina Rahman\\nType: In person');
    expect(lineOf(interviewIcs({ ...BASE, kind: 'phone', interviewer_name: null }), 'DESCRIPTION')).toBe('DESCRIPTION:Candidate: Aina Rahman\\nType: Phone call');
  });
});

describe('icsFileName', () => {
  it('is the name in lower case with hyphens, then the Kuala Lumpur date', () => {
    expect(icsFileName(BASE)).toBe('interview-aina-rahman-2026-10-20.ics');
  });
  it('turns marks, spaces and punctuation into single hyphens, with none at either end', () => {
    // The é is written as an escape so the test does not depend on how an editor saves it.
    expect(icsFileName({ ...BASE, candidate: '  Ren\u00e9e  O\'Neil-Tan (2) ' })).toBe('interview-ren-e-o-neil-tan-2-2026-10-20.ics');
  });
  it('is the date alone for a name with no Latin letters or digits', () => {
    expect(icsFileName({ ...BASE, candidate: '陳大文' })).toBe('interview-2026-10-20.ics');
    expect(icsFileName({ ...BASE, candidate: '' })).toBe('interview-2026-10-20.ics');
  });
  it('uses the date in Kuala Lumpur, not in UTC', () => {
    // 00:30 on 21 October in Kuala Lumpur is still the 20th in UTC.
    expect(icsFileName({ ...BASE, scheduled_at: '2026-10-20T16:30:00+00:00' })).toBe('interview-aina-rahman-2026-10-21.ics');
  });
});

// ─── boundaries beyond the plan's own tests ──────────────────────────────────

describe('the calendar file at the edges', () => {
  it('reads the six decimal places the database writes on its two stamps', () => {
    const ics = interviewIcs({ ...BASE, created_at: '2026-10-12T02:15:00.250000+00:00', updated_at: '2026-10-12T03:15:30.750000+00:00' });
    expect(lineOf(ics, 'DTSTAMP')).toBe('DTSTAMP:20261012T031530Z');
    expect(lineOf(ics, 'SEQUENCE')).toBe('SEQUENCE:3630');
  });
  it('is right across a year and on 29 February: the times are UTC, the file name and the invitation Kuala Lumpur', () => {
    // 12:15 am on 1 January 2027 in Kuala Lumpur.
    const newYear = { ...BASE, scheduled_at: klInstant('2027-01-01', '00:15')!, duration_minutes: 45 };
    expect(lineOf(interviewIcs(newYear), 'DTSTART')).toBe('DTSTART:20261231T161500Z');
    expect(lineOf(interviewIcs(newYear), 'DTEND')).toBe('DTEND:20261231T170000Z');
    expect(icsFileName(newYear)).toBe('interview-aina-rahman-2027-01-01.ics');
    expect(invitationText(newYear, false).split('\n').slice(4, 6)).toEqual(['Date: Friday, 1 January 2027', 'Time: 12:15 am to 1:00 am, Kuala Lumpur time (GMT+8)']);
    // 11:30 pm on 31 December 2026: ends in the new year in Kuala Lumpur, all inside 31 December in UTC.
    const eve = { ...BASE, scheduled_at: klInstant('2026-12-31', '23:30')! };
    expect(lineOf(interviewIcs(eve), 'DTSTART')).toBe('DTSTART:20261231T153000Z');
    expect(lineOf(interviewIcs(eve), 'DTEND')).toBe('DTEND:20261231T163000Z');
    expect(invitationText(eve, false).split('\n').slice(4, 6)).toEqual(['Date: Thursday, 31 December 2026', 'Time: 11:30 pm to 12:30 am the next day, Kuala Lumpur time (GMT+8)']);
    const leap = { ...BASE, scheduled_at: klInstant('2028-02-29', '00:00')! };
    expect(lineOf(interviewIcs(leap), 'DTSTART')).toBe('DTSTART:20280228T160000Z');
    expect(lineOf(interviewIcs(leap), 'DTEND')).toBe('DTEND:20280228T170000Z');
    expect(icsFileName(leap)).toBe('interview-aina-rahman-2028-02-29.ics');
    expect(invitationText(leap, false).split('\n')[4]).toBe('Date: Tuesday, 29 February 2028');
    const lastMinute = { ...BASE, scheduled_at: klInstant('2028-02-29', '23:59')!, duration_minutes: 15 };
    expect(lineOf(interviewIcs(lastMinute), 'DTSTART')).toBe('DTSTART:20280229T155900Z');
    expect(lineOf(interviewIcs(lastMinute), 'DTEND')).toBe('DTEND:20280229T161400Z');
  });
  it('gives the same instant for the same start however it is written', () => {
    const asUtc = interviewIcs({ ...BASE, scheduled_at: '2026-10-20T07:00:00Z' });
    const asKl = interviewIcs({ ...BASE, scheduled_at: '2026-10-20T15:00:00+08:00' });
    expect(asKl).toBe(asUtc);
    expect(asKl).toBe(interviewIcs(BASE));
  });
  it('never makes up a time for a start with no zone of its own, in any zone', () => {
    const before = process.env.TZ;
    try {
      for (const zone of ['UTC', 'America/New_York', 'Asia/Kuala_Lumpur']) {
        process.env.TZ = zone;
        const ics = interviewIcs({ ...BASE, scheduled_at: '2026-10-20T15:00:00' });
        expect(lineOf(ics, 'DTSTART'), zone).toBe('DTSTART:');
        expect(lineOf(ics, 'DTEND'), zone).toBe('DTEND:');
        expect(invitationText({ ...BASE, scheduled_at: '2026-10-20T15:00:00' }, false).split('\n').slice(4, 6), zone)
          .toEqual(['Date: 2026-10-20T15:00:00', 'Time: 2026-10-20T15:00:00, Kuala Lumpur time (GMT+8)']);
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
  it('does not fold a line of exactly 75 octets, and folds one of 76', () => {
    // "SUMMARY:Interview for " is 22 octets.
    const exact = interviewIcs({ ...BASE, workspace: null, job: 'x'.repeat(53) });
    expect(physical(exact)).toContain(`SUMMARY:Interview for ${'x'.repeat(53)}`);
    const over = physical(interviewIcs({ ...BASE, workspace: null, job: 'x'.repeat(54) }));
    const at = over.indexOf(`SUMMARY:Interview for ${'x'.repeat(53)}`);
    expect(at).toBeGreaterThan(-1);
    expect(over[at + 1]).toBe(' x');
  });
  it('moves a two-octet character that would straddle the 75th octet whole to the next line', () => {
    // 22 + 52 = 74 octets, then a character of two.
    const lines = physical(interviewIcs({ ...BASE, workspace: null, job: `${'x'.repeat(52)}éz` }));
    const at = lines.indexOf(`SUMMARY:Interview for ${'x'.repeat(52)}`);
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe(' éz');
    expect(Buffer.byteLength(lines[at], 'utf8')).toBe(74);
  });
  it('folds a continuation line at 75 octets too, its leading space counted', () => {
    const lines = physical(interviewIcs({ ...BASE, workspace: null, job: 'x'.repeat(53 + 74 + 1) }));
    const at = lines.indexOf(`SUMMARY:Interview for ${'x'.repeat(53)}`);
    expect(lines.slice(at + 1, at + 3)).toEqual([` ${'x'.repeat(74)}`, ' x']);
  });
  it('escapes before it folds, so an escape is never cut from what it escapes by more than a fold', () => {
    const job = `${'x'.repeat(52)},y`;
    const ics = interviewIcs({ ...BASE, workspace: null, job });
    expect(lineOf(ics, 'SUMMARY')).toBe(`SUMMARY:Interview for ${'x'.repeat(52)}\\,y`);
    for (const line of physical(ics)) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
  });
});
