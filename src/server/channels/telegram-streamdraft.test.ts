/**
 * Tests for TelegramAdapter.streamDraft — the Fase 2 streaming-draft lifecycle
 * (Bot API 10.1 `sendRichMessageDraft` + commit via `sendRichMessage`).
 *
 * Mocks vault + logger + global fetch so we can import the real
 * TelegramAdapter and exercise its `streamDraft` method end-to-end without
 * network calls. Verifies:
 *  - opening a draft returns a ChannelDraftStream handle
 *  - update() forwards throttled sendRichMessageDraft calls
 *  - commit() sends a final sendRichMessage (or sendMessage fallback) and
 *    returns a platformMessageId
 *  - abort() sends an empty draft to clear the bubble
 *  - double-finalize (commit after abort, etc.) is a safe no-op
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'

// ─── Mock dependencies before importing the module ─────────────────────────

mock.module('@/server/services/vault', () => ({
  getSecretValue: async (key: string) => {
    if (key === 'vault:tg-token') return 'test-token-123'
    return null
  },
  getSecretByKey: async () => null,
  createSecret: async () => ({ id: 'sec-1', key: 'TEST', createdAt: new Date() }),
  updateSecretValueByKey: async () => null,
  deleteSecret: async () => true,
  listKeysByPrefix: async () => [],
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}))

// ─── Test fixture ───────────────────────────────────────────────────────────

import { TelegramAdapter } from '@/server/channels/telegram'

const originalFetch = globalThis.fetch
let fetchMock: ReturnType<typeof mock>
let apiCalls: Array<{ method: string; body: Record<string, unknown> }>

beforeEach(() => {
  apiCalls = []
  fetchMock = mock((_url: string, init?: RequestInit) => {
    const url = _url as string
    const method = url.replace(/^.*\/bot[^/]+\//, '')
    let body: Record<string, unknown> = {}
    if (init?.body) {
      try { body = JSON.parse(init.body as string) as Record<string, unknown> } catch { /* not json */ }
    }
    apiCalls.push({ method, body })
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, result: { message_id: 777, first_name: 'TestBot', username: 'test_bot' } }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

const CFG = { botTokenVaultKey: 'vault:tg-token' }

describe('TelegramAdapter.streamDraft', () => {
  it('opens a draft and returns a ChannelDraftStream handle', async () => {
    const adapter = new TelegramAdapter()
    const stream = await adapter.streamDraft('ch-1', CFG, {
      chatId: '123',
      content: '',
      replyToMessageId: '42',
    })
    expect(typeof stream.update).toBe('function')
    expect(typeof stream.commit).toBe('function')
    expect(typeof stream.abort).toBe('function')
  })

  it('update() forwards sendRichMessageDraft calls (throttled)', async () => {
    const adapter = new TelegramAdapter()
    const stream = await adapter.streamDraft('ch-1', CFG, { chatId: '123', content: '' })
    // First update should flush (no prior flush → elapsed >= throttle).
    await stream.update('Hello', 'Hello')
    // Wait a tick for the (possibly scheduled) flush to land.
    await new Promise((r) => setTimeout(r, 50))
    const draftCalls = apiCalls.filter((c) => c.method === 'sendRichMessageDraft')
    expect(draftCalls.length).toBeGreaterThanOrEqual(1)
    expect(draftCalls[0]!.body.chat_id).toBe('123')
    expect(draftCalls[0]!.body.draft_id).toBeTruthy()
  })

  it('commit() sends sendRichMessage for rich content and returns platformMessageId', async () => {
    const adapter = new TelegramAdapter()
    const stream = await adapter.streamDraft('ch-1', CFG, { chatId: '123', content: '' })
    await stream.update('# Heading\n\nsome text', '# Heading\n\nsome text')
    await new Promise((r) => setTimeout(r, 50))
    const result = await stream.commit()
    expect(result.platformMessageId).toBe('777')
    const commitCalls = apiCalls.filter((c) => c.method === 'sendRichMessage')
    expect(commitCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('commit() falls back to sendMessage for plain text', async () => {
    const adapter = new TelegramAdapter()
    const stream = await adapter.streamDraft('ch-1', CFG, { chatId: '123', content: '' })
    await stream.update('just a plain paragraph', 'just a plain paragraph')
    await new Promise((r) => setTimeout(r, 50))
    const result = await stream.commit()
    expect(result.platformMessageId).toBe('777')
    const sendCalls = apiCalls.filter((c) => c.method === 'sendMessage')
    expect(sendCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('abort() sends an empty draft to clear the bubble', async () => {
    const adapter = new TelegramAdapter()
    const stream = await adapter.streamDraft('ch-1', CFG, { chatId: '123', content: '' })
    await stream.update('partial text', 'partial text')
    await new Promise((r) => setTimeout(r, 50))
    await stream.abort()
    const abortCalls = apiCalls.filter((c) => c.method === 'sendRichMessageDraft' && (c.body.rich_message as { html?: string } | undefined)?.html === '')
    expect(abortCalls.length).toBe(1)
  })

  it('double-finalize: commit after abort is a safe no-op (returns empty result)', async () => {
    const adapter = new TelegramAdapter()
    const stream = await adapter.streamDraft('ch-1', CFG, { chatId: '123', content: '' })
    await stream.abort()
    const result = await stream.commit()
    // Should not throw; platformMessageId may be empty since already finalized.
    expect(typeof result.platformMessageId).toBe('string')
  })

  it('update after commit is a no-op', async () => {
    const adapter = new TelegramAdapter()
    const stream = await adapter.streamDraft('ch-1', CFG, { chatId: '123', content: '' })
    await stream.update('before commit', 'before commit')
    await new Promise((r) => setTimeout(r, 50))
    await stream.commit()
    const callsBefore = apiCalls.length
    await stream.update('after commit', 'after commit')
    await new Promise((r) => setTimeout(r, 50))
    expect(apiCalls.length).toBe(callsBefore)
  })
})
