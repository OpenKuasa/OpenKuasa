/**
 * Files sent along with a chat question: what may be attached, how a saved
 * thread remembers them, and how text files reach the model.
 */

import type { UIMessage } from 'ai';

/** What the file picker offers: pictures, PDFs and plain-text documents. */
export const ATTACH_ACCEPT = 'image/*,application/pdf,.txt,.csv,.md';
export const MAX_ATTACHMENTS = 4;
/**
 * Room for attachments in one request, counted as sent (base64). The chat
 * endpoint refuses a body over 12 MB, and files stay in the conversation, so
 * this is checked against everything the next question would carry.
 */
export const MAX_ATTACHMENT_CHARS = 10 * 1024 * 1024;

/**
 * What the chat endpoint itself allows, whatever the browser sent. A turn on a
 * workspace's own key gets the room the picker offers; a free question on the
 * platform key gets much less, since the platform pays for what the model reads.
 * `bytes` is the decoded size of every file the request carries, history included.
 */
export type AttachmentLimits = { perMessage: number; files: number; bytes: number };
export const WORKSPACE_ATTACHMENT_LIMITS: AttachmentLimits = {
  perMessage: MAX_ATTACHMENTS,
  files: 24,
  bytes: 8 * 1024 * 1024,
};
export const FREE_ATTACHMENT_LIMITS: AttachmentLimits = {
  perMessage: 1,
  files: 2,
  bytes: 2 * 1024 * 1024,
};

/** The only types a file may reach storage or a model as. Decided from the file's bytes, never from its label. */
export const ALLOWED_ATTACHMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
] as const;
export type AttachmentType = (typeof ALLOWED_ATTACHMENT_TYPES)[number];

export type FilePart = {
  type: 'file';
  mediaType: string;
  url: string;
  filename?: string;
};

export function isFilePart(part: unknown): part is FilePart {
  if (!part || typeof part !== 'object') return false;
  const { type, url, mediaType } = part as Record<string, unknown>;
  return type === 'file' && typeof url === 'string' && typeof mediaType === 'string';
}

const TEXT_NAME = /\.(txt|csv|md)$/i;

function isTextFile(part: FilePart): boolean {
  return part.mediaType.startsWith('text/') || TEXT_NAME.test(part.filename ?? '');
}

/** True for a file the assistant can read: a picture, a PDF or plain text. */
export function isAttachable(part: FilePart): boolean {
  return (
    part.mediaType.startsWith('image/') ||
    part.mediaType === 'application/pdf' ||
    isTextFile(part)
  );
}

/**
 * How a saved thread remembers attachments: by name. The files themselves are
 * not stored, so reading a thread back shows this line in their place.
 */
export function attachmentNote(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  const names = parts
    .filter(isFilePart)
    .map((part) => part.filename?.trim() || 'a file');
  return names.length > 0 ? `[Attached: ${names.join(', ')}]` : null;
}

/** Characters of attachment data in a set of messages, as they would be sent. */
export function attachmentChars(messages: { parts: unknown[] }[]): number {
  let total = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (isFilePart(part)) total += part.url.length;
    }
  }
  return total;
}

// A long export should not crowd the question out of the model's context.
const TEXT_FILE_MAX_CHARS = 60_000;

const startsWith = (bytes: Uint8Array, signature: number[], at = 0): boolean =>
  bytes.length >= at + signature.length && signature.every((byte, i) => bytes[at + i] === byte);

/** A picture or PDF, told by its first bytes. Null for anything else, an SVG included (it is text that can run script). */
function sniffBinary(bytes: Uint8Array): AttachmentType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif';
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  return null;
}

/** True for bytes that read as UTF-8 words: no NUL, and nothing the decoder refuses. */
function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * What a file really is, or null when it may not be attached. The label the
 * browser sent (`mediaType`) only says whether the sender meant a text file:
 * a picture or PDF is known by its first bytes, a text file must read as text,
 * and everything else (an SVG, an archive, a video, a picture type no model is
 * sent) is refused.
 */
