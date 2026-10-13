import { describe, expect, it } from 'vitest';
import { getWorkspaceModelById, hasProviderKey, pickModelId } from '@/lib/ai/provider';

describe('pickModelId', () => {
  it('uses the per-layer env var when set', () => {
    const env = {
      OPENKUASA_MODEL_ORCHESTRATOR: 'anthropic/claude-opus-4.5',
      OPENKUASA_MODEL_WORKER: 'openai/gpt-4o-mini',
    };
    expect(pickModelId('orchestrator', env)).toBe('anthropic/claude-opus-4.5');
    expect(pickModelId('worker', env)).toBe('openai/gpt-4o-mini');
  });

  it('falls back to a current default when the env var is unset or blank', () => {
    expect(pickModelId('orchestrator', {})).toBe('anthropic/claude-sonnet-4.5');
    expect(pickModelId('worker', { OPENKUASA_MODEL_WORKER: '   ' })).toBe('anthropic/claude-haiku-4.5');
  });
});

describe('getWorkspaceModelById', () => {
  it('is the model that was named, with no fallback, and is built without a platform key', () => {
    const before = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const model = getWorkspaceModelById(' some/vision-model:free ', 'sk-or-workspace') as { modelId?: string };
      expect(model.modelId).toBe('some/vision-model:free');
    } finally {
      if (before !== undefined) process.env.OPENROUTER_API_KEY = before;
    }
  });

  it('refuses an empty key or an empty id, so it can never fall through to another key or model', () => {
    expect(() => getWorkspaceModelById('some/model', '  ')).toThrow();
    expect(() => getWorkspaceModelById('  ', 'sk-or-workspace')).toThrow();
  });
});

describe('hasProviderKey', () => {
  it('is true only when OPENROUTER_API_KEY is a non-blank string', () => {
    expect(hasProviderKey({ OPENROUTER_API_KEY: 'sk-or-123' })).toBe(true);
    expect(hasProviderKey({ OPENROUTER_API_KEY: '' })).toBe(false);
    expect(hasProviderKey({})).toBe(false);
  });
});
