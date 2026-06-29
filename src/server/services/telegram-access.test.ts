import { describe, it, expect } from 'bun:test'
import { analyzeTelegramMessage } from '@/server/channels/telegram'
import { matchTelegramAllowlist, telegramAccessDecision } from '@/server/services/channels'
import type { IncomingMessage } from '@/server/channels/adapter'
import type { TelegramAccessDecision } from '@/server/services/channels'

// ─── analyzeTelegramMessage ─────────────────────────────────────────────────

describe('analyzeTelegramMessage', () => {
  it('extracts chatType from message.chat.type', () => {
    expect(analyzeTelegramMessage({ chat: { type: 'private' } }).chatType).toBe('private')
    expect(analyzeTelegramMessage({ chat: { type: 'group' } }).chatType).toBe('group')
    expect(analyzeTelegramMessage({ chat: { type: 'supergroup' } }).chatType).toBe('supergroup')
    expect(analyzeTelegramMessage({ chat: { type: 'channel' } }).chatType).toBe('channel')
    expect(analyzeTelegramMessage({}).chatType).toBeUndefined()
  })

  it('detects @mention entity matching bot username (case-insensitive)', () => {
    const msg = {
      text: 'hello @MyBot how are you',
      entities: [{ type: 'mention', offset: 6, length: 6 }],
      chat: { type: 'group' },
    }
    expect(analyzeTelegramMessage(msg, '999', 'mybot').isMentioned).toBe(true)
    expect(analyzeTelegramMessage(msg, '999', 'OtherBot').isMentioned).toBe(false)
  })

  it('detects text_mention entity targeting bot id', () => {
    const msg = {
      text: 'hello there',
      entities: [{ type: 'text_mention', offset: 0, length: 5, user: { id: 999 } }],
      chat: { type: 'group' },
    }
    expect(analyzeTelegramMessage(msg, '999', 'mybot').isMentioned).toBe(true)
    expect(analyzeTelegramMessage(msg, '888', 'mybot').isMentioned).toBe(false)
  })

  it('detects reply_to_message from the bot', () => {
    const msg = {
      text: 'ok',
      chat: { type: 'group' },
      reply_to_message: { from: { id: 999 } },
    }
    expect(analyzeTelegramMessage(msg, '999').isReplyToBot).toBe(true)
    expect(analyzeTelegramMessage(msg, '888').isReplyToBot).toBe(false)
    expect(analyzeTelegramMessage({ text: 'ok', chat: { type: 'group' } }, '999').isReplyToBot).toBe(false)
  })

  it('returns false for both flags when no entities and no reply', () => {
    const r = analyzeTelegramMessage({ text: 'hi', chat: { type: 'private' } }, '999', 'mybot')
    expect(r.isMentioned).toBe(false)
    expect(r.isReplyToBot).toBe(false)
  })
})

// ─── matchTelegramAllowlist ─────────────────────────────────────────────────

describe('matchTelegramAllowlist', () => {
  it('owner (by user id) always passes', () => {
    expect(matchTelegramAllowlist('6468143001', undefined, '6468143001', [])).toBe(true)
  })

  it('owner by username is NOT honored (anti-spoof)', () => {
    expect(matchTelegramAllowlist('1', '6468143001', '6468143001', [])).toBe(false)
  })

  it('numeric allowlist entry matches platformUserId', () => {
    expect(matchTelegramAllowlist('123456', undefined, null, ['123456'])).toBe(true)
    expect(matchTelegramAllowlist('999', undefined, null, ['123456'])).toBe(false)
  })

  it('string allowlist entry matches username (case-insensitive)', () => {
    expect(matchTelegramAllowlist('1', 'PGUN75', null, ['pgun75'])).toBe(true)
    expect(matchTelegramAllowlist('1', 'other', null, ['pgun75'])).toBe(false)
  })

  it('mixed allowlist: numeric→id, string→username', () => {
    const list = ['pg957', '6468143001', 'ferilee']
    expect(matchTelegramAllowlist('6468143001', undefined, null, list)).toBe(true)
    expect(matchTelegramAllowlist('1', 'pg957', null, list)).toBe(true)
    expect(matchTelegramAllowlist('1', 'ferilee', null, list)).toBe(true)
    expect(matchTelegramAllowlist('1', 'other', null, list)).toBe(false)
    expect(matchTelegramAllowlist('1', undefined, null, list)).toBe(false)
  })

  it('empty allowlist + no owner → nobody authorized', () => {
    expect(matchTelegramAllowlist('1', 'x', null, [])).toBe(false)
  })

  it('empty allowlist + owner set → only owner authorized', () => {
    expect(matchTelegramAllowlist('6468143001', 'pg957', '6468143001', [])).toBe(true)
    expect(matchTelegramAllowlist('1', 'pg957', '6468143001', [])).toBe(false)
  })

  it('owner + allowlist → both pass', () => {
    const list = ['pg957']
    expect(matchTelegramAllowlist('6468143001', undefined, '6468143001', list)).toBe(true)
    expect(matchTelegramAllowlist('1', 'pg957', '6468143001', list)).toBe(true)
    expect(matchTelegramAllowlist('1', 'other', '6468143001', list)).toBe(false)
  })
})