export function sniffAttachment(
  bytes: Uint8Array,
  claimed: { mediaType: string; filename?: string },
): AttachmentType | null {
  const binary = sniffBinary(bytes);
  if (binary) return binary;
  const meantAsText =
    (claimed.mediaType.startsWith('text/') || TEXT_NAME.test(claimed.filename ?? '')) &&
    !/\.svg$/i.test(claimed.filename ?? '');
  return meantAsText && isUtf8Text(bytes) ? 'text/plain' : null;
}

/** The bytes of a `data:` URL, or null when it is not one or cannot be decoded. */
export function dataUrlBytes(url: string): Uint8Array | null {
  const match = /^data:[^,]*?(;base64)?,([\s\S]*)$/.exec(url);
  if (!match) return null;
  try {
    if (!match[1]) return new TextEncoder().encode(decodeURIComponent(match[2]));
    // Strict: `atob` throws on anything that is not base64.
    return Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

export type AttachmentProblem = 'type' | 'count' | 'size';

/**
 * Checks every file a request carries and rewrites each one's type to what its
 * bytes say, so nothing downstream (storage, the model) acts on the browser's
 * label. Files are only taken on the user's own messages. Refuses the lot on
 * the first file that may not be attached, or when there are too many or they
 * are too large.
 */
export function checkAttachments<M extends { role: string; parts: unknown[] }>(
  messages: M[],
  limits: AttachmentLimits,
): { ok: true; messages: M[] } | { ok: false; problem: AttachmentProblem } {
  let files = 0;
  let bytes = 0;
  const checked: M[] = [];
  for (const message of messages) {
    if (!message.parts.some(isFilePart)) {
      checked.push(message);
      continue;
    }
    // An answer never carries a file: one on an assistant message was not put there by the server.
    if (message.role !== 'user') {
      checked.push({ ...message, parts: message.parts.filter((part) => !isFilePart(part)) });
      continue;
    }
    let here = 0;
    const parts: unknown[] = [];
    for (const part of message.parts) {
      if (!isFilePart(part)) {
        parts.push(part);
        continue;
      }
      const data = dataUrlBytes(part.url);
      const type = data ? sniffAttachment(data, part) : null;
      if (!data || !type) return { ok: false, problem: 'type' };
      here += 1;
      files += 1;
      bytes += data.length;
      if (here > limits.perMessage || files > limits.files) return { ok: false, problem: 'count' };
      if (bytes > limits.bytes) return { ok: false, problem: 'size' };
      parts.push({ ...part, mediaType: type, url: `data:${type};base64,${toBase64(data)}` });
    }
    checked.push({ ...message, parts });
  }
  return { ok: true, messages: checked };
}

function decodeDataUrl(url: string): string | null {
  const match = /^data:[^,]*?(;base64)?,([\s\S]*)$/.exec(url);
  if (!match) return null;
  try {
    if (!match[1]) return decodeURIComponent(match[2]);
    const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Turns attached text files (.txt, .csv, .md) into words in the message.
 * Models take pictures and PDFs as files, but a plain-text file sent that way
 * is not reliably read, so its contents go in as text instead.
 */
export function inlineTextFiles(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== 'user' || !message.parts.some((p) => isFilePart(p) && isTextFile(p))) {
      return message;
    }
    const parts = message.parts.map((part) => {
      if (!isFilePart(part) || !isTextFile(part)) return part;
      const name = part.filename?.trim() || 'attachment';
      const content = decodeDataUrl(part.url);
      if (content == null) {
        return { type: 'text' as const, text: `\n\n[Attached file "${name}" could not be read.]` };
      }
      const cut = content.length > TEXT_FILE_MAX_CHARS;
      return {
        type: 'text' as const,
        text: `\n\nAttached file "${name}"${cut ? ' (start of the file only)' : ''}:\n${content.slice(0, TEXT_FILE_MAX_CHARS)}`,
      };
    });
    return { ...message, parts };
  });
}
