'use client';

import { AcknowledgeButton } from './acknowledge-button';

/**
 * "I have read this" on an issued letter addressed to the viewer: the one shared acknowledge button, for a letter.
 * It names no action itself; the action takes only the letter id and never says who is acknowledging.
 */
export function AcknowledgeLetterButton({ letterId }: { letterId: string }) {
  return <AcknowledgeButton id={letterId} kind="letter" />;
}
