/**
 * Unit tests for the two provider-tunable knobs introduced in the SDK:
 *   - `LLMProvider.defaultMaxTools`  → read by `getMaxToolsForProvider`
 *   - `LLMProvider.billing`          → read by `providerPriority`
 *
 * Both replaced provider-specific switches in the engine / resolver,
 * so the host now relies entirely on the provider declaring the right
 * value on itself. Coverage here keeps a future SDK shape change from
 * silently breaking the tool-cap or auto-resolution paths.
 */

import { describe, it, expect, beforeAll } from 'bun:test'
import { getMaxToolsForProvider } from '@/server/services/tool-cap'
import { providerPriority } from '@/server/llm/core/provider-priority'
import { registerBuiltinLLMProviders } from '@/server/llm/llm/register'

// The registry is empty until the host calls registerBuiltinLLMProviders
// at startup. Tests live below that boot path, so we replay it once.
beforeAll(() => {
  registerBuiltinLLMProviders()
})

describe('getMaxToolsForProvider', () => {
  it('reads defaultMaxTools from the built-in OpenAI provider (128)', () => {
    expect(getMaxToolsForProvider('openai')).toBe(128)
  })

  it('reads defaultMaxTools from the built-in OpenAI Codex provider (128)', () => {
    expect(getMaxToolsForProvider('openai-codex')).toBe(128)
  })

  it('reads defaultMaxTools from the built-in Anthropic provider (512)', () => {
    expect(getMaxToolsForProvider('anthropic')).toBe(512)
  })

  it('reads defaultMaxTools from the built-in Anthropic OAuth provider (512)', () => {
    expect(getMaxToolsForProvider('anthropic-oauth')).toBe(512)
  })

  it('falls back to the conservative default for an unknown provider type', () => {
    // 128 matches DEFAULT_MAX_LLM_TOOLS in kin-engine.ts. Bumping that
    // constant requires bumping this assertion in lockstep.
    expect(getMaxToolsForProvider('plugin:made-up-vendor')).toBe(128)
  })

  it('falls back when providerType is null (no Kin model selected yet)', () => {
    expect(getMaxToolsForProvider(null)).toBe(128)
  })
})

describe('providerPriority (auto-resolution tie-breaker)', () => {
  it('subscription providers (Anthropic OAuth, OpenAI Codex) outrank per-token', () => {
    expect(providerPriority('anthropic-oauth')).toBe(1)
    expect(providerPriority('openai-codex')).toBe(1)
  })

  it('per-token providers (Anthropic key, OpenAI key) sort last', () => {
    expect(providerPriority('anthropic')).toBe(2)
    expect(providerPriority('openai')).toBe(2)
  })

  it('unknown provider types default to per-token priority (most conservative)', () => {
    expect(providerPriority('plugin:made-up-vendor')).toBe(2)
  })

  it('subscriptions strictly beat per-token in the sort order', () => {
    expect(providerPriority('anthropic-oauth')).toBeLessThan(providerPriority('anthropic'))
    expect(providerPriority('openai-codex')).toBeLessThan(providerPriority('openai'))
  })
})
