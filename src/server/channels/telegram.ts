import type { ChannelAdapter, ChannelConfigSchema, ChannelDraftStream, IncomingMessageHandler, OutboundMessageParams, OutboundMessageResult, OutboundAttachment } from '@/server/channels/adapter'
import { readAttachmentBlob, attachmentFileName, isImageAttachment } from '@/server/channels/adapter'
import type { ChannelAdapterMeta } from '@/server/channels/adapter'
import { getSecretValue } from '@/server/services/vault'
import { extractAttachments } from '@/server/channels/telegram-utils'
import { markdownToTelegramHtml, markdownHasRichBlocks } from '@/server/channels/telegram-rich'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'

const log = createLogger('channel:telegram')

const TELEGRAM_API = 'https://api.telegram.org'
const MAX_MESSAGE_LENGTH = 4096
const POLLING_TIMEOUT_S = 30
const MAX_BACKOFF_MS = 30_000

export interface TelegramChannelConfig {
  botTokenVaultKey: string
  allowedChatIds?: string[]
}

/** Split a long message into chunks respecting Telegram's 4096-char limit */
function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining)
      break
    }

    // Try to split at a paragraph, then line, then sentence boundary
    let splitAt = remaining.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('. ', MAX_MESSAGE_LENGTH)
    if (splitAt <= 0) splitAt = MAX_MESSAGE_LENGTH

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}

async function resolveToken(cfg: Record<string, unknown>): Promise<string> {
  const vaultKey = (cfg as unknown as TelegramChannelConfig).botTokenVaultKey
  const token = await getSecretValue(vaultKey)
  if (!token) throw new Error(`Vault key "${vaultKey}" not found`)
  return token
}

