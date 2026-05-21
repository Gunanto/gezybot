/**
 * Register every built-in TTS provider in the registry. Called once at
 * server startup, after the search provider registration.
 *
 * Empty for now — built-in TTS providers (OpenAI, ElevenLabs) land in
 * a follow-up phase. Plugin-contributed TTS providers are registered
 * by the plugin loader regardless of whether any built-ins exist.
 */
export function registerBuiltinTTSProviders(): void {
  // No built-in TTS providers yet.
}
