/**
 * Provider dispatcher — single front-door over the three native registries
 * (`llm`, `embedding`, `image`). Built-in providers (Anthropic, OpenAI, …)
 * and plugin-contributed providers register identically into these three
 * registries; nothing here knows or cares about the difference.
 *
 * Callers (routes/providers, tools/provider-tools, image-tools,
 * model-info-cache, image-generation, routes/kins, llm/core/resolve) get a
 * uniform `ProviderModel` shape regardless of which family answers, which
 * keeps the per-model UI generic.
 */

import type { ProviderConfig as KinbotProviderConfig } from '@/server/llm/core/types'
import type { ProviderCapability } from '@/shared/types'
import type { ImageModel, ImageModelParamsSchema } from '@kinbot-developer/sdk'
import { PROVIDER_META, type ProviderType, type ProviderMeta } from '@/shared/provider-metadata'
import { createLogger } from '@/server/logger'
import { getLLMProvider, listLLMProviders } from '@/server/llm/llm/registry'
import { getEmbeddingProvider, listEmbeddingProviders } from '@/server/llm/embedding/registry'
import { getImageProvider, listImageProviders } from '@/server/llm/image/registry'

const log = createLogger('providers')

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * The "lowest common denominator" model shape returned by the dispatcher.
 * Used by the UI / tools / routes that just need {id, name, capability,
 * contextWindow}. Family-specific fields (LLMModel.thinking, ImageModel
 * .supportedSizes, …) are intentionally squashed here — callers that need
 * them must reach into the native registry.
 */
export interface ProviderModel {
  id: string
  name: string
  capability: 'llm' | 'embedding' | 'image' | 'rerank'
  /** LLM models only — true when the chat can receive image blocks in
   *  user messages (vision-capable). Unrelated to image-generation. */
  supportsImageInput?: boolean
  /** Image-generation models only — how many source images this model
   *  accepts (0 = text-to-image, 1 = img2img / inpainting, N>1 = multi-
   *  reference like Nano Banana Pro or Flux-Kontext multi). Absent =
   *  unknown, treat as 0. */
  maxImageInputs?: number
  /** Maximum input/context tokens. Populated when the provider's API exposes it. */
  contextWindow?: number
  /** Maximum output tokens. Populated when the provider's API exposes it. */
  maxOutput?: number
}

// ─── Metadata helpers ───────────────────────────────────────────────────────

/**
 * Derive a `ProviderMeta` for any provider type (built-in or plugin-
 * contributed). Built-ins go through the hardcoded `PROVIDER_META` table;
 * plugin-contributed providers (type prefix `plugin:`) get their meta
 * built from their entry in the native registries.
 */
function metaForType(type: string): ProviderMeta | undefined {
  const builtIn = PROVIDER_META[type as ProviderType]
  if (builtIn) return builtIn

  const capabilities: ProviderCapability[] = []
  const llm = getLLMProvider(type)
  if (llm) capabilities.push('llm')
  const emb = getEmbeddingProvider(type)
  if (emb) capabilities.push('embedding')
  const img = getImageProvider(type)
  if (img) capabilities.push('image')

  if (capabilities.length === 0) return undefined

  const first = llm ?? emb ?? img
  return {
    capabilities,
    displayName: first?.displayName ?? type,
    ...(first?.noApiKey ? { noApiKey: true } : {}),
    ...(first?.optionalApiKey ? { optionalApiKey: true } : {}),
    ...(first?.apiKeyUrl ? { apiKeyUrl: first.apiKeyUrl } : {}),
  }
}

/**
 * Listing of every plugin-contributed provider's metadata (keyed by type).
 * Built-ins are NOT included — `PROVIDER_META` is the source for those.
 * Used by the UI's "add provider" picker to surface plugin providers
 * alongside built-ins.
 */
export function getPluginProviderMeta(): Record<string, ProviderMeta> {
  const out: Record<string, ProviderMeta> = {}
  for (const p of [...listLLMProviders(), ...listEmbeddingProviders(), ...listImageProviders()]) {
    if (!p.type.startsWith('plugin:')) continue
    if (out[p.type]) {
      // Same type registered in multiple families (e.g. a single plugin
      // provider that implements both llm and embedding) — merge capabilities.
      const existing = out[p.type]!
      out[p.type] = {
        ...existing,
        capabilities: [...new Set([...existing.capabilities, ...metaForType(p.type)!.capabilities])],
      }
    } else {
      const meta = metaForType(p.type)
      if (meta) out[p.type] = meta
    }
  }
  return out
}

