import { describe, expect, it } from 'vitest';
import { messageLanguage, type MessageLanguage } from '@/lib/ai/message-language';

/**
 * Which language a chat message is in, as the server decides it. Each row says why. The first block is the real
 * conversations in which the reply came back in the wrong language.
 */
const TABLE: [string, MessageLanguage, string][] = [
  // The real turns.
  ['Tunjukkan semua semakan prestasi untuk Member Check (test).', 'ms', 'Malay frame; the name and "(test)" count for nothing'],
  ['Pull the H1 2026 review for Member Check (test) back to draft.', 'en', 'the turn that was declined in Bahasa Malaysia'],
  ['Berapa orang pekerja dalam syarikat ini?', 'ms', 'all Malay'],
  ['Sediakan surat pengesahan jawatan untuk Member Check (test) guna templat.', 'ms', 'the Malay turn before the second slip'],
  ['Change our company logo to the new one.', 'en', 'the second turn declined in Bahasa Malaysia'],
  ['Show me a quick summary of this month.', 'en', 'the English turn that passed'],

  // Rojak: the grammar decides, English work terms decide nothing.
  ['Boleh check leave balance saya?', 'ms', 'a Malay sentence around English HR terms: answered in Bahasa Malaysia, terms kept'],
  ['Berapa OT claim yang pending?', 'ms', 'Malay question words, English nouns'],
  ['Claim tu dah approve ke belum?', 'ms', 'colloquial particles'],
  ['Please approve cuti saya', 'either', 'one English word against two Malay ones: too close to call'],
  ['Berapa OT claim yang pending for this month?', 'either', 'two against two'],
  ['Tolong show me the claims for Ali', 'en', 'an English sentence that opens with one Malay word'],

  // Names do not decide.
  ["Show me Siti Aminah's claims", 'en', 'a Malay name in an English sentence'],
  ['Siti Aminah', 'either', 'a name alone'],
  ["Show me Dan's leave", 'en', '"Dan" with a capital is a person, not the Malay "and"'],
  ["show me dan's leave", 'either', 'typed without the capital it could be the Malay word: not called'],
  ['Luluskan cuti Will dan May', 'ms', '"Will" and "May" with capitals are people'],

  // Thin evidence.
  ['ok', 'either', 'one word'],
  ['thanks', 'either', 'one word, and one that Malay speakers use too'],
  ['thank you', 'either', 'used by everyone in Malaysia: not evidence of English'],
  ['terima kasih', 'ms', 'two Malay words nobody uses in English'],
  ['Terima kasih!', 'ms', 'the same, as typed'],
  ['1234', 'either', 'a number'],
  ['', 'either', 'nothing'],
  ['   ', 'either', 'spaces'],
  ['RM 6.88', 'either', 'an amount'],
  ['你好，请问我的假期还有几天？', 'either', 'another language altogether: the assistant’s own rule decides'],
  ['cuti', 'either', 'one Malay word'],
  ['TOLONG LULUSKAN CUTI SAYA', 'ms', 'all capitals are words, not names'],
  ['Show Me The Leave Balance', 'either', 'every word capitalised: nothing left to count, so not called'],

  // An instruction, then material in the other language: the instruction is the person speaking.
  ['Translate this: Dengan hormatnya saya ingin memohon cuti tanpa gaji selama dua minggu kerana urusan keluarga.', 'en', 'the request is English ("translate", "this"); the Malay paste after the colon is not the person speaking'],
  ['Translate: Dengan hormatnya saya ingin memohon cuti tanpa gaji selama dua minggu kerana urusan keluarga.', 'either', 'a one-word English request, a Malay paste: never called Malay, too thin to call English'],
  ['Please translate this letter to English:\nDengan hormatnya saya ingin memohon cuti tanpa gaji selama dua minggu.', 'en', 'a clear English request; the paste is not the person speaking'],
  ['Tolong semak surat ini:\nDear Sir, I would like to apply for two weeks of unpaid leave from the first of the month.', 'ms', 'a clear Malay request above an English paste'],
  ['Translate this dengan hormatnya saya ingin memohon cuti tanpa gaji selama dua minggu kerana urusan keluarga', 'either', 'the same request with no colon'],
  ['Terjemahkan: I would like to apply for two weeks of unpaid leave from the first of the month.', 'either', 'a one-word Malay request, an English paste'],
  ['Hi,\nboleh saya tahu baki cuti saya?', 'ms', 'a greeting on the first line says nothing; the question decides'],
  ['Mesyuarat pukul 10:30, boleh tukar ke pukul 3:00 petang?', 'ms', 'a colon inside a time is not an instruction'],

  // Asking for the reply in a language: the person has said it, so the server does not.
  ['reply in malay please', 'either', 'an explicit request for the reply\'s language'],
  ['jawab dalam English', 'either', 'the same, asked in Bahasa Malaysia'],
  ['can you reply dalam BM', 'either', 'rojak request for the reply\'s language'],
  ['Reply in English: berapa baki cuti saya?', 'either', 'the request names the language; the question after it does not decide'],
  ['Write a warning letter for Ahmad in Bahasa Malaysia', 'en', 'asks for a document in a language, not for the reply in it'],

  // A Malay opening word with many English words after it is rojak, not English.
  ['nak tengok the report for all the staff that are on leave', 'either', 'a Malay opening with English after it'],
  ['Tunjuk all the leads from Facebook that have not been contacted', 'either', 'a Malay opening verb, then English'],
  ['Saya on leave from Monday to Friday for a family matter in Johor', 'either', 'a Malay pronoun, then English'],

];

describe('the language of a chat message, decided by the server', () => {
  it.each(TABLE)('%j is %s (%s)', (text, expected) => {
    expect(messageLanguage(text)).toBe(expected);
  });

  it('reads only the start of a very long message, in time that does not grow with the paste', () => {
    const paste = 'Please summarise the letter for me:\n' + 'saya ingin memohon cuti '.repeat(200_000);
    const started = performance.now();
    expect(messageLanguage(paste)).toBe('en');
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('trims blank space before it cuts the message to the part that is read', () => {
    expect(messageLanguage(' '.repeat(5000) + 'Berapa orang pekerja dalam syarikat ini?')).toBe('ms');
  });

  it('does not slow down on a long run of one character', () => {
    const started = performance.now();
    expect(messageLanguage("'".repeat(100_000))).toBe('either');
    expect(messageLanguage('a'.repeat(100_000))).toBe('either');
    expect(performance.now() - started).toBeLessThan(200);
  });
});