async function telegramApi(token: string, method: string, body?: Record<string, unknown>, signal?: AbortSignal) {
  const resp = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })
  const data = await resp.json() as { ok: boolean; result?: unknown; description?: string }
  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.description ?? 'Unknown error'}`)
  }
  return data.result
}

/** Returns true when no public HTTPS URL is configured (local/dev setup) */
export function shouldUsePolling(): boolean {
  return !process.env.PUBLIC_URL || !config.publicUrl?.startsWith('https://')
}

interface TelegramPollingState {
  token: string
  channelId: string
  onMessage: IncomingMessageHandler
  offset: number
  stopped: boolean
  abortController: AbortController
  allowedChatIds: Set<string> | null
  /** Cached bot identity from getMe — used for @mention + self-reply detection. */
  botId?: string
  botUsername?: string
}

/**
 * Analyze a raw Telegram `message`/`edited_message` object and derive the
 * access-control context needed by the service-layer gate:
 *  - `chatType`: Telegram chat type (`private` | `group` | `supergroup` | `channel`).
 *  - `isMentioned`: true when the message contains an `@<botUsername>` mention
 *    entity OR a `text_mention` entity targeting `botId`.
 *  - `isReplyToBot`: true when the message is a reply to one of the bot's own
 *    messages (`reply_to_message.from.id === botId`).
 *
 * Exported so the webhook route (`routes/channel-telegram.ts`) and the polling
 * adapter (`processUpdate`) share the exact same derivation logic.
 */
export function analyzeTelegramMessage(
  message: Record<string, unknown>,
  botId?: string,
  botUsername?: string,
): { chatType?: 'private' | 'group' | 'supergroup' | 'channel'; isMentioned: boolean; isReplyToBot: boolean } {
  const chat = message.chat as Record<string, unknown> | undefined
  const chatType = chat?.type as 'private' | 'group' | 'supergroup' | 'channel' | undefined

  // Detect @mention via message.entities (Telegram pre-parses mentions).
  let isMentioned = false
  const entities = message.entities as Array<{ type: string; offset: number; length: number; user?: { id: number } }> | undefined
  if (Array.isArray(entities)) {
    const text = (message.text ?? '') as string
    const lowerBot = botUsername?.toLowerCase()
    for (const ent of entities) {
      if (ent.type === 'mention' && lowerBot) {
        const handle = text.slice(ent.offset, ent.offset + ent.length).toLowerCase()
        // handle includes the leading '@'
        if (handle === `@${lowerBot}`) {
          isMentioned = true
          break
        }
      } else if (ent.type === 'text_mention' && botId) {
        if (String(ent.user?.id) === botId) {
          isMentioned = true
          break
        }
      }
    }
  }

  // Detect reply-to-bot: reply_to_message.from.id === botId.
  let isReplyToBot = false
  if (botId) {
    const replyTo = message.reply_to_message as Record<string, unknown> | undefined
    const replyFrom = replyTo?.from as Record<string, unknown> | undefined
    if (replyFrom && String(replyFrom.id) === botId) {
      isReplyToBot = true
    }
  }

  return { chatType, isMentioned, isReplyToBot }
}

// Dynamic config schema (issue #381).
// Schema field names are USER-FACING form input names. At runtime this adapter
// reads `<name>VaultKey` from `platformConfig` (e.g. `botTokenVaultKey`),
// populated by `createChannel()` in services/channels.ts which performs the
// vault dance based on this schema. The drift is an internal storage detail.
const telegramConfigSchema: ChannelConfigSchema = {
  fields: [
    {
      name: 'botToken',
      label: 'Bot token',
      type: 'password',
      required: true,
      placeholder: '123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
      description: 'Telegram bot token obtained from @BotFather.',
    },
  ],
}

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = 'telegram'
  readonly meta: ChannelAdapterMeta = { displayName: 'Telegram', brandColor: '#26A5E4' }
  readonly configSchema = telegramConfigSchema
  // Bot API exposes setMyName (display name) but NOT setMyDescription for the
  // bot picture: avatars can only be set via BotFather. We declare 'native'
  // because the name does flip globally on transfer; avatar swap is skipped.
  // NB: this changes the bot identity globally across all chats the bot is in,
  // which is a Telegram limitation (no per-chat bot identity). Accepted as a
  // known trade-off; documented in docs/channel-transfers.md.
  readonly identitySwitchMode = 'native' as const
  private pollers = new Map<string, TelegramPollingState>()
  /** Cached bot identity per channel id (`{ botId, botUsername }`), populated
   *  lazily by `getBotIdentity()` from `getMe`. Used by both the polling path
   *  (`processUpdate`) and the webhook route (`routes/channel-telegram.ts`) so
   *  mention/reply detection works identically in both transports. */
  private botIdentityCache = new Map<string, { botId: string; botUsername?: string }>()

  /** Resolve and cache the bot's own Telegram identity for `channelId`.
   *  Returns `null` if the token is invalid / `getMe` fails (the caller will
   *  simply skip mention detection in that case). The cache survives for the
   *  process lifetime; identity rarely changes. */
  async getBotIdentity(channelId: string, cfg: Record<string, unknown>): Promise<{ botId: string; botUsername?: string } | null> {
    const cached = this.botIdentityCache.get(channelId)
    if (cached) return cached
    try {
      const token = await resolveToken(cfg)
      const result = await telegramApi(token, 'getMe') as { id: number; username?: string }
      const identity = { botId: String(result.id), botUsername: result.username }
      this.botIdentityCache.set(channelId, identity)
      return identity
    } catch (err) {
      log.warn({ channelId, err }, 'Failed to fetch Telegram bot identity for access-control')
      return null
    }
  }

  async start(channelId: string, cfg: Record<string, unknown>, onMessage?: IncomingMessageHandler): Promise<void> {
    const token = await resolveToken(cfg)
    const telegramCfg = cfg as unknown as TelegramChannelConfig

    // Resolve bot identity once at start so mention/reply detection works from
    // the very first inbound message (both polling and webhook paths).
    const identity = await this.getBotIdentity(channelId, cfg)

    if (shouldUsePolling()) {
      // Delete any existing webhook (Telegram requirement before getUpdates)
      await telegramApi(token, 'deleteWebhook')

      const state: TelegramPollingState = {
        token,
        channelId,
        onMessage: onMessage!,
        offset: 0,
        stopped: false,
        abortController: new AbortController(),
        allowedChatIds: telegramCfg.allowedChatIds?.length
          ? new Set(telegramCfg.allowedChatIds)
          : null,
        botId: identity?.botId,
        botUsername: identity?.botUsername,
      }

      this.pollers.set(channelId, state)
      // Fire-and-forget — the loop runs in the background
      this.pollLoop(state)
      log.info({ channelId, mode: 'polling' }, 'Telegram polling started')
    } else {
      const webhookUrl = `${config.publicUrl}${config.channels.telegramWebhookPath}/${channelId}`
      await telegramApi(token, 'setWebhook', { url: webhookUrl })
      log.info({ channelId, mode: 'webhook', webhookUrl }, 'Telegram webhook set')
    }
  }

  async stop(channelId: string, cfg?: Record<string, unknown>): Promise<void> {
    // Check polling mode first
    const state = this.pollers.get(channelId)
    if (state) {
      state.stopped = true
      state.abortController.abort()
      this.pollers.delete(channelId)
      this.botIdentityCache.delete(channelId)
      log.info({ channelId }, 'Telegram polling stopped')
      return
    }

    // Webhook mode cleanup
    try {
      if (cfg) {
        const token = await resolveToken(cfg)
        await telegramApi(token, 'deleteWebhook')
      }
    } catch (err) {
      log.warn({ channelId, err }, 'Failed to delete Telegram webhook (token may be invalid)')
    }
    this.botIdentityCache.delete(channelId)
    log.info({ channelId }, 'Telegram webhook removed')
  }

  private async pollLoop(state: TelegramPollingState): Promise<void> {
    let backoff = 0

    while (!state.stopped) {
      try {
        const updates = await telegramApi(
          state.token,
          'getUpdates',
          {
            offset: state.offset,
            timeout: POLLING_TIMEOUT_S,
            allowed_updates: ['message', 'edited_message'],
          },
          state.abortController.signal,
        ) as Array<{ update_id: number; message?: Record<string, unknown>; edited_message?: Record<string, unknown> }>

        backoff = 0 // reset on success

        for (const update of updates) {
          state.offset = update.update_id + 1
          const message = update.message ?? update.edited_message
          if (!message) continue

          try {
            await this.processUpdate(state, message)
          } catch (err) {
            log.error({ channelId: state.channelId, err }, 'Error processing Telegram update')
          }
        }
      } catch (err) {
        if (state.stopped) break
        log.error({ channelId: state.channelId, err }, 'Telegram polling error')
        backoff = Math.min((backoff || 1000) * 2, MAX_BACKOFF_MS)
        await new Promise((r) => setTimeout(r, backoff))
      }
    }
  }

  private async processUpdate(state: TelegramPollingState, message: Record<string, unknown>): Promise<void> {
    const from = message.from as Record<string, unknown> | undefined
    const chat = message.chat as Record<string, unknown> | undefined
    if (!from || !chat) return

    // Skip the bot's own messages (loop prevention).
    if (state.botId && String(from.id) === state.botId) return

    const chatId = String(chat.id)

    // Filter by allowed chat IDs
    if (state.allowedChatIds && !state.allowedChatIds.has(chatId)) return

    const text = (message.text ?? message.caption ?? '') as string

    // Extract file attachments using shared logic
    const attachments = await extractAttachments(message, state.token)

    // Skip if no text AND no attachments
    if (!text && attachments.length === 0) return

    // Derive access-control context (chat type, mention, reply-to-bot).
    const { chatType, isMentioned, isReplyToBot } = analyzeTelegramMessage(message, state.botId, state.botUsername)

    // Extract Telegram forum topic / message thread ID so replies go to
    // the correct topic, not the group's main thread.
    const threadId = message.message_thread_id != null ? String(message.message_thread_id) : undefined

    await state.onMessage({
      platformUserId: String(from.id),
      platformUsername: from.username as string | undefined,
      platformDisplayName: [from.first_name, from.last_name].filter(Boolean).join(' ') || undefined,
      platformMessageId: String(message.message_id),
      platformChatId: chatId,
      content: text,
      attachments: attachments.length > 0 ? attachments : undefined,
      chatType,
      isMentioned,
      isReplyToBot,
      metadata: threadId ? { threadId } : undefined,
    })
  }

  async sendMessage(
    _channelId: string,
    cfg: Record<string, unknown>,
    params: OutboundMessageParams,
  ): Promise<{ platformMessageId: string }> {
    const token = await resolveToken(cfg)

    let lastMessageId = ''

    // Send file attachments first (or with caption for the first one)
    if (params.attachments?.length) {
      for (let i = 0; i < params.attachments.length; i++) {
        const att = params.attachments[i]
        if (!att) continue
        const result = await sendTelegramFile(token, params.chatId, att, {
          // First attachment gets the text as caption (if short enough for Telegram's 1024 limit)
          caption: i === 0 && params.content && params.content.length <= 1024 ? params.content : undefined,
          replyToMessageId: i === 0 ? params.replyToMessageId : undefined,
          threadId: params.threadId,
        })
        lastMessageId = result
      }
      // If text was used as caption, we're done; otherwise send text separately
      if (params.content && (params.content.length > 1024 || !params.attachments.length)) {
        // Fall through to text sending below
      } else if (!params.content) {
        return { platformMessageId: lastMessageId }
      } else {
        // Caption was sent with the first attachment
        return { platformMessageId: lastMessageId }
      }
    }

    // Send text message (or remaining text if caption was too long)
    if (params.content) {
      // ─── Rich message path (Bot API 10.1) ────────────────────────────────
      // Auto-detect: when the content contains block-level markdown (heading,
      // table, list, code fence, blockquote, hr), send it as a rich message
      // via `sendRichMessage` so Telegram renders headings/tables/lists/etc.
      // natively. Otherwise fall through to the legacy plain-text path.
      const useRich = markdownHasRichBlocks(params.content)
      if (useRich) {
        try {
          const { pages } = markdownToTelegramHtml(params.content)
          for (let i = 0; i < pages.length; i++) {
            const body: Record<string, unknown> = {
              chat_id: params.chatId,
              rich_message: { html: pages[i] },
            }
            if (params.threadId) body.message_thread_id = Number(params.threadId)
            if (i === 0 && params.replyToMessageId && !params.attachments?.length) {
              body.reply_parameters = { message_id: Number(params.replyToMessageId) }
            }
            const result = await telegramApi(token, 'sendRichMessage', body) as { message_id: number }
            lastMessageId = String(result.message_id)
          }
          return { platformMessageId: lastMessageId }
        } catch (richErr) {
          // Fallback: rich-message API rejected the payload (unsupported tag,
          // too-large table, etc.). Fall back to legacy sendMessage with the
          // raw markdown content — better a plain-text delivery than a lost
          // reply. Log the rich-path failure for debugging.
          log.warn({ channelId: _channelId, err: richErr }, 'Telegram sendRichMessage failed, falling back to sendMessage')
        }
      }
      // ─── End rich message path ────────────────────────────────────────────

      const chunks = splitMessage(params.content)
      for (let i = 0; i < chunks.length; i++) {
        const body: Record<string, unknown> = {
          chat_id: params.chatId,
          text: chunks[i],
        }
        if (params.threadId) body.message_thread_id = Number(params.threadId)

        if (i === 0 && params.replyToMessageId && !params.attachments?.length) {
          body.reply_parameters = { message_id: Number(params.replyToMessageId) }
        }

        const result = await telegramApi(token, 'sendMessage', body) as { message_id: number }
        lastMessageId = String(result.message_id)
      }
    }

    return { platformMessageId: lastMessageId }
  }

  async validateConfig(cfg: Record<string, unknown>): Promise<{ valid: boolean; error?: string }> {
    try {
      const token = await resolveToken(cfg)
      await telegramApi(token, 'getMe')
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Invalid bot token' }
    }
  }

  async getBotInfo(cfg: Record<string, unknown>): Promise<{ name: string; username?: string } | null> {
    try {
      const token = await resolveToken(cfg)
      const result = await telegramApi(token, 'getMe') as {
        first_name: string
        username?: string
      }
      return { name: result.first_name, username: result.username }
    } catch {
      return null
    }
  }

  async sendTypingIndicator(_channelId: string, cfg: Record<string, unknown>, chatId: string, threadId?: string): Promise<void> {
    const token = await resolveToken(cfg)
    const body: Record<string, unknown> = { chat_id: chatId, action: 'typing' }
    if (threadId) body.message_thread_id = Number(threadId)
    await telegramApi(token, 'sendChatAction', body)
  }

  async onIdentityChange(
    _channelId: string,
    cfg: Record<string, unknown>,
    newIdentity: { agentSlug: string; agentName: string; avatarUrl?: string },
  ): Promise<void> {
    const token = await resolveToken(cfg)
    // Telegram setMyName caps the name at 64 chars (Bot API spec).
    const name = newIdentity.agentName.slice(0, 64)
    await telegramApi(token, 'setMyName', { name })
    // Telegram bot avatars are NOT settable via Bot API: BotFather is the only
    // entry point. Log a debug note when an avatar was provided so operators
    // know it was intentionally skipped.
    if (newIdentity.avatarUrl) {
      log.debug(
        { agentSlug: newIdentity.agentSlug, avatarUrl: newIdentity.avatarUrl },
        'Telegram avatar swap skipped: setMyName is the only identity API the Bot API exposes; avatars require BotFather.',
      )
    }
  }

  /**
   * Open a streaming-draft session (Bot API 10.1 `sendRichMessageDraft`).
   * Returns a {@link ChannelDraftStream} that the host feeds text deltas to
   * as the LLM streams, then commits (persist) or aborts (discard).
   *
   * Throttling: flushes to Telegram at most once every 400ms (D7 = time-based).
   * The draft is ephemeral (Telegram auto-expires it after ~30s); the host
   * MUST call `commit()` at turn end to persist it as a real message.
   *
   * `draft_id` is a per-stream integer (same id across updates animates the
   * same bubble; Telegram requires a non-zero value).
   */
  async streamDraft(
    channelId: string,
    cfg: Record<string, unknown>,
    params: OutboundMessageParams,
  ): Promise<ChannelDraftStream> {
    const token = await resolveToken(cfg)
    const chatId = params.chatId
    const replyTo = params.replyToMessageId
    const threadId = params.threadId
    // Per-process monotonic draft id; Telegram only requires it be non-zero
    // and reused across updates for the same draft bubble.
    const draftId = ++telegramDraftIdCounter
    const THROTTLE_MS = 400
    let accumulated = ''
    let lastFlushAt = 0
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let finished = false
    // Track the platform message id returned by commit() so the result is
    // shaped like OutboundMessageResult.
    let committedMessageId = ''

    async function flushToTelegram(): Promise<void> {
      if (finished) return
      if (!accumulated) return
      const html = markdownToTelegramHtml(accumulated).pages[0] ?? ''
      // Empty html (e.g. only whitespace) — skip to avoid sending an empty
      // draft that Telegram would reject.
      if (!html) return
      try {
        const draftBody: Record<string, unknown> = {
          chat_id: chatId,
          draft_id: draftId,
          rich_message: { html },
        }
        if (threadId) draftBody.message_thread_id = Number(threadId)
        await telegramApi(token, 'sendRichMessageDraft', draftBody)
        lastFlushAt = Date.now()
      } catch (err) {
        // Draft update failures are non-fatal — the draft is ephemeral and
        // the final commit will retry via sendRichMessage (with fallback to
        // sendMessage). Log for debugging but don't throw.
        log.debug({ channelId, draftId, err }, 'Telegram draft update failed (non-fatal)')
      }
    }

    function scheduleFlush(): void {
      if (flushTimer || finished) return
      const elapsed = Date.now() - lastFlushAt
      const wait = Math.max(0, THROTTLE_MS - elapsed)
      flushTimer = setTimeout(() => {
        flushTimer = null
        void flushToTelegram()
      }, wait)
    }

    return {
      async update(_delta: string, acc: string): Promise<void> {
        if (finished) return
        accumulated = acc
        // Throttle: if enough time elapsed since last flush, flush now;
        // otherwise schedule a flush. This keeps per-token updates cheap
        // while still showing progress ~every 400ms.
        const elapsed = Date.now() - lastFlushAt
        if (elapsed >= THROTTLE_MS) {
          await flushToTelegram()
        } else {
          scheduleFlush()
        }
      },

      async commit(): Promise<OutboundMessageResult> {
        if (finished) {
          // Already finalized — return a best-effort empty result so the
          // caller doesn't crash. This shouldn't happen in normal flow.
          return { platformMessageId: committedMessageId }
        }
        finished = true
        // Cancel any pending throttled flush — we'll send the final content
        // via the commit path below.
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
        // Final flush of any remaining buffered text is NOT needed —
        // commit sends the full final content via sendRichMessage.

        // Commit: send the final accumulated text as a persistent rich
        // message. The ephemeral draft bubble is replaced by this real
        // message. Reuse the rich-vs-plain logic from sendMessage by
        // building the payload here (we can't call sendMessage directly
        // because it resolves the token again + we already have it).
        const useRich = markdownHasRichBlocks(accumulated)
        try {
          if (useRich) {
            const { pages } = markdownToTelegramHtml(accumulated)
            let lastId = ''
            for (let i = 0; i < pages.length; i++) {
              const body: Record<string, unknown> = {
                chat_id: chatId,
                rich_message: { html: pages[i] },
              }
              if (threadId) body.message_thread_id = Number(threadId)
              if (i === 0 && replyTo) {
                body.reply_parameters = { message_id: Number(replyTo) }
              }
              const result = await telegramApi(token, 'sendRichMessage', body) as { message_id: number }
              lastId = String(result.message_id)
            }
            committedMessageId = lastId
            return { platformMessageId: committedMessageId }
          }
        } catch (richErr) {
          log.warn({ channelId, err: richErr }, 'Telegram draft commit sendRichMessage failed, falling back to sendMessage')
        }
        // Fallback / plain-text path
        const chunks = splitMessage(accumulated)
        let lastId = ''
        for (let i = 0; i < chunks.length; i++) {
          const body: Record<string, unknown> = {
            chat_id: chatId,
            text: chunks[i],
          }
          if (threadId) body.message_thread_id = Number(threadId)
          if (i === 0 && replyTo) {
            body.reply_parameters = { message_id: Number(replyTo) }
          }
          const result = await telegramApi(token, 'sendMessage', body) as { message_id: number }
          lastId = String(result.message_id)
        }
        committedMessageId = lastId
        return { platformMessageId: committedMessageId }
      },

      async abort(): Promise<void> {
        if (finished) return
        finished = true
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
        // Telegram drafts auto-expire after ~30s, but we try to clear the
        // bubble immediately by sending an empty draft. This is best-effort
        // — if it fails, the draft just fades on its own.
        try {
          const abortBody: Record<string, unknown> = {
            chat_id: chatId,
            draft_id: draftId,
            rich_message: { html: '' },
          }
          if (threadId) abortBody.message_thread_id = Number(threadId)
          await telegramApi(token, 'sendRichMessageDraft', abortBody)
        } catch {
          // Best-effort — ignore.
        }
      },
    }
  }
}

// Monotonic counter for Telegram draft ids (per process). Telegram requires
// a non-zero draft_id; reusing the same id across updates animates the same
// bubble. A simple incrementing counter is sufficient.
let telegramDraftIdCounter = 0

/** Send a file to Telegram using multipart/form-data upload */
async function sendTelegramFile(
  token: string,
  chatId: string,
  att: OutboundAttachment,
  opts: { caption?: string; replyToMessageId?: string; threadId?: string },
): Promise<string> {
  const blob = await readAttachmentBlob(att)
  const fileName = attachmentFileName(att)
  const isImage = isImageAttachment(att)

  // Choose Telegram method based on file type
  const method = isImage ? 'sendPhoto' : 'sendDocument'
  const fieldName = isImage ? 'photo' : 'document'

  const form = new FormData()
  form.append('chat_id', chatId)
  if (opts.threadId) form.append('message_thread_id', opts.threadId)
  form.append(fieldName, blob, fileName)
  if (opts.caption) form.append('caption', opts.caption)
  if (opts.replyToMessageId) {
    form.append('reply_parameters', JSON.stringify({ message_id: Number(opts.replyToMessageId) }))
  }

  const resp = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    body: form,
  })
  const data = await resp.json() as { ok: boolean; result?: { message_id: number }; description?: string }
  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.description ?? 'Unknown error'}`)
  }
  return String(data.result?.message_id ?? '')
}