export function getCapabilitiesForType(type: string): ProviderCapability[] {
  return [...(metaForType(type)?.capabilities ?? [])]
}

// ─── Dispatcher helpers ──────────────────────────────────────────────────────

/** Provider family hint passed to the dispatcher to route the call to a
 *  specific native registry. Each `providers.capabilities[]` entry
 *  matches one of these values. */
export type ProviderFamily = 'llm' | 'embedding' | 'image'

/**
 * Look up a provider across the three native registries and run `fn`
 * against the matching one. Returns null when the type isn't registered
 * in the requested family (or in any family when `family` is omitted).
 *
 * The `family` hint is required for any call that dispatches a
 * family-specific operation (listModels, image generate, embed). It
 * routes to the right registry when a single provider type registers
 * in multiple registries (OpenAI llm+embedding+image, Replicate, …).
 *
 * `family` is omitted only by `testProviderConnection` — `authenticate`
 * is family-invariant (same credentials across families), so we don't
 * care which family's registry answers as long as one of them does.
 * The "try LLM → embedding → image" fallback below handles that case.
 */
async function tryDispatch<T>(
  type: string,
  _config: KinbotProviderConfig,
  fn: {
    llm: (p: NonNullable<ReturnType<typeof getLLMProvider>>) => Promise<T>
    embedding: (p: NonNullable<ReturnType<typeof getEmbeddingProvider>>) => Promise<T>
    image: (p: NonNullable<ReturnType<typeof getImageProvider>>) => Promise<T>
  },
  family?: ProviderFamily,
): Promise<T | null> {
  if (family === 'llm') {
    const llm = getLLMProvider(type)
    return llm ? fn.llm(llm) : null
  }
  if (family === 'embedding') {
    const emb = getEmbeddingProvider(type)
    return emb ? fn.embedding(emb) : null
  }
  if (family === 'image') {
    const img = getImageProvider(type)
    return img ? fn.image(img) : null
  }
  // No family hint — try in order.
  const llm = getLLMProvider(type)
  if (llm) return fn.llm(llm)
  const emb = getEmbeddingProvider(type)
  if (emb) return fn.embedding(emb)
  const img = getImageProvider(type)
  if (img) return fn.image(img)
  return null
}

// ─── Public API used by the rest of the codebase ─────────────────────────────

export async function testProviderConnection(
  type: string,
  config: KinbotProviderConfig,
  family?: ProviderFamily,
): Promise<{ valid: boolean; capabilities: string[]; error?: string }> {
  // In E2E test mode, skip real provider connection tests
  if (process.env.E2E_SKIP_PROVIDER_TEST === 'true') {
    const capabilities = getCapabilitiesForType(type)
    log.info({ type, capabilities }, 'E2E mode: skipping real provider test')
    return { valid: true, capabilities }
  }

  const result = await tryDispatch<{ valid: boolean; error?: string }>(
    type,
    config,
    {
      llm: (p) => p.authenticate(config).then((r) => ({ valid: r.valid, error: r.error })),
      embedding: (p) => p.authenticate(config).then((r) => ({ valid: r.valid, error: r.error })),
      image: (p) => p.authenticate(config).then((r) => ({ valid: r.valid, error: r.error })),
    },
    family,
  )

  if (!result) {
    log.error({ type }, 'Unknown provider type')
    return { valid: false, capabilities: [], error: `Unknown provider type: ${type}` }
  }

  log.info({ type, valid: result.valid, error: result.error }, 'Provider connection tested')
  return {
    valid: result.valid,
    capabilities: result.valid ? getCapabilitiesForType(type) : [],
    error: result.error,
  }
}

