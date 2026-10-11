/**
 * One log line per model call: who made it, how long it took and what it
 * used. An answer from Tuah's team is several calls (Tuah, then a specialist,
 * then Tuah again), so this is how to see where an answer's time and cost go.
 * Nothing of the conversation is logged.
 */

type CallEnd = {
  modelId?: string;
  finishReason: unknown;
  usage: { inputTokens: number | undefined; outputTokens: number | undefined };
  performance: { responseTimeMs: number };
};

export function logModelCall(agent: string, model: string) {
  return (call: CallEnd) => {
    const finish =
      typeof call.finishReason === 'string'
        ? call.finishReason
        : ((call.finishReason as { unified?: string } | null)?.unified ?? 'unknown');
    console.info(
      `[ai] agent=${agent} model=${call.modelId || model} ms=${Math.round(call.performance.responseTimeMs)} ` +
        `in=${call.usage.inputTokens ?? '?'} out=${call.usage.outputTokens ?? '?'} finish=${finish}`,
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
