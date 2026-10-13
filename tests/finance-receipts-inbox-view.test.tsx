import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { type ReceiptInboxActions, ReceiptsInboxView } from '@/components/finance/receipts-inbox-view';
import type { ReceiptMatchActions, ReceiptMatchData } from '@/components/finance/receipt-match-cards';
import { UNTIE_NEEDS_DECIDER } from '@/lib/finance/receipt-match';
import type { MatchedDocument } from '@/lib/finance/receipt-match';
import { receiptsInboxView } from '@/lib/finance/receipt-views';
import type { InboxReceiptRow } from '@/lib/finance/receipts';

/**
 * The Receipts Inbox as the server sends it, rendered to a string and read as markup (node, no DOM: nothing
 * can be pressed). What the row menu offers each role, the one line a member is shown above the table, and
 * the second line under "Matched to" are read here. What a press decides is in plain functions
 * (tests/finance-receipt-match.test.ts).
 */

// A closed menu draws nothing but its button. Here its items are drawn in place, so what the menu offers can be read.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Item = ({ children }: { children?: ReactNode }) => <div role="menuitem">{children}</div>;
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: Item,
  };
});

vi.mock('@/components/ui/select', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Select: Pass,
    SelectTrigger: Pass,
    SelectValue: () => null,
    SelectContent: Pass,
    SelectItem: Pass,
  };
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const items = (html: string) =>
  [...html.matchAll(/<div role="menuitem">([\s\S]*?)<\/div>/g)].map(([, inner]) => text(inner));

const receipt = (over: Partial<InboxReceiptRow>): InboxReceiptRow => ({
  id: 'r-0',
  file_name: 'r.png',
  mime_type: 'image/png',
  size_bytes: 1000,
  has_file: true,
  vendor: null,
  receipt_date: null,
  amount: null,
  sst_amount: null,
  status: 'unmatched',
  document_kind: null,
  document_label: null,
  extraction_failed: false,
  extracted_at: null,
  created_at: '2026-10-05T00:00:00Z',
  ...over,
});

const FREE = receipt({ id: 'r-free', file_name: 'free-one.png' });
const PENDING = receipt({ id: 'r-pending', file_name: 'pending-one.png', status: 'matched', document_kind: 'expense', document_label: 'Utilities' });
const APPROVED = receipt({ id: 'r-approved', file_name: 'approved-one.png', status: 'matched', document_kind: 'expense', document_label: 'Fuel' });
const POSTED = receipt({ id: 'r-posted', file_name: 'posted-one.png', status: 'matched', document_kind: 'bill', document_label: 'BILL-0004' });

const DOCUMENTS: Record<string, MatchedDocument> = {
  'r-pending': { kind: 'expense', id: 'e1', label: 'Pending approval', locked: false },
  'r-approved': { kind: 'expense', id: 'e2', label: 'Approved', locked: true },
  'r-posted': { kind: 'bill', id: 'b1', label: 'Posted, overdue', locked: true },
};

const done = () => vi.fn(async () => ({ ok: true as const, data: { id: 'x' } }));
const ACTIONS = { register: done(), review: done(), remove: done() } as unknown as ReceiptInboxActions;
const MATCH_ACTIONS = { toExpense: done(), toBill: done(), attach: done(), detach: done() } as unknown as ReceiptMatchActions;
const linkOf = vi.fn(async () => ({ ok: false as const, error: 'unused' }));

const match = (canDecide: boolean): ReceiptMatchData => ({
  actions: MATCH_ACTIONS,
  canDecide,
  contacts: [],
  categories: [],
  suppliers: [],
  products: [],
  defaultCategoryId: '',
  candidates: [],
});

const render = (props: { writer?: 'owner' | 'member'; demo?: boolean; rows?: InboxReceiptRow[]; documents?: boolean }) => {
  const rows = props.rows ?? [FREE, PENDING, APPROVED, POSTED];
  return renderToStaticMarkup(
    <ReceiptsInboxView
      rows={rows}
      view={receiptsInboxView(rows)}
      today="2026-10-10"
      followClock={false}
      linkOf={linkOf}
      documents={props.documents === false ? undefined : DOCUMENTS}
      writer={
        props.writer
          ? { orgId: 'org-1', actions: ACTIONS, match: match(props.writer === 'owner') }
          : undefined
      }
      demo={props.demo}
    />,
  );
};