export async function listModelsForProvider(
  type: string,
  config: KinbotProviderConfig,
  family?: ProviderFamily,
): Promise<ProviderModel[]> {
  log.debug({ type, family }, 'Listing models for provider')

  const models = await tryDispatch<ProviderModel[]>(
    type,
    config,
    {
      llm: async (p) => {
        const list = await p.listModels(config)
        return list.map((m): ProviderModel => ({
          id: m.id,
          name: m.name,
          capability: 'llm',
          ...(m.supportsImageInput ? { supportsImageInput: true } : {}),
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          ...(m.maxOutput != null ? { maxOutput: m.maxOutput } : {}),
        }))
      },
      embedding: async (p) => {
        const list = await p.listModels(config)
        return list.map((m): ProviderModel => ({
          id: m.id,
          name: m.name,
          capability: 'embedding',
          ...(m.maxInputTokens ? { contextWindow: m.maxInputTokens } : {}),
        }))
      },
      image: async (p) => {
        const list = await p.listModels(config)
        return list.map((m): ProviderModel => ({
          id: m.id,
          name: m.name,
          capability: 'image',
          ...(m.maxImageInputs != null ? { maxImageInputs: m.maxImageInputs } : {}),
        }))
      },
    },
    family,
  )

  if (!models) {
    log.error({ type }, 'Cannot list models for unknown provider type')
    return []
  }

  if (models.length > 0) {
    // Auto-populate the model-info cache so callers of
    // getModelContextWindow() get accurate values straight from the
    // provider's API. Lazy import to avoid a circular dependency.
    const { populateFromProviderModels } = await import('@/server/services/model-info-cache')
    populateFromProviderModels(models)
  }
  return models
}

/**
 * Look up a single image model on the provider by id, going through
 * its native `listModels()` so the returned object carries every field
 * the provider chose to surface (maxImageInputs, supportedSizes,
 * pricing, …). Used by core paths that need to know what a model
 * supports BEFORE calling generate(), without hardcoding any
 * provider-specific knowledge.
 *
 * Returns null when the provider type isn't registered as an image
 * provider, or when no model with that id is found in the listing.
 */
const IMAGE_MODEL_CACHE_TTL_MS = 5 * 60_000
const imageModelCache = new Map<string, { value: ImageModel | null; expiresAt: number }>()

export async function lookupImageModel(
  type: string,
  modelId: string,
  config: KinbotProviderConfig,
): Promise<ImageModel | null> {
  const cacheKey = `${type}::${modelId}`
  const cached = imageModelCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const provider = getImageProvider(type)
  if (!provider) return null

  const list = await provider.listModels(config)
  const found = list.find((m) => m.id === modelId) ?? null
  imageModelCache.set(cacheKey, { value: found, expiresAt: Date.now() + IMAGE_MODEL_CACHE_TTL_MS })
  return found
}

/**
 * Look up an image model's per-param schema via the native registry,
 * with a short in-memory cache. The schema doesn't change between
 * calls (Replicate parses a frozen OpenAPI spec; OpenAI returns a
 * static map), so we memoize aggressively — the LLM may call
 * `describe_image_model` for several models in a row while exploring.
 *
 * Returns null when the provider type isn't registered as an image
 * provider, or when the registered provider declines to implement
 * `describeModel` (signals "no documented knobs" to the LLM).
 *
 * Provider-agnostic on purpose: zero hardcoded type names in this
 * function. Plugins drop in via the registry and benefit immediately.
 */
const DESCRIBE_CACHE_TTL_MS = 5 * 60_000
const describeCache = new Map<string, { value: ImageModelParamsSchema; expiresAt: number }>()

export async function describeImageModel(
  type: string,
  modelId: string,
  config: KinbotProviderConfig,
): Promise<ImageModelParamsSchema | null> {
  const cacheKey = `${type}::${modelId}`
  const cached = describeCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }

  const provider = getImageProvider(type)
  if (!provider) return null
  if (!provider.describeModel) return { params: {} }

  const model = (await lookupImageModel(type, modelId, config)) ?? { id: modelId, name: modelId }
  const schema = await provider.describeModel(model, config)

  describeCache.set(cacheKey, { value: schema, expiresAt: Date.now() + DESCRIBE_CACHE_TTL_MS })
  return schema
}

/** Test-only: flush the describe + lookup caches so tests don't bleed state. */
export function _resetImageModelCaches(): void {
  describeCache.clear()
  imageModelCache.clear()
}

/** For diagnostics — listing of providers in each native registry. */
export function getRegistryStats() {
  return {
    llm: listLLMProviders().map((p) => p.type),
    embedding: listEmbeddingProviders().map((p) => p.type),
    image: listImageProviders().map((p) => p.type),
  }
}
