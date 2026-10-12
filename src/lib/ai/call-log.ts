/**
 * One log line per model call: who made it, how long it took and what it
 * used. An answer from Tuah's team is several calls (Tuah, then a specialist,
 * then Tuah again), so this is how to see where an answer's time and cost go.
 * Nothing of the conversation is logged.
 */

type CallEnd = {
  modelId?: string;
  finishReason: unknown;
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    /** How much of the input was read from, and written to, the provider's prompt cache. */
    inputTokenDetails?: { cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined };
  };
  performance: { responseTimeMs: number };
};

export function logModelCall(agent: string, model: string) {
  return (call: CallEnd) => {
    const finish =
      typeof call.finishReason === 'string'
        ? call.finishReason
        : ((call.finishReason as { unified?: string } | null)?.unified ?? 'unknown');
    const cache = call.usage.inputTokenDetails;
    console.info(
      `[ai] agent=${agent} model=${call.modelId || model} ms=${Math.round(call.performance.responseTimeMs)} ` +
        // `cached` is input read from the prompt cache (billed at a fraction), `wrote` is input written to it.
        `in=${call.usage.inputTokens ?? '?'} cached=${cache?.cacheReadTokens ?? 0} wrote=${cache?.cacheWriteTokens ?? 0} ` +
        `out=${call.usage.outputTokens ?? '?'} finish=${finish}`,
    );
  };
}

/**
 * What may be logged of a failed model call: its status or code, else the
 * error's class name, and nothing more. A provider's error carries the request
 * it failed on (`requestBodyValues`), and a request can hold a file the model
 * was given to read, so the error itself and its message are never logged.
 */
export function modelErrorCode(error: unknown): { code: unknown } {
  const { statusCode, code, name } = (
    error && typeof error === 'object' ? error : {}
  ) as { statusCode?: unknown; code?: unknown; name?: unknown };
  const first = statusCode ?? code ?? name;
  // A status or a short label only: an object here could be anything, and a string is cut.
  if (typeof first === 'number') return { code: first };
  return { code: typeof first === 'string' ? first.slice(0, 64) : undefined };
}

/**
 * What may be logged of a failed read or write: the database's or storage's
 * code (`23505`, `PGRST116`, a status), else the error's class name. Never its
 * message: a constraint or validation message quotes the values it refused,
 * and those are a contact's details, a salary, a file's name.
 */
export function errorCodeOf(error: unknown): string {
  const { code, statusCode, status, name } = (error && typeof error === 'object' ? error : {}) as {
    code?: unknown;
    statusCode?: unknown;
    status?: unknown;
    name?: unknown;
  };
  const first = [code, statusCode, status, name].find((v) => typeof v === 'string' || typeof v === 'number');
  return first === undefined ? 'unknown' : String(first).slice(0, 64);
}

/**
 * The `onError` of a chat route's stream: logs the tag and a code, and answers
 * with the sentence the user is shown. Every chat route uses it, so none logs
 * the error itself, which carries the chat and any file attached to it.
 */
export function streamErrorHandler(tag: string, message: string) {
  return (error: unknown): string => {
    console.error(`[${tag}] stream error:`, modelErrorCode(error));
    return message;
  };
}

/**
 * The `onError` for every model call. Without one the AI SDK logs the whole
 * error object, request body included.
 */
export function logModelError(agent: string) {
  return ({ error }: { error: unknown }) => {
    console.error(`[ai] ${agent} model call failed:`, modelErrorCode(error));
  };
}
