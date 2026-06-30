import { describe, it, expect } from 'bun:test'
import { matchWhatsappAllowlist, whatsappAccessDecision } from '@/server/services/channels'
import type { IncomingMessage } from '@/server/channels/adapter'

// ─── matchWhatsappAllowlist ──────────────────────────────────────────────────

describe('matchWhatsappAllowlist', () => {
  it('matches owner by bare digits regardless of JID formatting', () => {
    expect(
      matchWhatsappAllowlist('6281234567890@s.whatsapp.net', '6281234567890', []),
    ).toBe(true)
    expect(matchWhatsappAllowlist('6281234567890', '+62 812-3456-7890', [])).toBe(true)
    expect(matchWhatsappAllowlist('6281234567890@s.whatsapp.net', '6281111111111', [])).toBe(false)
  })

  it('matches an allowlist entry by bare digits', () => {
    expect(
      matchWhatsappAllowlist('6281234567890@s.whatsapp.net', null, ['6281234567890', '6281111111111']),
    ).toBe(true)
    expect(
      matchWhatsappAllowlist('6281111111111@s.whatsapp.net', null, ['6281234567890', '6281111111111']),
    ).toBe(true)
    expect(
      matchWhatsappAllowlist('6281999999999@s.whatsapp.net', null, ['6281234567890']),
    ).toBe(false)
  })

  it('with empty allowlist and no owner, denies everyone', () => {
    expect(matchWhatsappAllowlist('6281234567890@s.whatsapp.net', null, [])).toBe(false)
  })

  it('with empty allowlist but an owner, allows only the owner', () => {
    expect(matchWhatsappAllowlist('6281234567890@s.whatsapp.net', '6281234567890', [])).toBe(true)
    expect(matchWhatsappAllowlist('6281111111111@s.whatsapp.net', '6281234567890', [])).toBe(false)
  })
})

// ─── whatsappAccessDecision ──────────────────────────────────────────────────

function mk(overrides: Partial<IncomingMessage>): IncomingMessage {
  return {
    platformUserId: '6281234567890@s.whatsapp.net',
    platformChatId: '6281234567890@s.whatsapp.net',
    platformMessageId: 'm1',
    content: 'hi',
    ...overrides,
  } as IncomingMessage
}

describe('whatsappAccessDecision', () => {
  const allowlist = ['6281234567890']
  const opts = { ownerId: null as string | null, allowlist, allowAllInGroups: false }

  it('is a no-op for non-whatsapp platforms', () => {
    expect(whatsappAccessDecision('telegram', mk({}), opts)).toEqual({ allow: true })
  })

  it('is a no-op when nothing is configured (owner + allowlist empty)', () => {
    expect(
      whatsappAccessDecision('whatsapp-web', mk({}), { ownerId: null, allowlist: [], allowAllInGroups: false }),
    ).toEqual({ allow: true })
  })

  it('allows authorized DM', () => {
    expect(
      whatsappAccessDecision('whatsapp-web', mk({ chatType: 'private' }), opts),
    ).toEqual({ allow: true })
  })

  it('denies unregistered DM with dm-unregistered', () => {
    expect(
      whatsappAccessDecision(
        'whatsapp-web',
        mk({ platformUserId: '6281111111111@s.whatsapp.net', chatType: 'private' }),
        opts,
      ),
    ).toEqual({ allow: false, reason: 'dm-unregistered' })
  })

  it('denies a group message from an unregistered sender (group-unregistered)', () => {
    expect(
      whatsappAccessDecision(
        'whatsapp-web',
        mk({ platformUserId: '6281111111111@s.whatsapp.net', chatType: 'group', isReplyToBot: true }),
        opts,
      ),
    ).toEqual({ allow: false, reason: 'group-unregistered' })
  })

  it('denies an authorized group message WITHOUT a reply (group-no-reply)', () => {
    expect(
      whatsappAccessDecision('whatsapp-web', mk({ chatType: 'group', isReplyToBot: false }), opts),
    ).toEqual({ allow: false, reason: 'group-no-reply' })
  })

  it('allows an authorized group message WITH a reply-to-bot', () => {
    expect(
      whatsappAccessDecision('whatsapp-web', mk({ chatType: 'group', isReplyToBot: true }), opts),
    ).toEqual({ allow: true })
  })

  it('allows an authorized group message WITH a mention of the bot (no reply)', () => {
    expect(
      whatsappAccessDecision('whatsapp-web', mk({ chatType: 'group', isReplyToBot: false, isMentioned: true }), opts),
    ).toEqual({ allow: true })
  })

  it('denies an authorized group message with neither mention nor reply', () => {
    expect(
      whatsappAccessDecision('whatsapp-web', mk({ chatType: 'group', isReplyToBot: false, isMentioned: false }), opts),
    ).toEqual({ allow: false, reason: 'group-no-reply' })
  })

  it('allows all group messages when allowAllInGroups is true', () => {
    expect(
      whatsappAccessDecision(
        'whatsapp-web',
        mk({ chatType: 'group', isReplyToBot: false }),
        { ...opts, allowAllInGroups: true },
      ),
    ).toEqual({ allow: true })
  })

  it('treats unknown chatType as group (conservative)', () => {
    expect(
      whatsappAccessDecision('whatsapp-web', mk({ chatType: undefined, isReplyToBot: false }), opts),
    ).toEqual({ allow: false, reason: 'group-no-reply' })
  })
})
