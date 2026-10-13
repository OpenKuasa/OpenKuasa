import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CSV_BOM } from '@/lib/finance/csv';
import {
  INBOX_READING_NOTES,
  INBOX_STATUSES,
  INBOX_STATUS_COLORS,
  INBOX_STATUS_LABELS,
  INBOX_TYPE_LABELS,
  fileSizeLabel,
  filterInboxReceipts,
  inboxDocument,
  inboxReadingNote,
  inboxReceiptsCsv,
  receiptsInboxView,
} from '@/lib/finance/receipt-views';
import { INBOX_RECEIPT_TYPES, type InboxReceiptRow } from '@/lib/finance/receipts';
import { SAMPLE_INBOX_RECEIPTS } from '@/screens/finance/receipts-sample';

const row = (over: Partial<InboxReceiptRow>): InboxReceiptRow => ({
  id: 'r1', file_name: 'receipt.jpg', mime_type: 'image/jpeg', size_bytes: 204800, has_file: true, vendor: null,
  receipt_date: null, amount: null, sst_amount: null, status: 'review',
  document_kind: null, document_label: null, extraction_failed: false, extracted_at: null,
  created_at: '2026-10-03T09:12:00+00:00',
  ...over,
});
const onExpense = (over: Partial<InboxReceiptRow>) =>
  row({ status: 'matched', document_kind: 'expense', document_label: 'Travel', ...over });
const onBill = (over: Partial<InboxReceiptRow>) =>
  row({ status: 'matched', document_kind: 'bill', document_label: 'BILL-0007', ...over });

describe('labels', () => {
  it('has a word for every state and every type', () => {
    expect(INBOX_STATUS_LABELS).toEqual({ review: 'To review', matched: 'Matched', unmatched: 'Unmatched' });
    expect([...INBOX_STATUSES].sort()).toEqual(Object.keys(INBOX_STATUS_LABELS).sort());
    expect(Object.keys(INBOX_TYPE_LABELS).sort()).toEqual(Object.keys(INBOX_RECEIPT_TYPES).sort());
  });
  it('writes a file size in the unit a person would use', () => {
    expect(fileSizeLabel(null)).toBe('—');
    expect(fileSizeLabel(0)).toBe('—');
    expect(fileSizeLabel(512)).toBe('512 B');
    expect(fileSizeLabel(1023)).toBe('1023 B');
    expect(fileSizeLabel(1024)).toBe('1 KB');
    // Never "1024 KB": the last bytes below a megabyte already read as one.
    expect(fileSizeLabel(1024 * 1024 - 1)).toBe('1 MB');
    expect(fileSizeLabel(1024 * 1024 - 1)).not.toContain('1024');
    expect(fileSizeLabel(1024 * 1023)).toBe('1023 KB');
    expect(fileSizeLabel(184320)).toBe('180 KB');
    expect(fileSizeLabel(1024 * 1024)).toBe('1 MB');
    expect(fileSizeLabel(1572864)).toBe('1.5 MB');
    expect(fileSizeLabel(10 * 1024 * 1024)).toBe('10 MB');
  });
  it('says what a receipt is matched to', () => {
    expect(inboxDocument(row({}))).toBe('—');
    expect(inboxDocument(onBill({}))).toBe('Bill BILL-0007');
    expect(inboxDocument(onExpense({}))).toBe('Expense · Travel');
    // A viewer of the inbox always sees the category, but the type allows none.
    expect(inboxDocument(onExpense({ document_label: null }))).toBe('Expense');
    // A draft bill has no number until it is posted.
    expect(inboxDocument(onBill({ document_label: null }))).toBe('Draft bill');
  });
});

