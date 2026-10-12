import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RECEIPT_FILE_MESSAGES as M,
  RECORD_WINDOW_MS,
  UPLOAD_QUEUE_MAX,
  type UploadItem,
  canPreview,
  cleanFileName,
  inboxReceiptPath,
  isHeif,
  isInboxReceiptPath,
  jpgFileName,
  queueAdd,
  queueBusy,
  queueNext,
  queueSet,
  queueSummary,
  queueWithoutDone,
  receiptDownloadName,
  receiptSizeProblem,
  retryPlan,
  tooManyLeftOut,
  sniffReceiptType,
  typeOfReceiptPath,
  uploadFailure,
} from '@/lib/finance/receipt-files';
import { INBOX_RECEIPT_MAX_BYTES, INBOX_RECEIPT_TYPES } from '@/lib/finance/receipts';

const ORG = '11111111-1111-4111-8111-111111111111';
const FILE = '22222222-2222-4222-8222-222222222222';
const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));
/** An `ftyp` box: size, "ftyp", major brand, minor version, compatible brands. */
const ftyp = (major: string, ...compatible: string[]) => {
  const size = 16 + 4 * compatible.length;
  return bytes(0, 0, 0, size, ...text('ftyp'), ...text(major), 0, 0, 0, 0, ...compatible.flatMap(text), 1, 2, 3, 4);
};

