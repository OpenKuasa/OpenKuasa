/**
 * What a saved chat message is made of. Words, the lookups and changes an
 * answer went through, and pointers to the files a question came with. Rows
 * are written by the chat route and read back by the history actions; both
 * go through `storedParts`, so nothing else ever reaches the screen.
 */

export type StoredTextPart = { type: 'text'; text: string };

/** A lookup or change, as the chat UI renders it. */
export type StoredToolPart = {
  type: `tool-${string}`;
  toolCallId: string;
  state: ToolState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; reason?: string; requestReason?: string };
};

/** A file kept in storage, by its path there. Never sent to the browser as is. */
export type StoredFileRef = {
  type: 'file';
  mediaType: string;
  filename?: string;
  path: string;
};

export type StoredPart = StoredTextPart | StoredToolPart | StoredFileRef;

// A call still being written (`input-streaming`) is not worth keeping.
const TOOL_STATES = [
  'input-available',
  'approval-requested',
  'approval-responded',
  'output-available',
  'output-error',
  'output-denied',
] as const;
type ToolState = (typeof TOOL_STATES)[number];

// A long listing is for the model, not for reading back later.
const OUTPUT_MAX_CHARS = 30_000;

function toolPart(raw: Record<string, unknown>): StoredToolPart | null {
  const { type, toolCallId, state } = raw;
  if (typeof type !== 'string' || !type.startsWith('tool-') || type.length > 80) return null;
  if (typeof toolCallId !== 'string' || !toolCallId) return null;
  if (!TOOL_STATES.includes(state as ToolState)) return null;

  const part: StoredToolPart = {
    type: type as `tool-${string}`,
    toolCallId,
    state: state as ToolState,
    // The chat UI and the model both expect a call to carry its input.
    input: raw.input ?? {},
  };
  if (raw.output !== undefined) {
    const size = JSON.stringify(raw.output)?.length ?? 0;
    part.output = size > OUTPUT_MAX_CHARS ? { note: 'Result too long to keep.' } : raw.output;
  }
  if (typeof raw.errorText === 'string') part.errorText = raw.errorText.slice(0, 2_000);

  const approval = raw.approval as Record<string, unknown> | null | undefined;
  if (approval && typeof approval.id === 'string') {
    part.approval = { id: approval.id };
    if (typeof approval.approved === 'boolean') part.approval.approved = approval.approved;
    if (typeof approval.reason === 'string') part.approval.reason = approval.reason.slice(0, 500);
    // The line a card carried for the person deciding: a chat opened again must show the same card, and the server
    // checks on approval that a card which needed the line had it.
    if (typeof approval.requestReason === 'string') part.approval.requestReason = approval.requestReason.slice(0, 500);
  }
  // A change waiting for a yes or no is useless without the id to answer it.
  if ((part.state === 'approval-requested' || part.state === 'approval-responded') && !part.approval) {
    return null;
  }
  return part;
}

/** Keeps the parts of a message worth saving, in order, and drops the rest. */
export function storedParts(parts: unknown): StoredPart[] {
  if (!Array.isArray(parts)) return [];
  const kept: StoredPart[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const raw = part as Record<string, unknown>;
    if (raw.type === 'text') {
      if (typeof raw.text === 'string' && raw.text.trim()) {
        kept.push({ type: 'text', text: raw.text });
      }
    } else if (raw.type === 'file') {
      // Only files already in storage are kept; inline data is far too large.
      if (typeof raw.path === 'string' && raw.path && typeof raw.mediaType === 'string') {
        kept.push({
          type: 'file',
          mediaType: raw.mediaType,
          path: raw.path,
          ...(typeof raw.filename === 'string' ? { filename: raw.filename } : {}),
        });
      }
    } else {
      const tool = toolPart(raw);
      if (tool) kept.push(tool);
    }
  }
  return kept;
}

/**
 * Messages are only ever added. An answer that paused for an approval and
 * then went on is saved a second time, whole, once it finishes. So of answers
 * saved back to back with no question between them, the last is the answer.
 */
export function collapseResumes<T extends { role: 'user' | 'assistant' }>(rows: T[]): T[] {
  return rows.filter(
    (row, i) => !(row.role === 'assistant' && rows[i + 1]?.role === 'assistant'),
  );
}