// ─── telegramAccessDecision ─────────────────────────────────────────────────

function mkIncoming(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platformUserId: '1',
    platformMessageId: '1',
    platformChatId: '1',
    content: 'hi',
    ...overrides,
  }
}

const OWNER = '6468143001'
const LIST = ['pg957', '6468143001']

function decide(incoming: IncomingMessage, opts?: Partial<{ ownerId: string | null; allowlist: readonly string[]; allowAllInGroups: boolean }>): TelegramAccessDecision {
  return telegramAccessDecision('telegram', incoming, {
    ownerId: opts?.ownerId ?? OWNER,
    allowlist: opts?.allowlist ?? LIST,
    allowAllInGroups: opts?.allowAllInGroups ?? false,
  })
}

describe('telegramAccessDecision', () => {
  it('non-telegram platform → allow (no-op)', () => {
    expect(telegramAccessDecision('discord', mkIncoming(), { ownerId: OWNER, allowlist: LIST, allowAllInGroups: false })).toEqual({ allow: true })
  })

  it('no config (no owner + empty allowlist) → allow (legacy behavior)', () => {
    expect(telegramAccessDecision('telegram', mkIncoming(), { ownerId: null, allowlist: [], allowAllInGroups: false })).toEqual({ allow: true })
  })

  it('DM from owner → allow', () => {
    expect(decide(mkIncoming({ platformUserId: OWNER, chatType: 'private' }))).toEqual({ allow: true })
  })

  it('DM from allowlist (by username) → allow', () => {
    expect(decide(mkIncoming({ platformUserId: '1', platformUsername: 'pg957', chatType: 'private' }))).toEqual({ allow: true })
  })

  it('DM from allowlist (by user id) → allow', () => {
    expect(decide(mkIncoming({ platformUserId: '6468143001', chatType: 'private' }))).toEqual({ allow: true })
  })

  it('DM from unregistered → deny dm-unregistered', () => {
    expect(decide(mkIncoming({ platformUserId: '999', platformUsername: 'stranger', chatType: 'private' }))).toEqual({ allow: false, reason: 'dm-unregistered' })
  })

  it('Telegram Channel (broadcast) → deny channel-broadcast', () => {
    expect(decide(mkIncoming({ platformUserId: OWNER, chatType: 'channel' }))).toEqual({ allow: false, reason: 'channel-broadcast' })
  })

  it('group: owner + mention → allow', () => {
    expect(decide(mkIncoming({ platformUserId: OWNER, chatType: 'group', isMentioned: true }))).toEqual({ allow: true })
  })

  it('group: owner + reply-to-bot → allow', () => {
    expect(decide(mkIncoming({ platformUserId: OWNER, chatType: 'supergroup', isReplyToBot: true }))).toEqual({ allow: true })
  })

  it('group: owner, no mention, ALLOW_ALL=false → deny group-no-mention', () => {
    expect(decide(mkIncoming({ platformUserId: OWNER, chatType: 'group' }))).toEqual({ allow: false, reason: 'group-no-mention' })
  })

  it('group: owner, no mention, ALLOW_ALL=true → allow', () => {
    expect(decide(mkIncoming({ platformUserId: OWNER, chatType: 'group' }), { allowAllInGroups: true })).toEqual({ allow: true })
  })

  it('group: allowlist user + mention → allow', () => {
    expect(decide(mkIncoming({ platformUserId: '1', platformUsername: 'pg957', chatType: 'group', isMentioned: true }))).toEqual({ allow: true })
  })

  it('group: allowlist user, no mention, ALLOW_ALL=false → deny group-no-mention', () => {
    expect(decide(mkIncoming({ platformUserId: '1', platformUsername: 'pg957', chatType: 'group' }))).toEqual({ allow: false, reason: 'group-no-mention' })
  })

  it('group: unregistered user + mention → deny group-unregistered (mention does not bypass allowlist)', () => {
    expect(decide(mkIncoming({ platformUserId: '999', platformUsername: 'stranger', chatType: 'group', isMentioned: true }))).toEqual({ allow: false, reason: 'group-unregistered' })
  })

  it('group: unregistered user, ALLOW_ALL=true → still deny group-unregistered (allowlist still enforced)', () => {
    expect(decide(mkIncoming({ platformUserId: '999', chatType: 'group' }), { allowAllInGroups: true })).toEqual({ allow: false, reason: 'group-unregistered' })
  })

  it('unknown chatType treated as group → deny if no mention', () => {
    expect(decide(mkIncoming({ platformUserId: OWNER, chatType: undefined }))).toEqual({ allow: false, reason: 'group-no-mention' })
  })
})
