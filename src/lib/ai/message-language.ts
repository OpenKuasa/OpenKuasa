/**
 * Which language a chat message is written in, decided by code rather than by the model: English, Bahasa
 * Malaysia, or "could be either". Pure, no imports, linear in the text (and only the first few thousand characters
 * are read).
 *
 * It is deliberately cautious. A wrong confident answer is worse than `either`, because the answer is passed to the
 * model as a fact about this turn (see `reply-language.ts`); `either` passes nothing and leaves the assistant's own
 * LANGUAGE rule to decide, as before.
 *
 * How it decides:
 * - Evidence is the grammar words of each language (`the`, `is`, `for` / `yang`, `untuk`, `saya`) plus a few
 *   everyday Malay request and HR words that English does not borrow. English content words that Malaysians use in
 *   Malay sentences (leave, claim, pending, approve, check, update, list, OT) are evidence for neither, so rojak
 *   with a Malay frame ("Boleh check leave balance saya?") is Bahasa Malaysia.
 * - Words count once each (distinct hits), on word boundaries.
 * - A capitalised word that does not start a sentence is taken as a name and counts for nothing: "Dan", "Will",
 *   "May", "Bila" and "Kasih" are people before they are words.
 * - A verdict needs at least two distinct words of one language, and either none of the other or a clear majority
 *   (four or more, and three times the other). Anything else is `either`: a name, a number, one word, a greeting
 *   both languages use ("ok", "thanks", "hi"), balanced rojak.
 * - A message that asks for the reply in a language ("reply in English", "jawab dalam BM") is `either`: the person
 *   has said it, and the note must not overrule them.
 * - A first word that is Malay (not "tolong") with English after it is rojak, so never `en`.
 * - An instruction followed by other material ("Translate this: ...", "Tolong semak surat ini:\n...") is judged by
 *   the instruction: what is pasted after it is not the person speaking. When the instruction alone is too thin to
 *   call and the whole points the other way, the answer is `either`.
 */

export type MessageLanguage = 'en' | 'ms' | 'either';

/** Only this much of a message is read: the person's own words come first, and a paste can be very long. */
const MAX_CHARS = 4000;

const words = (list: string): ReadonlySet<string> => new Set(list.split(/\s+/).filter((word) => word !== ''));

/**
 * English grammar words, and a few request verbs that are not borrowed into Malay sentences. Left out on purpose
 * because Malaysians use them inside Malay: i, you, so, no, ok, okay, yes, hi, hello, thanks, thank, sorry, list,
 * check, update, approve, pending, claim, leave, today, just, new.
 */
const ENGLISH = words(`
  the is are was were be been do does did what which who whose when where why how please can could would should
  will may might must our my your his her their its to of and for with this that these those a an in on at by from
  into about he she we they me him us them it not have has had any some all each every there here if but or than
  then as also only many much show give tell need want
  what's it's don't can't doesn't didn't isn't aren't won't i'm i'd i'll i've
  translate summarise summarize rewrite proofread
`);

/**
 * Malay grammar words (colloquial forms included), and everyday request and HR words. Left out on purpose because
 * they are also English words, common names or used by both: air, lain, pun, jam, main, la, lah, ya, ok.
 */
const MALAY = words(`
  saya aku kami kita anda awak kau dia mereka korang
  yang untuk dengan dalam kepada daripada dari pada di ke tentang mengenai oleh sebagai antara hingga sampai sejak
  selepas sebelum semasa supaya kerana sebab jadi dan atau tetapi tapi kalau jika
  ini itu ni tu sini sana situ
  tidak tak bukan belum sudah dah telah akan sedang masih pernah boleh mesti harus patut nak mahu hendak ingin
  perlu perlukan ada tiada takde takda
  apa apakah adakah bolehkah berapa siapa bila mana macam bagaimana kenapa mengapa
  sila tolong minta mohon terima kasih maaf selamat
  semua setiap sahaja saja juga lagi lebih kurang banyak sikit sedikit sangat amat terlalu sama baru
  satu dua tiga orang hari minggu bulan tahun esok semalam lusa tadi nanti sekarang pagi petang malam
  cuti gaji tuntutan kehadiran pekerja kakitangan syarikat jabatan surat permohonan baki jumlah senarai nama
  prestasi semakan encik puan cik
  tunjuk tunjukkan senaraikan sediakan buat buatkan beri berikan bagi cari lihat tengok guna gunakan dapat
  dapatkan lulus luluskan tolak batal batalkan hantar tambah padam buang tukar semak tulis tuliskan
  terjemah terjemahkan ringkaskan betulkan
`);

