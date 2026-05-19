/**
 * Tool-cap helper — extracted from kin-engine.ts so it's testable
 * without dragging in the full engine module graph (and the mock-
 * pollution surface that comes with it).
 *
 * Reads `LLMProvider.defaultMaxTools` from the registered provider;
 * falls back to a conservative default when the provider type is
 * unknown or the provider didn't declare a value.
 *
 * Provider-agnostic on purpose: zero hardcoded type names here. New
 * providers (built-in or plugin) declare their cap on themselves and
 * KinBot picks it up automatically.
 */

import { getLLMProvider } from '@/server/llm/llm/registry'

/** OpenAI-compatible conservative limit — matches every major
 *  provider's documented cap when one exists. Used when the provider
 *  type is unknown or declined to declare its own limit. */
export const DEFAULT_MAX_LLM_TOOLS = 128

export function getMaxToolsForProvider(providerType: string | null): number {
  if (!providerType) return DEFAULT_MAX_LLM_TOOLS
  const provider = getLLMProvider(providerType)
  return provider?.defaultMaxTools ?? DEFAULT_MAX_LLM_TOOLS
}