describe('sniffReceiptType', () => {
  it('reads the five types from their first bytes', () => {
    expect(sniffReceiptType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffReceiptType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
    expect(sniffReceiptType(bytes(...text('%PDF-1.7')))).toBe('application/pdf');
    // What a Mac's own converter writes, and an iPhone: major brand heic.
    expect(sniffReceiptType(ftyp('heic', 'mif1', 'MiPr', 'miaf', 'MiHB'))).toBe('image/heic');
    expect(sniffReceiptType(ftyp('heix', 'mif1'))).toBe('image/heic');
    expect(sniffReceiptType(ftyp('mif1', 'mif1', 'heic'))).toBe('image/heic');
    expect(sniffReceiptType(ftyp('mif1', 'mif1', 'miaf'))).toBe('image/heif');
    expect(sniffReceiptType(ftyp('msf1'))).toBe('image/heif');
  });

  it('refuses everything else, whatever it is called', () => {
    expect(sniffReceiptType(bytes())).toBeNull();
    expect(sniffReceiptType(bytes(0xff, 0xd8))).toBeNull();
    expect(sniffReceiptType(bytes(...text('<!doctype html><script>')))).toBeNull();
    expect(sniffReceiptType(bytes(...text('<svg xmlns=')))).toBeNull();
    expect(sniffReceiptType(bytes(...text('GIF89a')))).toBeNull();
    expect(sniffReceiptType(bytes(...text('RIFF'), 0, 0, 0, 0, ...text('WEBP')))).toBeNull();
    expect(sniffReceiptType(bytes(...text('PK'), 3, 4))).toBeNull();
    // The same container holding AV1 or a video is not a receipt.
    expect(sniffReceiptType(ftyp('avif', 'mif1', 'miaf'))).toBeNull();
    expect(sniffReceiptType(ftyp('mif1', 'avif', 'miaf'))).toBeNull();
    expect(sniffReceiptType(ftyp('isom', 'mp42'))).toBeNull();
    expect(sniffReceiptType(ftyp('qt  '))).toBeNull();
    // A PDF marker that is not at the start does not count.
    expect(sniffReceiptType(bytes(0x20, ...text('%PDF-')))).toBeNull();
  });

  it('says which types are previewed and which are converted', () => {
    expect(Object.keys(INBOX_RECEIPT_TYPES).filter((t) => canPreview(t as never))).toEqual(['image/jpeg', 'image/png']);
    expect(Object.keys(INBOX_RECEIPT_TYPES).filter((t) => isHeif(t as never))).toEqual(['image/heic', 'image/heif']);
  });
});

describe('size, path and name', () => {
  it('takes 1 byte to 10 MB', () => {
    expect(receiptSizeProblem(0)).toBe(M.empty);
    expect(receiptSizeProblem(Number.NaN)).toBe(M.empty);
    expect(receiptSizeProblem(1)).toBeNull();
    expect(receiptSizeProblem(INBOX_RECEIPT_MAX_BYTES)).toBeNull();
    expect(receiptSizeProblem(INBOX_RECEIPT_MAX_BYTES + 1)).toBe(M.tooBig);
  });

  it('makes the path the bucket and the table allow, and nothing of the file name is in it', () => {
    expect(inboxReceiptPath(ORG.toUpperCase(), 'image/jpeg', FILE.toUpperCase())).toBe(`${ORG}/${FILE}.jpg`);
    for (const [type, ext] of Object.entries(INBOX_RECEIPT_TYPES)) {
      const path = inboxReceiptPath(ORG, type as never);
      expect(path.endsWith(`.${ext}`)).toBe(true);
      expect(isInboxReceiptPath(path, ORG)).toBe(true);
      expect(typeOfReceiptPath(path)).toBe(type);
    }
  });

  it('refuses any other path', () => {
    const other = '33333333-3333-4333-8333-333333333333';
    for (const bad of [
      `${other}/${FILE}.jpg`,
      `${ORG}/${FILE}.jpeg`,
      `${ORG}/${FILE}.webp`,
      `${ORG}/${FILE}.JPG`,
      `${ORG}/${FILE}`,
      `${ORG}/sub/${FILE}.jpg`,
      `${ORG}/../${other}/${FILE}.jpg`,
      `${ORG}/${FILE}.jpg\n`,
      ` ${ORG}/${FILE}.jpg`,
      `${ORG}/resit.jpg`,
      '',
    ]) {
      expect(isInboxReceiptPath(bad, ORG), bad).toBe(false);
    }
    expect(typeOfReceiptPath(`${ORG}/${FILE}.exe`)).toBeNull();
  });

  it('keeps the same pattern as the migration', () => {
    const sql = readFileSync('supabase/migrations/20261107100000_bendahara_receipts_inbox.sql', 'utf8');
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    const extensions = Object.values(INBOX_RECEIPT_TYPES).join('|');
    // The upload rule's pattern and the table's check, as written there.
    expect(sql).toContain(`name ~ '^${uuid}/${uuid}\\.(${extensions})$'`);
    expect(sql).toContain(`/${uuid}\\.(${extensions})$')`);
  });

  it('cleans a name to text that is safe to show and store', () => {
    expect(cleanFileName('C:\\Users\\Ali\\Resit Kedai.jpg')).toBe('Resit Kedai.jpg');
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('a\u0000b\tc\u202egpj.exe')).toBe('abcgpj.exe');
    expect(cleanFileName('a\u061cb\u200bc\u200cd\u200de.pdf')).toBe('abcde.pdf');
    expect(cleanFileName('   ')).toBe('receipt');
    expect(cleanFileName('folder/')).toBe('receipt');
    expect(Array.from(cleanFileName('é'.repeat(300)))).toHaveLength(200);
    expect(cleanFileName('<img src=x onerror=alert(1)>.png')).toBe('<img src=x onerror=alert(1)>.png');
    // The table's own check: no control character, slash or backslash, 1 to 200 characters.
    for (const name of ['a/b\\c', '\u0007', 'x'.repeat(500)]) {
      expect(cleanFileName(name)).toMatch(/^[^\u0000-\u001f\u007f/\\]{1,200}$/);
    }
  });

  it('names a converted photo and a download', () => {
    expect(jpgFileName('IMG_0042.HEIC')).toBe('IMG_0042.jpg');
    expect(jpgFileName('photo.heif')).toBe('photo.jpg');
    // Any of the five extensions goes, so a photo already named .jpg is not named .jpg.jpg.
    expect(jpgFileName('IMG_0042.jpg')).toBe('IMG_0042.jpg');
    expect(jpgFileName('scan.PNG')).toBe('scan.jpg');
    expect(jpgFileName('scan.jpeg')).toBe('scan.jpg');
    expect(jpgFileName('scan.pdf')).toBe('scan.jpg');
    expect(jpgFileName('.heic')).toBe('receipt.jpg');
    expect(Array.from(jpgFileName(`${'x'.repeat(300)}.heic`))).toHaveLength(200);
    expect(receiptDownloadName('image/jpeg')).toBe('receipt.jpg');
    expect(receiptDownloadName('image/heif')).toBe('receipt.heif');
  });

  it('words what storage refused', () => {
    expect(uploadFailure({ statusCode: '413' })).toBe(M.tooBig);
    expect(uploadFailure({ status: 400, statusCode: '413' })).toBe(M.tooBig);
    expect(uploadFailure({ statusCode: '415' })).toBe(M.wrongType);
    expect(uploadFailure({ statusCode: '403' })).toBe(M.refused);
    expect(uploadFailure({ status: 401 })).toBe(M.refused);
    expect(uploadFailure({})).toBe(M.network);
    expect(uploadFailure(null)).toBe(M.network);
    expect(uploadFailure({ status: 500 })).toBe(M.network);
  });
});

