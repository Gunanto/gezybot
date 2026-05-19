/**
 * Auto-resolution tie-breaker — extracted from resolve.ts so it's
 * testable without dragging in the DB layer and the providers
 * dispatcher.
 *
 * Sort key for auto-detection: lower wins. Subscription providers go
 * first so the user's fixed-cost plan is preferred over pay-per-token
 * when both could serve the requested model. Reads the provider's
 * self-declared `billing` field on the LLMProvider — no hardcoded
 * provider type names; new providers slot in automatically once they
 * set `billing` on themselves.
 *
 * Provider not in the registry / billing not declared = treated as
 * `per-token` (the conservative default).
 */

import { getLLMProvider } from '@/server/llm/llm/registry'

export function providerPriority(type: string): number {
  const billing = getLLMProvider(type)?.billing ?? 'per-token'
  switch (billing) {
    case 'local':
      // No upstream cost at all — pick first.
      return 0
    case 'subscription':
      return 1
    case 'per-token':
    default:
      return 2
  }
}
