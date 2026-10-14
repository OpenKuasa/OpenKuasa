import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

const CARD = 'src/components/finance/receipt-read-card.tsx';
const VIEW = 'src/components/finance/receipts-inbox-view.tsx';
const LOADER = 'src/screens/finance/receipts-inbox.tsx';
const MATCH_CARDS = 'src/components/finance/receipt-match-cards.tsx';
const REVIEW_CARD = 'src/components/finance/receipt-review-card.tsx';

/**
 * The screen's half of reading a receipt with AI. A component has no unit of its own here (Vitest runs in node),
 * so what must never happen is read from the source, as the other receipt screens' checks are: a receipt is sent
 * by one button's press and by nothing else, and what a model said is only ever drawn as text.
 */
describe('a receipt is sent only by the press of one button', () => {
  it('the loader hands the action down and never calls it, and decides who gets it from the plan', () => {
    const loader = read(LOADER);
    expect(loader).toContain('read: readReceiptAction');
    expect(loader).not.toMatch(/readReceiptAction\(/);
    expect(loader).toContain('receiptReadingPlan(viewer, rows)');
    expect(loader).toContain('reading: readingPlan.offered');
    expect(loader).toContain('canManageKey: readingPlan.canManageKey');
    // The key's state is asked as the caller, and only when a receipt on the page could be read.
    expect(loader).toContain("readingPlan.readsKeyState ? workspaceKeyState(ctx.client) : ('unknown' as const)");
    expect(loader).toContain('setUp: receiptModelId() !== null');
    expect(loader).not.toMatch(/can\(viewer\.role/);
  });

  it('the card calls the action from the button’s handler, once, and has no effect at all', () => {
    const card = read(CARD);
    expect(card.match(/reading\.read\(/g)).toHaveLength(1);
    expect(card).not.toMatch(/useEffect|useLayoutEffect|useEffectEvent|setTimeout|setInterval/);
    expect(card.match(/onClick=\{send\}/g)).toHaveLength(1);
    // Focus does not land on the button that sends.
    const sendButton = card.split('\n').find((line) => line.includes('onClick={send}')) ?? '';
    expect(sendButton).not.toMatch(/autoFocus|data-finance-focus/);
  });

  it('the view opens the question from the menu and calls the action nowhere', () => {
    const view = read(VIEW);
    expect(view).not.toMatch(/\.read\(/);
    expect(view).toContain('writer.reading && canOfferReading(r)');
    expect(view).toContain('setAsking(r);');
    // The question is one of the things `closeAll` closes, so it is never open beside another card.
    expect(view).toMatch(/const closeAll = \(\) => \{[^}]*setAsking\(null\);/);
  });

  it('uploading reads nothing, and no other screen is given the action', () => {
    for (const file of ['src/components/finance/receipt-upload-card.tsx', 'src/components/finance/receipt-upload.ts']) {
      expect(read(file), file).not.toMatch(/receipt-read|receipt-reading|readReceipt/);
    }
    for (const file of ['src/screens/finance/expenses.tsx', 'src/screens/finance/supplier-bills.tsx']) {
      expect(read(file), file).not.toContain('readReceiptAction');
    }
  });
});

describe('a reading that is still under way', () => {
  it('holds the send and the cancel buttons, and the card tells a refusal to the view', () => {
    const card = read(CARD);
    expect(card).toContain('<Button type="button" size="sm" disabled={sending.pending} onClick={send}>');
    expect(card).toMatch(/onClick=\{onClose\} disabled=\{sending\.pending\}/);
    expect(card).toContain('onRefused(');
    // A lost answer is not told as a failed save: the file may have been sent.
    expect(card).toContain('RECEIPT_READING_MESSAGES.lostAnswer');
  });

  it('the view shows an answer only while the question for that receipt is still the thing open', () => {
    const view = read(VIEW);
    expect(view).toContain("readAnswerFate(askingId.current, read.id) === 'drop'");
    expect(view).toContain("readAnswerFate(askingId.current, asking.id) === 'drop'");
    // A dropped answer opens no card and sets no suggestion; a refusal is said above the table, not lost.
    expect(view).toContain('setReadRefusal({ fileName: asking.file_name, message })');
    expect(view).toContain('title="Receipt not read"');
    // Whatever closes the cards forgets the question and the note.
    expect(view).toMatch(/const closeAll = \(\) => \{[^}]*setAsking\(null\);\s*setReadRefusal\(null\);/);
    // The open question's id follows the state, so a menu action that closes the card also forgets it.
    expect(view).toContain('askingId.current = asking?.id ?? null;');
  });
});

describe('the card’s header', () => {
  it('lets the subtitle wrap instead of cutting it with an ellipsis', () => {
    expect(read(CARD)).toContain('subtitle={<span className="block whitespace-normal break-words">');
  });
});

describe('how the screen is kept safe', () => {
  it('nothing on the screen reaches for the platform’s key, the free questions or a model', () => {
    for (const file of [CARD, VIEW, LOADER, MATCH_CARDS, REVIEW_CARD]) {
      expect(read(file), file).not.toMatch(/OPENROUTER_API_KEY|consume_free_question|resolveChatAccess|getModel\(|pickModelId|hasProviderKey|generateText|streamText/);
    }
  });

  it('the card draws no HTML, opens nothing, and its one link is the AI key page', () => {
    const card = read(CARD);
    expect(card).not.toMatch(/dangerouslySetInnerHTML|<iframe|<embed|<object|<img|window\.open|target="_blank"/);
    expect(card).not.toMatch(/purple|violet|indigo|fuchsia/);
    expect(card.match(/href=/g)).toHaveLength(1);
    expect(card).toContain('href="/account/ai"');
  });

  it('what a model said is drawn as text: a suggested category’s name goes through a sentence, never into markup', () => {
    expect(read(REVIEW_CARD)).toContain('{suggestedCategoryLine(suggestion)}');
    expect(read(MATCH_CARDS)).toContain('{caution ? ` ${caution}` : \'\'}');
    for (const file of [REVIEW_CARD, MATCH_CARDS, VIEW]) expect(read(file), file).not.toContain('dangerouslySetInnerHTML');
  });

  it('a suggested category starts the expense form only, and only while it stands', () => {
    const cards = read(MATCH_CARDS);
    expect(cards).toContain('...(suggestion ? { categoryId: suggestion.id } : {})');
    // The bill form is started from the receipt alone.
    expect(cards).toContain('initial={billFormFromReceipt(row, match.suppliers, today, match.defaultCategoryId)}');
    const view = read(VIEW);
    expect(view).toContain('standingSuggestion(rows.find((r) => r.id === id), readHere[id] ?? undefined, match?.categories ?? [])');
    expect(view).toContain('suggestion={suggestionFor(matchOpen.row.id)}');
    expect(view).toContain('key={reviewCardKey(reviewed, reviewed.id in readHere)}');
  });
});