describe('inboxReadingNote', () => {
  const read = '2026-10-03T09:12:05+00:00';
  it('says a model read a receipt only when the database says so, and only until a person has reviewed it', () => {
    expect(inboxReadingNote(row({ extracted_at: read, vendor: 'Shell', amount: 10 }))).toBe('read');
    expect(inboxReadingNote(row({ status: 'unmatched', extracted_at: read }))).toBeNull();
    expect(inboxReadingNote(onExpense({ extracted_at: read }))).toBeNull();
  });
  it('never says "read" of a receipt nothing has read, whatever is typed on it', () => {
    expect(inboxReadingNote(row({}))).toBeNull();
    expect(inboxReadingNote(row({ vendor: 'Typed by hand', amount: 10 }))).toBeNull();
  });
  it('says a reading failed while the failure stands, and puts that before a stale stamp', () => {
    expect(inboxReadingNote(row({ extraction_failed: true }))).toBe('failed');
    expect(inboxReadingNote(row({ extraction_failed: true, extracted_at: read }))).toBe('failed');
    expect(inboxReadingNote(row({ status: 'unmatched', extraction_failed: true }))).toBeNull();
  });
  it('has a sentence of its own for each, and tells the person to check a reading', () => {
    expect(INBOX_READING_NOTES.read).toBe('Read by AI. Check the figures before you use them.');
    expect(INBOX_READING_NOTES.failed).toBe('This receipt could not be read automatically.');
  });
});

describe('receiptsInboxView', () => {
  it('counts each state and adds up what was read', () => {
    const view = receiptsInboxView([
      row({ id: 'a', amount: 249.9 }),
      row({ id: 'b' }),
      onExpense({ id: 'c', amount: 0.1 }),
      onExpense({ id: 'd', amount: 0.2 }),
      onBill({ id: 'e', amount: 310 }),
      row({ id: 'f', status: 'unmatched', amount: 540 }),
    ]);
    expect(view.stats).toEqual([
      { label: 'To review', value: '2', delta: 'RM 249.90 · 1 with no amount yet', deltaTone: 'down' },
      // 0.1 + 0.2 + 310 is 310.30, not 310.30000000000004.
      { label: 'Matched', value: '3', delta: 'RM 310.30', deltaTone: 'flat' },
      { label: 'Unmatched', value: '1', delta: 'RM 540.00', deltaTone: 'down' },
    ]);
    expect(view.byStatus.map((s) => [s.key, s.label, s.value])).toEqual([
      ['review', 'To review', 2],
      ['matched', 'Matched', 3],
      ['unmatched', 'Unmatched', 1],
    ]);
    expect(view.hasReceipts).toBe(true);
    expect(view.total).toBe('6');
  });
  it('shows what is waiting in ringgit once every receipt to review has an amount', () => {
    const view = receiptsInboxView([row({ id: 'a', amount: 249.9 }), row({ id: 'b', amount: 10.1 })]);
    expect(view.stats[0]).toEqual({ label: 'To review', value: '2', delta: 'RM 260.00', deltaTone: 'down' });
  });
  it('says "receipts" for more than one with no amount', () => {
    expect(receiptsInboxView([row({ id: 'a' }), row({ id: 'b' })]).stats[0].delta).toBe('2 receipts with no amount yet');
  });
  it('shows both the sum entered and how many have no amount, on all three cards', () => {
    const view = receiptsInboxView([
      row({ id: 'a', amount: 249.9 }),
      row({ id: 'b' }),
      onBill({ id: 'c', amount: 310 }),
      onExpense({ id: 'd', amount: null }),
      onExpense({ id: 'e', amount: null }),
      row({ id: 'f', status: 'unmatched', amount: 5 }),
      row({ id: 'g', status: 'unmatched', amount: null }),
    ]);
    expect(view.stats.map((s) => s.delta)).toEqual([
      'RM 249.90 · 1 with no amount yet',
      'RM 310.00 · 2 with no amount yet',
      'RM 5.00 · 1 with no amount yet',
    ]);
  });
  it('never shows RM 0.00 on any card for amounts nobody has entered', () => {
    const view = receiptsInboxView([
      row({ id: 'a' }),
      onBill({ id: 'b', amount: null }),
      onExpense({ id: 'c', amount: null }),
      row({ id: 'd', status: 'unmatched', amount: null }),
    ]);
    expect(view.stats.map((s) => s.delta)).toEqual([
      '1 receipt with no amount yet',
      '2 receipts with no amount yet',
      '1 receipt with no amount yet',
    ]);
  });
  it('shows ringgit on a card as soon as the amounts are there, whatever the other cards say', () => {
    const view = receiptsInboxView([row({ id: 'a' }), onBill({ id: 'b', amount: 310 }), row({ id: 'd', status: 'unmatched', amount: 5 })]);
    expect(view.stats.map((s) => s.delta)).toEqual(['1 receipt with no amount yet', 'RM 310.00', 'RM 5.00']);
  });
  it('leaves a state with no receipts out of the donut, and keeps the three cards', () => {
    const view = receiptsInboxView([onBill({ amount: 310 })]);
    expect(view.byStatus.map((s) => s.key)).toEqual(['matched']);
    expect(view.stats.map((s) => s.value)).toEqual(['0', '1', '0']);
    expect(view.stats.map((s) => s.deltaTone)).toEqual(['flat', 'flat', 'flat']);
  });
  it('has nothing to draw for an empty inbox', () => {
    const view = receiptsInboxView([]);
    expect(view.hasReceipts).toBe(false);
    expect(view.byStatus).toEqual([]);
    expect(view.total).toBe('0');
    expect(view.stats.map((s) => [s.value, s.delta])).toEqual([['0', 'RM 0.00'], ['0', 'RM 0.00'], ['0', 'RM 0.00']]);
  });
  it('gives each state a theme chart colour of its own, from the ones the donut may use', () => {
    const allowed = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
    expect(Object.keys(INBOX_STATUS_COLORS).sort()).toEqual([...INBOX_STATUSES].sort());
    const colors = INBOX_STATUSES.map((status) => INBOX_STATUS_COLORS[status]);
    for (const color of colors) expect(allowed).toContain(color);
    expect(new Set(colors).size).toBe(INBOX_STATUSES.length);
    // None of the three theme colours is purple, violet or indigo, wherever it is defined: the hue (degrees) of every
    // definition of each token (light, dark and the finance scope) is outside 255 to 345. A token set to var(--x) is
    // followed to every definition of --x, so the finance scope's --chart-3 (var(--brand)) is checked as well.
    const css = readFileSync('src/app/globals.css', 'utf8');
    const definitions = (name: string): string[] =>
      [...css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))].map((m) => m[1].trim());
    const hues = (name: string, depth = 0): number[] =>
      definitions(name).flatMap((value) => {
        const ref = /^var\((--[\w-]+)\)$/.exec(value);
        if (ref) return depth < 3 ? hues(ref[1], depth + 1) : [Number.NaN];
        return [Number(/^oklch\(\S+ \S+ (\d+(?:\.\d+)?)\)$/.exec(value)?.[1])];
      });
    for (const color of colors) {
      const name = color.slice(4, -1);
      const found = hues(name);
      // light, dark and, where a product scope redefines it, that scope as well
      expect(found.length, name).toBeGreaterThanOrEqual(2);
      for (const hue of found) {
        expect(Number.isNaN(hue), name).toBe(false);
        expect(hue < 255 || hue > 345, `${name} hue ${hue}`).toBe(true);
      }
    }
    // The finance scope really is read: --chart-3 is --brand there, so its hue is among those checked.
    expect(definitions('--chart-3')).toContain('var(--brand)');
    expect(hues('--chart-3')).toContain(164);
    // And the donut draws those colours, not others.
    expect(receiptsInboxView(SAMPLE_INBOX_RECEIPTS).byStatus.map((s) => s.color)).toEqual(colors);
  });
});

