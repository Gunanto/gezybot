import { describe, it, expect } from 'bun:test'
import { mintAppToken, resolveAppToken } from '@/server/services/mini-app-token'

describe('mini-app iframe tokens', () => {
  it('mints a token that resolves to its (appId, userId)', () => {
    const token = mintAppToken('app-1', 'user-1')
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(20)
    expect(resolveAppToken(token)).toEqual({ appId: 'app-1', userId: 'user-1' })
  })

  it('returns null for an unknown token', () => {
    expect(resolveAppToken('nope')).toBeNull()
  })

  it('mints unique tokens per call', () => {
    const a = mintAppToken('app-1', 'user-1')
    const b = mintAppToken('app-1', 'user-1')
    expect(a).not.toBe(b)
  })

  it('binds the token to the exact app + user (no cross-app reuse)', () => {
    const token = mintAppToken('app-A', 'user-1')
    const resolved = resolveAppToken(token)
    // The caller (authMiddleware) compares resolved.appId to the path's app id;
    // here we assert the binding is faithful so that comparison is meaningful.
    expect(resolved?.appId).toBe('app-A')
    expect(resolved?.appId).not.toBe('app-B')
  })
})
