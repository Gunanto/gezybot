import { describe, expect, it } from 'bun:test'
import { STATIC_CODEX_MODELS, mapCodexModel } from './openai-codex'
import { codexAccountIdFromTokens } from './_codex-auth'
import type { PkceTokenResponse } from './_oauth-pkce'

describe('STATIC_CODEX_MODELS (CLI-free fallback catalog)', () => {
  it('ships the GPT-5 family Codex slugs', () => {
    const slugs = STATIC_CODEX_MODELS.map((m) => m.slug)
    expect(slugs).toContain('gpt-5-codex')
    expect(slugs).toContain('gpt-5')
    // All entries must be API-listable so resolveCodexModels surfaces them.
    expect(STATIC_CODEX_MODELS.every((m) => m.supported_in_api && m.visibility === 'list')).toBe(true)
  })

  it('maps to reasoning-capable LLMModels', () => {
    const m = mapCodexModel(STATIC_CODEX_MODELS[0]!)
    expect(m.id).toBe('gpt-5-codex')
    expect(m.name.length).toBeGreaterThan(0)
    expect(m.contextWindow).toBeGreaterThan(0)
    expect(m.thinking?.efforts).toEqual(['low', 'medium', 'high'])
    expect(m.supportsImageInput).toBe(true)
  })
})

describe('codexAccountIdFromTokens', () => {
  function idToken(claims: Record<string, unknown>): string {
    const seg = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `header.${seg}.sig`
  }

  it('extracts chatgpt_account_id from the id_token claims', () => {
    const tokens: PkceTokenResponse = {
      accessToken: 'AT',
      raw: {},
      idToken: idToken({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_123' } }),
    }
    expect(codexAccountIdFromTokens(tokens)).toEqual({ accountId: 'acc_123' })
  })

  it('returns undefined when no id_token / account id is present', () => {
    expect(codexAccountIdFromTokens({ accessToken: 'AT', raw: {} })).toBeUndefined()
    expect(
      codexAccountIdFromTokens({ accessToken: 'AT', raw: {}, idToken: idToken({ sub: 'x' }) }),
    ).toBeUndefined()
  })
})
