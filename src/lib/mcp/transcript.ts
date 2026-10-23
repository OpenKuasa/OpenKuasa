/**
 * A per-credential record of what an MCP caller's tools did, laid out as an AI SDK conversation so Tuah's guards
 * (which read conversation messages) run unchanged for MCP calls. Memory only; it expires an hour after last use.
 * Nothing here writes message contents anywhere.
 */

import type { ModelMessage } from 'ai';

/** `${credentialId}:${userId}` */
export type TranscriptKey = string;

export type TranscriptStore = {
  /** A fresh copy of the conversation so far; the caller may change it. */
  messages(key: TranscriptKey): ModelMessage[];
  recordCall(key: TranscriptKey, call: { toolCallId: string; toolName: string; input: unknown; output: unknown }): void;
  /** Starts a new turn: appends a synthetic user message after a completed change. */
  endTurn(key: TranscriptKey): void;
  /** A prepared change: the call plus an approval request carrying the note, so `cardShown()` finds it. */
  recordNote(key: TranscriptKey, call: { toolCallId: string; toolName: string; input: unknown; note: string }): void;
  clear(key: TranscriptKey): void;
};

/** Not a person's words: the guards only need a user message to mark where a turn begins. */
export const NEXT_REQUEST_TEXT = '[next request]';

type Item = { messages: ModelMessage[]; isCall: boolean };
type Entry = { items: Item[]; calls: number; touchedAt: number };

const callMessage = (call: { toolCallId: string; toolName: string; input: unknown }, extra: object[] = []): ModelMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }, ...extra],
  }) as ModelMessage;

const copyOf = (message: ModelMessage): ModelMessage =>
  Array.isArray(message.content)
    ? ({ ...message, content: (message.content as object[]).map((part) => ({ ...part })) } as ModelMessage)
    : { ...message };

export function memoryTranscriptStore(opts: { ttlMs?: number; maxCalls?: number; now?: () => number } = {}): TranscriptStore {
  const ttlMs = opts.ttlMs ?? 3_600_000;
  const maxCalls = opts.maxCalls ?? 200;
  const now = opts.now ?? Date.now;
  const entries = new Map<TranscriptKey, Entry>();

  /** The live entry for a key, created when asked to; an expired one is dropped first. */
  const entryFor = (key: TranscriptKey, create: boolean): Entry | undefined => {
    const at = now();
    const found = entries.get(key);
    if (found && at - found.touchedAt > ttlMs) entries.delete(key);
    else if (found) {
      found.touchedAt = at;
      return found;
    }
    if (!create) return undefined;
    const fresh: Entry = { items: [], calls: 0, touchedAt: at };
    entries.set(key, fresh);
    return fresh;
  };

  const add = (entry: Entry, item: Item) => {
    entry.items.push(item);
    if (item.isCall) entry.calls += 1;
    while (entry.calls > maxCalls) {
      const dropped = entry.items.shift();
      if (dropped?.isCall) entry.calls -= 1;
    }
  };

  return {
    messages(key) {
      const entry = entryFor(key, false);
      return entry ? entry.items.flatMap((item) => item.messages.map(copyOf)) : [];
    },
    recordCall(key, call) {
      const entry = entryFor(key, true)!;
      add(entry, {
        isCall: true,
        messages: [
          callMessage(call),
          {
            role: 'tool',
            content: [
              { type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'json', value: call.output ?? null } },
            ],
          } as ModelMessage,
        ],
      });
    },
    endTurn(key) {
      const entry = entryFor(key, true)!;
      add(entry, { isCall: false, messages: [{ role: 'user', content: NEXT_REQUEST_TEXT }] });
    },
    recordNote(key, call) {
      const entry = entryFor(key, true)!;
      add(entry, {
        isCall: true,
        messages: [
          callMessage(call, [
            { type: 'tool-approval-request', approvalId: `note-${call.toolCallId}`, toolCallId: call.toolCallId, reason: call.note },
          ]),
        ],
      });
    },
    clear(key) {
      entries.delete(key);
    },
  };
}

/** The process-wide instance. */
export const transcripts: TranscriptStore = memoryTranscriptStore();
