/**
 * Register every built-in STT provider in the registry. Called once at
 * server startup, after the TTS provider registration.
 *
 * Empty for now — built-in STT providers (OpenAI Whisper) land in a
 * follow-up phase. Plugin-contributed STT providers (Voxtral via the
 * Mistral plugin, Deepgram, …) are registered by the plugin loader
 * regardless of whether any built-ins exist.
 */
export function registerBuiltinSTTProviders(): void {
  // No built-in STT providers yet.
}