describe('filterInboxReceipts', () => {
  const rows = [
    row({ id: 'a', file_name: 'IMG_0042.JPG', vendor: 'Shell Bangsar' }),
    onBill({ id: 'b', file_name: 'invois.pdf', vendor: 'Printhub' }),
    onExpense({ id: 'c', file_name: 'grab.png', vendor: null }),
    row({ id: 'd', status: 'unmatched', file_name: 'lori.pdf', vendor: 'Nusantara Logistics' }),
  ];
  const ids = (found: InboxReceiptRow[]) => found.map((r) => r.id).join('');
  it('shows everything until a state or a search is chosen', () => {
    expect(ids(filterInboxReceipts(rows, '', 'all'))).toBe('abcd');
    expect(ids(filterInboxReceipts(rows, '   ', 'all'))).toBe('abcd');
  });
  it('keeps one state', () => {
    expect(ids(filterInboxReceipts(rows, '', 'review'))).toBe('a');
    expect(ids(filterInboxReceipts(rows, '', 'matched'))).toBe('bc');
    expect(ids(filterInboxReceipts(rows, '', 'unmatched'))).toBe('d');
  });
  it('searches the file name, the vendor and the document, whatever the case', () => {
    expect(ids(filterInboxReceipts(rows, 'img_0042', 'all'))).toBe('a');
    expect(ids(filterInboxReceipts(rows, 'SHELL', 'all'))).toBe('a');
    expect(ids(filterInboxReceipts(rows, 'bill-0007', 'all'))).toBe('b');
    expect(ids(filterInboxReceipts(rows, 'travel', 'all'))).toBe('c');
    expect(ids(filterInboxReceipts(rows, '.pdf', 'all'))).toBe('bd');
    expect(ids(filterInboxReceipts(rows, '.pdf', 'matched'))).toBe('b');
    expect(ids(filterInboxReceipts(rows, 'nothing like this', 'all'))).toBe('');
  });
  it('does not find a receipt with no vendor by the word "null"', () => {
    expect(ids(filterInboxReceipts(rows, 'null', 'all'))).toBe('');
  });
});