/** A request to work on material that follows: the language of the request is the person's, the material is not. */
const INSTRUCTION: Readonly<Record<string, 'en' | 'ms'>> = {
  translate: 'en',
  summarise: 'en',
  summarize: 'en',
  rewrite: 'en',
  proofread: 'en',
  terjemah: 'ms',
  terjemahkan: 'ms',
  ringkaskan: 'ms',
  betulkan: 'ms',
  semak: 'ms',
};

const TOKEN = /\p{L}+(?:['’]\p{L}+)*/gu;
const SENTENCE_BREAK = /[.!?:;\n]/;

type Evidence = { en: number; ms: number; opening: 'en' | 'ms' | null; startsMalay: boolean };

/** "Reply in English", "jawab dalam BM": the person names the language of the reply, so the server does not. */
const REPLY_LANGUAGE_REQUEST = /\b(?:reply|answer|respond|jawab|balas)\b[^.!?\n]{0,40}?\b(?:in|dalam)\s+(?:english|malay|melayu|bahasa|bm|inggeris)\b/i;

/** Polite particles that Malaysians put in front of English requests: not enough to call the sentence Malay rojak. */
const POLITE_OPENING = new Set(['tolong']);

/** Malay word shapes English does not have: a long word ending in -kan or -nya ("hantarkan", "gajinya"). */
const looksMalay = (word: string): boolean => word.length >= 6 && (word.endsWith('kan') || word.endsWith('nya'));

function evidence(text: string): Evidence {
  const en = new Set<string>();
  const ms = new Set<string>();
  let opening: 'en' | 'ms' | null = null;
  let startsMalay = false;
  let previousEnd = 0;
  let index = 0;
  for (const match of text.matchAll(TOKEN)) {
    const raw = match[0];
    const start = match.index;
    const first = index === 0;
    const startsSentence = first || SENTENCE_BREAK.test(text.slice(previousEnd, start));
    previousEnd = start + raw.length;
    index += 1;

    // "Aminah", "Dan": a capital with lower-case letters after it, not at the start of a sentence, is a name.
    const titleCase = raw[0] !== raw[0].toLowerCase() && raw !== raw.toUpperCase();
    if (titleCase && !startsSentence) continue;

    let word = raw.toLowerCase().replace(/’/g, "'");
    if (!ENGLISH.has(word) && word.endsWith("'s")) word = word.slice(0, -2);
    if (first && INSTRUCTION[word]) opening = INSTRUCTION[word];
    if (first && (MALAY.has(word) || looksMalay(word)) && !POLITE_OPENING.has(word)) startsMalay = true;
    if (ENGLISH.has(word)) en.add(word);
    else if (MALAY.has(word) || looksMalay(word)) ms.add(word);
  }
  return { en: en.size, ms: ms.size, opening, startsMalay };
}

const clear = (mine: number, other: number): boolean => mine >= 2 && (other === 0 || (mine >= 4 && mine >= 3 * other));

function verdict({ en, ms }: Evidence): MessageLanguage {
  if (clear(en, ms)) return 'en';
  if (clear(ms, en)) return 'ms';
  return 'either';
}

/** The language `text` is written in, or `either` when the words do not settle it. */
export function messageLanguage(text: string): MessageLanguage {
  const sample = text.trim().slice(0, MAX_CHARS).replace(/\r\n?/g, '\n');
  if (sample === '') return 'either';
  if (REPLY_LANGUAGE_REQUEST.test(sample)) return 'either';
  const all = evidence(sample);
  const whole = verdict(all);
  // A Malay opening word (a verb, a pronoun) with English after it is rojak: never called English.
  const settle = (language: MessageLanguage): MessageLanguage => (language === 'en' && all.startsMalay ? 'either' : language);

  // "Translate this: ...": the words before the first colon or line break, when more follows them.
  const cut = sample.search(/:\s|\n/);
  if (cut > 0 && sample.slice(cut + 1).trim() !== '') {
    const lead = evidence(sample.slice(0, cut));
    const called = verdict(lead);
    if (called !== 'either') return settle(called);
    const leans = lead.en > 0 && lead.ms === 0 ? 'en' : lead.ms > 0 && lead.en === 0 ? 'ms' : null;
    if (leans && whole !== 'either' && whole !== leans) return 'either';
  }
  // "Translate this dengan hormatnya ...": the same request with no colon.
  if (all.opening && whole !== 'either' && whole !== all.opening) return 'either';
  return settle(whole);
}
