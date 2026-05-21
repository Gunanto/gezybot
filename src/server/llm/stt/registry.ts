import type { STTProvider } from '@/server/llm/stt/types'

const registry = new Map<string, STTProvider>()

export function registerSTTProvider(provider: STTProvider): void {
  if (registry.has(provider.type)) {
    throw new Error(`STT provider already registered: ${provider.type}`)
  }
  registry.set(provider.type, provider)
}

export function unregisterSTTProvider(type: string): void {
  registry.delete(type)
}

export function getSTTProvider(type: string): STTProvider | undefined {
  return registry.get(type)
}

export function listSTTProviders(): STTProvider[] {
  return [...registry.values()]
}
