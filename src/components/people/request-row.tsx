'use client';

import { createContext, type ReactNode, useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { TableCell, TableRow } from '@/components/ui/table';

const PromptSlot = createContext<HTMLElement | null>(null);

/**
 * One request in an approvals table: its row, and under it a full-width row that appears only while a control in
 * the row has a prompt open (a reject note, a cancel or undo question, the Mark paid form). The prompts need room
 * the Action column does not have; `RowPrompt` puts them here. The row stays hidden while nothing is in it.
 */
export function RequestRow({ columns, children }: { columns: number; children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <PromptSlot.Provider value={slot}>
      <TableRow>{children}</TableRow>
      <TableRow className="hidden border-t-0 hover:bg-transparent has-[[data-prompt-slot]>*]:table-row">
        <TableCell colSpan={columns} className="pt-0">
          {/* Sticky so that, if the table is scrolled sideways, the prompt stays where the person is looking. */}
          <div
            ref={setSlot}
            data-prompt-slot
            className="sticky left-0 w-fit max-w-[min(48rem,calc(100vw-3rem))] space-y-1.5 whitespace-normal"
          />
        </TableCell>
      </TableRow>
    </PromptSlot.Provider>
  );
}

/** Shows `children` in the row's prompt area; on its own (outside an `RequestRow`) it shows them in place. */
export function RowPrompt({ children }: { children: ReactNode }) {
  const slot = useContext(PromptSlot);
  return slot ? createPortal(children, slot) : <>{children}</>;
}