/** The menu items of the table row that names this file. */
const menuOf = (html: string, fileName: string) => {
  const row = html.split('<tr').find((r) => r.includes(fileName) && r.includes('role="menuitem"'));
  return row ? items(row) : [];
};

describe('what the row menu offers each role', () => {
  it('an owner or admin: everything on a receipt tied to nothing, and Untie on every tied one', () => {
    const html = render({ writer: 'owner' });
    expect(menuOf(html, 'free-one.png')).toEqual([
      'Download',
      'Edit details',
      'Create expense',
      'Create draft bill',
      'Attach to expense or bill',
      'Delete',
    ]);
    expect(menuOf(html, 'pending-one.png')).toEqual(['Download', 'Untie']);
    expect(menuOf(html, 'approved-one.png')).toEqual(['Download', 'Untie']);
    expect(menuOf(html, 'posted-one.png')).toEqual(['Download', 'Untie']);
  });

  it('a member: Untie only where the document is not approved or posted', () => {
    const html = render({ writer: 'member' });
    expect(menuOf(html, 'pending-one.png')).toEqual(['Download', 'Untie']);
    expect(menuOf(html, 'approved-one.png')).toEqual(['Download']);
    expect(menuOf(html, 'posted-one.png')).toEqual(['Download']);
  });

  it('a viewer, with no writer: Download and nothing that changes anything', () => {
    const html = render({});
    for (const name of ['free-one.png', 'pending-one.png', 'approved-one.png', 'posted-one.png']) {
      expect(menuOf(html, name)).toEqual(['Download']);
    }
    for (const word of ['Delete', 'Untie', 'Create expense', 'Create draft bill', 'Attach to expense', 'Edit details', 'Review']) {
      expect(items(html)).not.toContain(word);
    }
  });

  it('Delete is offered only on a receipt tied to nothing', () => {
    const html = render({ writer: 'owner' });
    expect(menuOf(html, 'free-one.png')).toContain('Delete');
    for (const name of ['pending-one.png', 'approved-one.png', 'posted-one.png']) {
      expect(menuOf(html, name)).not.toContain('Delete');
    }
  });

  it('the demo: sample receipts have no file, so there is no menu on any row', () => {
    const rows = [FREE, PENDING].map((r) => ({ ...r, has_file: false }));
    const html = render({ demo: true, rows });
    expect(items(html)).toEqual([]);
  });
});

describe('the one line above the table', () => {
  it('a member is told once why a matched receipt has no Untie', () => {
    const html = render({ writer: 'member' });
    expect(html.split(UNTIE_NEEDS_DECIDER).length - 1).toBe(1);
  });

  it('an owner, a viewer and a member with nothing locked are not', () => {
    expect(render({ writer: 'owner' })).not.toContain(UNTIE_NEEDS_DECIDER);
    expect(render({})).not.toContain(UNTIE_NEEDS_DECIDER);
    expect(render({ writer: 'member', rows: [FREE, PENDING] })).not.toContain(UNTIE_NEEDS_DECIDER);
  });
});

describe('the second line under "Matched to"', () => {
  it('says how the document stands, to a viewer as well as a writer', () => {
    for (const html of [render({ writer: 'owner' }), render({})]) {
      const rowText = (name: string) => text(html.split('<tr').find((r) => r.includes(name)) ?? '');
      expect(rowText('pending-one.png')).toContain('Pending approval');
      expect(rowText('approved-one.png')).toContain('Approved');
      expect(rowText('posted-one.png')).toContain('Posted, overdue');
      expect(rowText('free-one.png')).not.toContain('Pending approval');
    }
  });

  it('is left out when the document could not be read', () => {
    const html = render({ documents: false });
    expect(html).not.toContain('Pending approval');
  });
});
