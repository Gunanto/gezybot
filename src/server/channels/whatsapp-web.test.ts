import { describe, expect, it } from 'bun:test'
import { WhatsAppWebAdapter, extractText } from './whatsapp-web'

describe('WhatsAppWebAdapter contract', () => {
  const adapter = new WhatsAppWebAdapter()

  it('declares the whatsapp-web platform with QR pairing', () => {
    expect(adapter.platform).toBe('whatsapp-web')
    expect(adapter.pairing).toBe('qr')
    expect(adapter.identitySwitchMode).toBe('prefix')
    // No user-entered config: the session is the credential.
    expect(adapter.configSchema?.fields).toEqual([])
    // Implements the pairing entrypoint the host prefers for QR adapters.
    expect(typeof adapter.startWithPairing).toBe('function')
  })

  it('validateConfig is session-driven (always valid as a static config)', async () => {
    await expect(adapter.validateConfig({})).resolves.toEqual({ valid: true })
  })

  it('reports no live session for an unknown channel', () => {
    expect(adapter.isConnected('nope')).toBe(false)
  })

  it('throws a helpful error when sending without a connected session', async () => {
    await expect(
      adapter.sendMessage('unpaired', {}, { chatId: '123@s.whatsapp.net', content: 'hi' }),
    ).rejects.toThrow(/not connected/i)
  })
})

describe('extractText', () => {
  it('reads plain conversation text', () => {
    expect(extractText({ conversation: 'hello' })).toBe('hello')
  })
  it('reads extended text', () => {
    expect(extractText({ extendedTextMessage: { text: 'hey' } })).toBe('hey')
  })
  it('reads image/video/document captions', () => {
    expect(extractText({ imageMessage: { caption: 'pic' } })).toBe('pic')
    expect(extractText({ videoMessage: { caption: 'clip' } })).toBe('clip')
    expect(extractText({ documentMessage: { caption: 'doc' } })).toBe('doc')
  })
  it('returns empty string for empty / unknown messages', () => {
    expect(extractText(null)).toBe('')
    expect(extractText({})).toBe('')
    expect(extractText({ stickerMessage: {} })).toBe('')
  })
})
