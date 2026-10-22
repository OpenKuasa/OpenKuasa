/**
 * LLM provider factory for the Ask-Jebat agent.
 *
 * Provider-agnostic by design (AGPL self-hosters swap with env alone): OpenRouter
 * is the default — one key, any model — with the model chosen *per layer* so the
 * orchestrator can run a strong model while sub-agents run a cheap/fast one.
 *
 * The provider instance is created lazily, so importing this module never throws
 * when `OPENROUTER_API_KEY` is unset (keeps builds and unit tests key-free).
 */

import 'server-only';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';

export type AgentLayer = 'orchestrator' | 'worker';

/** Fallbacks used only when the per-layer env var is unset. Override via env; exact slugs at https://openrouter.ai/models */
const FALLBACK_MODEL: Record<AgentLayer, string> = {
  orchestrator: 'anthropic/claude-sonnet-4.5',
  worker: 'anthropic/claude-haiku-4.5',
};

type EnvLike = Record<string, string | undefined>;

/** Pure model-id resolution (env → fallback), extracted for unit testing. */
export function pickModelId(layer: AgentLayer, env: EnvLike = process.env): string {
  const fromEnv =
    layer === 'orchestrator'
      ? env.OPENKUASA_MODEL_ORCHESTRATOR
      : env.OPENKUASA_MODEL_WORKER;
  return fromEnv?.trim() || FALLBACK_MODEL[layer];
}

/** True when a provider key is configured — lets the route return a clean 503 instead of crashing. */
export function hasProviderKey(env: EnvLike = process.env): boolean {
  return Boolean(env.OPENROUTER_API_KEY?.trim());
}

function createProvider(apiKey: string) {
  return createOpenRouter({
    apiKey,
    // Optional second intermediary (Cloudflare AI Gateway); off unless configured.
    baseURL: process.env.AI_GATEWAY_BASE_URL?.trim() || undefined,
    appName: 'OpenKuasa',
    appUrl: 'https://openkuasa.com',
  });
}

/**
 * The OpenRouter session a model's calls belong to. Through OpenRouter one model is served by several providers (for
 * Claude: Anthropic, Amazon, Google), and each keeps its own prompt cache. Without a session OpenRouter keeps calls on
 * one provider only after a cache hit, and guesses the conversation from its first messages, so a call can land on a
 * provider whose cache is cold and pay to write the whole prompt again. With a session it keeps every call on one
 * provider from the first (and still moves when that provider fails). The cached prompt is the same for every user of
 * an assistant, so the session is the model alone: nothing about the workspace or the person is in it.
 */
export const routingSession = (modelId: string) => `openkuasa:${modelId}`.slice(0, 256);

/** A model of `provider`, in its routing session. */
const inSession = (provider: ReturnType<typeof createOpenRouter>, modelId: string): LanguageModel =>
  provider(modelId, { extraBody: { session_id: routingSession(modelId) } });

let platformProvider: ReturnType<typeof createOpenRouter> | null = null;

function getPlatformProvider() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set — chat cannot reach the model.');
  }
  platformProvider ??= createProvider(apiKey);
  return platformProvider;
}

/**
 * The model for a given agent layer. Pass a workspace's own key to bill that
 * workspace (bring-your-own-key); omit it to use the platform key.
 */
export function getModel(layer: AgentLayer, apiKey?: string): LanguageModel {
  // A workspace provider is built per request so keys are never cached.
  const provider = apiKey ? createProvider(apiKey) : getPlatformProvider();
  return inSession(provider, pickModelId(layer));
}

/**
 * A model named by the caller, on a workspace's own key and never the
 * platform's: for a feature that takes its model id from its own environment
 * variable and has no fallback id in code (reading a receipt). An empty key or
 * id is refused rather than handed to the provider.
 */
export function getWorkspaceModelById(modelId: string, apiKey: string): LanguageModel {
  if (!apiKey.trim() || !modelId.trim()) throw new Error('A workspace model needs a key and a model id.');
  // Built per request so keys are never cached.
  return inSession(createProvider(apiKey), modelId.trim());
}
