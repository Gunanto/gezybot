import type { TTSProvider } from '@/server/llm/tts/types'

const registry = new Map<string, TTSProvider>()

export function registerTTSProvider(provider: TTSProvider): void {
  if (registry.has(provider.type)) {
    throw new Error(`TTS provider already registered: ${provider.type}`)
  }
  registry.set(provider.type, provider)
}

export function unregisterTTSProvider(type: string): void {
  registry.delete(type)
}

export function getTTSProvider(type: string): TTSProvider | undefined {
  return registry.get(type)
}

export function listTTSProviders(): TTSProvider[] {
  return [...registry.values()]
}
