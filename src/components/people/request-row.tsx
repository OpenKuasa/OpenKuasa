'use client';

import { createContext, type ReactNode, useContext, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TableCell, TableRow } from '@/components/ui/table';

const PromptSlot = createContext<{ slot: HTMLElement | null; id: string | undefined }>({ slot: null, id: undefined });

/** The id of the row's prompt area, for `aria-controls` on the buttons that open a prompt. */
export function usePromptId(): string | undefined {
  return useContext(PromptSlot).id;
}

/**
 * One request in an approvals table: its row, and under it a full-width row that appears only while a control in
 * the row has a prompt open (a reject note, a cancel or undo question, the Mark paid form). The prompts need room
 * the Action column does not have; `RowPrompt` puts them here. The row stays hidden while nothing is in it.
 */
export function RequestRow({ columns, children }: { columns: number; children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const id = useId();
  return (
    <PromptSlot.Provider value={{ slot, id }}>
      {/* The prompt row is the body's last child, which would strip the border from the last row's neighbour:
          so the request's own row is borderless when it is the second-to-last, i.e. the last request. */}
      <TableRow className="nth-last-2:border-0">{children}</TableRow>
      <TableRow className="hidden border-t-0 hover:bg-transparent has-[[data-prompt-slot]>*]:table-row">
        <TableCell colSpan={columns} className="pt-0">
          {/* Sticky so that, if the table is scrolled sideways, the prompt stays where the person is looking. */}
          <div
            id={id}
            ref={setSlot}
            data-prompt-slot
            className="sticky left-0 w-fit max-w-[min(48rem,calc(100vw-3rem))] space-y-1.5 whitespace-normal"
          />
        </TableCell>
      </TableRow>
    </PromptSlot.Provider>
  );
}

/**
 * Shows `children` in the row's prompt area; on its own (outside a `RequestRow`) it shows them in place.
 * When `focusKey` changes to something non-empty, focus moves to the prompt's `data-autofocus` control, or else
 * its first control (a destructive question marks its safe button). Escape calls `onEscape`, which closes the prompt.
 */
export function RowPrompt({
  children,
  focusKey,
  onEscape,
}: {
  children: ReactNode;
  focusKey: string;
  onEscape: () => void;
}) {
  const { slot } = useContext(PromptSlot);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusKey) return;
    const root = body.current;
    const target =
      root?.querySelector<HTMLElement>('[data-autofocus]:not([disabled])') ??
      root?.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled])');
    target?.focus();
  }, [focusKey, slot]);
  const content = (
    <div
      ref={body}
      className="space-y-1.5"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onEscape();
      }}
    >
      {children}
    </div>
  );
  return slot ? createPortal(content, slot) : content;
}