describe('inboxReceiptsCsv', () => {
  it('writes one line per receipt, amounts as numbers and unread cells empty', () => {
    const csv = inboxReceiptsCsv([
      onExpense({ file_name: 'IMG_0042.JPG', vendor: 'Shell, Bangsar', receipt_date: '2026-10-03', amount: 142.5, sst_amount: 8.07 }),
      row({ file_name: 'scan.pdf', mime_type: 'application/pdf', created_at: '2026-10-02T23:59:00+00:00' }),
      row({ file_name: 'a.jpg', vendor: 'Shell', amount: 10, extracted_at: '2026-10-03T09:12:05+00:00' }),
      row({ file_name: 'b.jpg', extraction_failed: true }),
    ]);
    expect(csv).toBe(
      `${CSV_BOM}Uploaded,File,Type,Vendor,Receipt date,Amount,SST,Status,Matched to,Read by AI\r\n` +
        '2026-10-03,IMG_0042.JPG,JPG,"Shell, Bangsar",2026-10-03,142.5,8.07,Matched,Expense · Travel,\r\n' +
        '2026-10-02,scan.pdf,PDF,,,,,To review,,\r\n' +
        '2026-10-03,a.jpg,JPG,Shell,,10,,To review,,yes\r\n' +
        '2026-10-03,b.jpg,JPG,,,,,To review,,could not be read\r\n',
    );
  });
  it('does not let a file name start a spreadsheet formula', () => {
    expect(inboxReceiptsCsv([row({ file_name: '=HYPERLINK("http://x")' })])).toContain(`"'=HYPERLINK(""http://x"")"`);
  });
});

describe('the sample shown when there is no database', () => {
  it('is the mock-up: eight receipts, five matched, two to review, one unmatched, newest first', () => {
    const view = receiptsInboxView(SAMPLE_INBOX_RECEIPTS);
    expect(view.total).toBe('8');
    expect(view.stats.map((s) => s.value)).toEqual(['2', '5', '1']);
    const uploaded = SAMPLE_INBOX_RECEIPTS.map((r) => r.created_at);
    expect(uploaded).toEqual([...uploaded].sort().reverse());
    expect(new Set(SAMPLE_INBOX_RECEIPTS.map((r) => r.id)).size).toBe(8);
  });
  it('has rows the database would allow', () => {
    for (const r of SAMPLE_INBOX_RECEIPTS) {
      // Matched exactly when tied to one document, as the table's check has it.
      expect(r.document_kind !== null, r.file_name).toBe(r.status === 'matched');
      expect(r.has_file, r.file_name).toBe(false);
      expect(r.file_name.endsWith(`.${INBOX_RECEIPT_TYPES[r.mime_type]}`), r.file_name).toBe(true);
      if (r.sst_amount !== null && r.amount !== null) expect(r.sst_amount).toBeLessThanOrEqual(r.amount);
    }
    // The one a model could not read has nothing read from it.
    const unread = SAMPLE_INBOX_RECEIPTS.filter((r) => r.extraction_failed);
    expect(unread).toHaveLength(1);
    expect([unread[0].status, unread[0].vendor, unread[0].amount]).toEqual(['review', null, null]);
    expect(inboxReadingNote(unread[0])).toBe('failed');
    // And exactly one is a model's reading waiting to be checked.
    expect(SAMPLE_INBOX_RECEIPTS.filter((r) => inboxReadingNote(r) === 'read').map((r) => r.vendor)).toEqual(['Lazada']);
    expect(SAMPLE_INBOX_RECEIPTS.filter((r) => r.extracted_at !== null)).toHaveLength(1);
  });
});
