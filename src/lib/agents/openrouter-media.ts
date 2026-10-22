/**
 * The OpenRouter media seam for the autonomous agent worker.
 *
 * Every generation call lives behind a named async function that takes the ORG's
 * already-decrypted OpenRouter key as its first param. This module never reads or
 * decrypts keys and never logs them. It is the ONE module agent/runner unit tests
 * mock, so CI never spends money. Importing it is key-free (providers are built
 * per call).
 */

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateImage as aiGenerateImage, generateText } from 'ai';
import { usdToCents } from '@/lib/agents/costs';

/**
 * `cost_cents` is what the provider reported for the call, in whole cents, or `null`
 * when it reported nothing. `null` is NOT zero: the caller counts such a step at its
 * estimate (see costs.ts) so the spend caps never read an unreported cost as free.
 */
export type DigestResult = { text: string; cost_cents: number | null };
export type ImageResult = { bytes: Uint8Array; contentType: string; cost_cents: number | null };
export type VideoStart = { jobId: string; cost_cents: number | null };
export type VideoCheck = {
  status: 'pending' | 'done' | 'failed';
  url?: string;
  /** Reported once the job has ended; absent while it is still rendering. */
  cost_cents?: number | null;
};

/** Fallback slugs; override via env so self-hosters can swap models. */
const SEARCH_MODEL = () => process.env.OPENKUASA_MODEL_AGENT_SEARCH?.trim() || 'perplexity/sonar';
const DIGEST_MODEL = () =>
  process.env.OPENKUASA_MODEL_AGENT_DIGEST?.trim() || 'anthropic/claude-sonnet-4.5';
const IMAGE_MODEL = () =>
  process.env.OPENKUASA_MODEL_AGENT_IMAGE?.trim() || 'google/gemini-2.5-flash-image';
const VIDEO_MODEL = () =>
  process.env.OPENKUASA_MODEL_AGENT_VIDEO?.trim() || 'google/veo-3.1';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

function provider(apiKey: string) {
  return createOpenRouter({ apiKey, appName: 'OpenKuasa', appUrl: 'https://openkuasa.com' });
}

/** The cost the provider attached to a call, or null when it attached none. */
function costFromMetadata(meta: unknown): number | null {
  const openrouter = (meta as { openrouter?: { usage?: { cost?: number }; cost?: number } } | undefined)
    ?.openrouter;
  return usdToCents(openrouter?.usage?.cost ?? openrouter?.cost);
}

async function complete(apiKey: string, modelId: string, prompt: string): Promise<DigestResult> {
  const { text, providerMetadata } = await generateText({
    model: provider(apiKey)(modelId),
    prompt,
  });
  return { text, cost_cents: costFromMetadata(providerMetadata) };
}

/** Web-grounded research. Uses a search-native model; append `:online` to any slug via env to ground it instead. */
export async function webSearch(apiKey: string, query: string): Promise<DigestResult> {
  return complete(apiKey, SEARCH_MODEL(), query);
}

export async function writeDigest(apiKey: string, context: string): Promise<DigestResult> {
  return complete(apiKey, DIGEST_MODEL(), context);
}

/**
 * Asks the model WHICH of the given candidate changes to queue for owner approval,
 * with a one-line rationale each. It only sees `{ index, title }` (never raw ids) and
 * can only select indexes; it cannot invent actions or inputs. The caller re-validates
 * every selection server-side, so malformed or hostile output is simply dropped.
 */
export async function suggestProposals(
  apiKey: string,
  prompt: string,
): Promise<{ keep: { index: number; rationale: string; name?: string }[]; cost_cents: number | null }> {
  const { text, cost_cents } = await complete(apiKey, DIGEST_MODEL(), prompt);
  const keep: { index: number; rationale: string; name?: string }[] = [];
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed: unknown = JSON.parse(match[0]);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const { index, rationale, name } = (item ?? {}) as {
            index?: unknown;
            rationale?: unknown;
            name?: unknown;
          };
          if (typeof index === 'number' && Number.isInteger(index) && typeof rationale === 'string') {
            const named = typeof name === 'string' && name.trim() ? { name: name.trim() } : {};
            keep.push({ index, rationale: rationale.trim(), ...named });
          }
        }
      }
    } catch {
      // Unparseable model output: select nothing.
    }
  }
  return { keep, cost_cents };
}

export async function generateImage(apiKey: string, prompt: string): Promise<ImageResult> {
  // Task: verify at smoke — image model slug + that providerMetadata carries cost.
  const result = await aiGenerateImage({
    model: provider(apiKey).imageModel(IMAGE_MODEL()),
    prompt,
  });
  const image = result.image;
  return {
    bytes: image.uint8Array,
    contentType: image.mediaType || 'image/png',
    cost_cents: costFromMetadata(result.providerMetadata),
  };
}

type VideoSubmit = { id?: string; usage?: { cost?: number } };
type VideoPoll = { status?: string; unsigned_urls?: string[]; usage?: { cost?: number } };

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

/** Starts an async video job (POST /videos) and returns its id; poll with checkVideo. */
export async function startVideo(apiKey: string, prompt: string): Promise<VideoStart> {
  // Task: verify at smoke — request body fields + model slug (shape taken from provider v3.1.0 source).
  const res = await fetch(`${OPENROUTER_BASE}/videos`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({ model: VIDEO_MODEL(), prompt }),
  });
  if (!res.ok) throw new Error(`OpenRouter video start failed (${res.status}).`);
  const json = (await res.json()) as VideoSubmit;
  if (!json.id) throw new Error('OpenRouter video start returned no job id.');
  // The cost is only known on completion, so submit usually reports none (null):
  // the caller books an estimate now and checkVideo supplies the real figure later.
  return { jobId: json.id, cost_cents: usdToCents(json.usage?.cost) };
}

export async function checkVideo(apiKey: string, jobId: string): Promise<VideoCheck> {
  const res = await fetch(`${OPENROUTER_BASE}/videos/${encodeURIComponent(jobId)}`, {
    headers: authHeaders(apiKey),
  });
  if (!res.ok) throw new Error(`OpenRouter video status failed (${res.status}).`);
  const json = (await res.json()) as VideoPoll;
  // A job that has ended reports what it cost in `usage.cost` (the provider SDK's
  // poll schema); null when it does not, and the caller keeps its estimate.
  const cost_cents = usdToCents(json.usage?.cost);
  if (json.status === 'completed') {
    return { status: 'done', url: json.unsigned_urls?.[0], cost_cents };
  }
  if (['failed', 'dead', 'cancelled', 'expired'].includes(json.status ?? '')) {
    return { status: 'failed', cost_cents };
  }
  return { status: 'pending' };
}
