import { Hono } from 'hono'
import { handleIncomingChannelMessage, getChannel } from '@/server/services/channels'
import { getSecretValue } from '@/server/services/vault'
import { createLogger } from '@/server/logger'
import type { IncomingAttachment } from '@/server/channels/adapter'
import { extractAttachments } from '@/server/channels/telegram-utils'
import { analyzeTelegramMessage } from '@/server/channels/telegram'
import { channelAdapters } from '@/server/channels/index'

const log = createLogger('routes:channel-telegram')

// ─── Routes ─────────────────────────────────────────────────────────────────

export const channelTelegramRoutes = new Hono()

// POST /api/channels/telegram/:channelId — receive Telegram updates (unauthenticated)
channelTelegramRoutes.post('/:channelId', async (c) => {
  const channelId = c.req.param('channelId')

  const channel = await getChannel(channelId)
  if (!channel || channel.platform !== 'telegram' || channel.status !== 'active') {
    return c.json({ ok: true })
  }

  let update: Record<string, unknown>
  try {
    update = await c.req.json()
  } catch {
    return c.json({ ok: true })
  }

  // Extract message from update (support message and edited_message)
  const message = (update.message ?? update.edited_message) as Record<string, unknown> | undefined
  if (!message) {
    return c.json({ ok: true })
  }

  const from = message.from as Record<string, unknown> | undefined
  const chat = message.chat as Record<string, unknown> | undefined
  if (!from || !chat) {
    return c.json({ ok: true })
  }

  // Skip the bot's own messages (loop prevention).
  const cfg = JSON.parse(channel.platformConfig) as { botTokenVaultKey: string }
  const token = await getSecretValue(cfg.botTokenVaultKey)

  // Resolve bot identity via the adapter cache so mention/reply detection is
  // identical to the polling path.
  const telegramAdapter = channelAdapters.get('telegram')
  const botIdentity = telegramAdapter && 'getBotIdentity' in telegramAdapter
    ? await (telegramAdapter as { getBotIdentity: (id: string, c: Record<string, unknown>) => Promise<{ botId: string; botUsername?: string } | null> }).getBotIdentity(channelId, cfg as Record<string, unknown>)
    : null
  if (botIdentity && String(from.id) === botIdentity.botId) {
    return c.json({ ok: true })
  }

  // Derive access-control context (chat type, mention, reply-to-bot).
  const { chatType, isMentioned, isReplyToBot } = analyzeTelegramMessage(message, botIdentity?.botId, botIdentity?.botUsername)

  // Extract text content (support text and caption for photos/documents)
  const text = (message.text ?? message.caption ?? '') as string

  // Extract file attachments
  let attachments: IncomingAttachment[] | undefined
  if (token) {
    const extracted = await extractAttachments(message, token)
    if (extracted.length > 0) attachments = extracted
  }

  // Skip if no text AND no attachments
  if (!text && !attachments) {
    return c.json({ ok: true })
  }

  try {
    await handleIncomingChannelMessage(channelId, {
      platformUserId: String(from.id),
      platformUsername: from.username as string | undefined,
      platformDisplayName: [from.first_name, from.last_name].filter(Boolean).join(' ') || undefined,
      platformMessageId: String(message.message_id),
      platformChatId: String(chat.id),
      content: text,
      attachments,
      chatType,
      isMentioned,
      isReplyToBot,
    })
  } catch (err) {
    log.error({ channelId, err }, 'Error handling Telegram update')
  }

  return c.json({ ok: true })
})