describe('the upload queue', () => {
  const picked = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ key: `k${from + i}`, name: `f${from + i}.jpg`, size: 10 }));

  it('adds files up to the cap and says how many did not fit', () => {
    const first = queueAdd([], picked(3));
    expect(first.refused).toBe(0);
    expect(first.items.map((i) => i.step)).toEqual(['waiting', 'waiting', 'waiting']);
    const full = queueAdd(first.items, picked(UPLOAD_QUEUE_MAX, 3));
    expect(full.items).toHaveLength(UPLOAD_QUEUE_MAX);
    expect(full.refused).toBe(3);
    // A finished file frees its place.
    const done = queueSet(full.items, 'k0', { step: 'done' });
    expect(queueAdd(done, picked(2, 100)).refused).toBe(1);
    // So does a failed one: it is waiting for a person, not for a turn.
    const failed = queueSet(full.items, 'k0', { step: 'failed', error: M.network });
    expect(queueAdd(failed, picked(2, 100)).refused).toBe(1);
  });

  it('says how many were left out and that they can be added later', () => {
    expect(tooManyLeftOut(5)).toBe('Twenty files can wait at once. 5 files were left out. Add them when these have finished.');
    expect(tooManyLeftOut(1)).toBe('Twenty files can wait at once. 1 file was left out. Add it when these have finished.');
  });

  it('cleans the name it shows', () => {
    expect(queueAdd([], [{ key: 'a', name: 'dir/Resit\u0000.png', size: 1 }]).items[0].name).toBe('Resit.png');
  });

  it('runs one file at a time, in order', () => {
    let items = queueAdd([], picked(2)).items;
    expect(queueNext(items)?.key).toBe('k0');
    items = queueSet(items, 'k0', { step: 'uploading' });
    expect(queueBusy(items)).toBe(true);
    expect(queueNext(items)).toBeNull();
    items = queueSet(items, 'k0', { step: 'failed', error: M.network });
    expect(queueBusy(items)).toBe(false);
    expect(queueNext(items)?.key).toBe('k1');
    items = queueSet(items, 'k1', { step: 'done' });
    expect(queueNext(items)).toBeNull();
    expect(queueSummary(items)).toBe('1 of 2 added · 1 not added');
    expect(queueWithoutDone(items).map((i) => i.key)).toEqual(['k0']);
    expect(queueSummary([])).toBe('');
    expect(queueSummary(queueSet(queueAdd([], picked(1)).items, 'k0', { step: 'done' }))).toBe('1 added');
  });

  it('retries the save while the database would still take the file, and uploads again after that', () => {
    const item: UploadItem = { key: 'a', name: 'a.jpg', size: 1, step: 'failed', error: M.notSaved, path: `${ORG}/${FILE}.jpg`, storedAt: 1_000 };
    expect(retryPlan(item, 1_000 + RECORD_WINDOW_MS - 1)).toBe('save');
    expect(retryPlan(item, 1_000 + RECORD_WINDOW_MS)).toBe('upload');
    expect(retryPlan({ ...item, path: null, storedAt: null }, 1_000)).toBe('upload');
    // Inside the database's own 30 minutes, with room for the call to arrive.
    expect(RECORD_WINDOW_MS).toBeLessThan(30 * 60 * 1000);
  });
});
