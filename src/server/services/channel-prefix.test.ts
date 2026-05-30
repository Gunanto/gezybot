import { describe, it, expect } from 'bun:test'
import { applyKinNamePrefix } from '@/server/services/channel-prefix'

// Pure identity-prefix logic shared by deliverChannelResponse (transfer fallback)
// and sendToChannelAs (cross-Kin send). No DB / module mocks needed.
describe('applyKinNamePrefix', () => {
  it('prepends "[Name] " to plain content', () => {
    expect(applyKinNamePrefix('Hello world', 'VeilleurIA')).toBe('[VeilleurIA] Hello world')
  })

  it('is idempotent when the exact prefix is already present', () => {
    expect(applyKinNamePrefix('[VeilleurIA] Hello', 'VeilleurIA')).toBe('[VeilleurIA] Hello')
  })

  it('does not duplicate when content already starts with [Name] (no trailing space)', () => {
    expect(applyKinNamePrefix('[VeilleurIA]Hello', 'VeilleurIA')).toBe('[VeilleurIA]Hello')
  })

  it('still prefixes when a DIFFERENT kin name bracket is present', () => {
    expect(applyKinNamePrefix('[OtherKin] Hi', 'VeilleurIA')).toBe('[VeilleurIA] [OtherKin] Hi')
  })

  it('returns empty / whitespace-only content untouched', () => {
    expect(applyKinNamePrefix('', 'VeilleurIA')).toBe('')
    expect(applyKinNamePrefix('   ', 'VeilleurIA')).toBe('   ')
  })

  it('returns content untouched when kin name is empty', () => {
    expect(applyKinNamePrefix('Hello', '')).toBe('Hello')
  })
})
