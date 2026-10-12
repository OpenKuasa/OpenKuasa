/**
 * Marks a system prompt for the provider to cache.
 *
 * An assistant's prompt is the same on every call of a turn, and on every turn
 * for a few minutes after. Marked this way, a model that supports it (the
 * Anthropic models, through OpenRouter) bills the repeated prompt, and the tool
 * list sent before it, at a fraction of the usual price; a model that does not
 * support it ignores the mark.
 *
 * Only for a prompt that is word for word the same from one call to the next. A
 * prompt that carries the time of day would be written to the cache on every
 * call and never read back, which costs more than not caching.
 */
import type { SystemModelMessage } from 'ai';

export function cachedInstructions(prompt: string): SystemModelMessage {
  return {
    role: 'system',
    content: prompt,
    providerOptions: { openrouter: { cacheControl: { type: 'ephemeral' } } },
  };
}
