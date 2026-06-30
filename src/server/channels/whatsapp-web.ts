/**
 * WhatsApp via the multi-device **web protocol** (Baileys) — QR-code pairing,
 * no Meta Cloud API and no business account required. This is a SEPARATE
 * platform (`whatsapp-web`) from the Cloud-API `whatsapp` adapter: the inbound
 * model is a long-lived socket (like Telegram polling) rather than webhooks,
 * and the "config" is a paired session rather than a static token.
 *
 * Pairing: `startWithPairing` opens the socket and streams the QR string +
 * connection lifecycle through `handlers.onPairing`; the host pushes those to
 * the UI over SSE (`channel:pairing`). Once the user scans the QR, the session
 * is persisted (Baileys multi-file auth state under the data dir) and the
 * socket reconnects automatically on restart.
 *
 * Scope of this adapter:
 *   - inbound: text messages (incl. image/video captions). Encrypted media
 *     download is intentionally out of scope for now (noted inline).
 *   - outbound: text + image/document attachments.
 */
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  type WASocket,
} from '@whiskeysockets/baileys'
import type {
  ChannelAdapter,
  ChannelAdapterMeta,
  ChannelConfigSchema,
  ChannelStartHandlers,
  IncomingMessageHandler,
  OutboundMessageParams,
  OutboundMessageResult,
} from '@/server/channels/adapter'
import { readAttachmentBlob, attachmentFileName, isImageAttachment } from '@/server/channels/adapter'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'

const log = createLogger('channel:whatsapp-web')

// Baileys expects a pino-like logger. A self-returning silent stub keeps its
// internal chatter out of our logs without pulling pino in directly.
const silentLogger: any = {
  level: 'silent',
  child: () => silentLogger,
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
}

const MAX_RECONNECT_BACKOFF_MS = 30_000

interface ChannelRuntime {
  sock: WASocket | null
  handlers: ChannelStartHandlers
  /** Set when stop() was called so the close handler doesn't reconnect. */
  stopping: boolean
  reconnectBackoff: number
  /** Latest known connection state, for validateConfig / getBotInfo. */
  connected: boolean
  selfName?: string
}

const runtimes = new Map<string, ChannelRuntime>()

function sessionDir(channelId: string): string {
  return join(config.channels.whatsappWebDir, channelId)
}

/** Pull a plain-text body out of a Baileys message (text + media captions). */
export function extractText(message: Record<string, any> | null | undefined): string {
  if (!message) return ''
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    ''
  )
}

export class WhatsAppWebAdapter implements ChannelAdapter {
  readonly platform = 'whatsapp-web'
  readonly meta: ChannelAdapterMeta = { displayName: 'WhatsApp (QR)', brandColor: '#25D366' }
  // Pairs by QR scan — no static credential to enter.
  readonly pairing = 'qr' as const
  // The adapter can rename itself on transfer only via the linked phone, which
  // we don't control — prefix outbound so the user always knows who's writing.
  readonly identitySwitchMode = 'prefix' as const

  // No user-entered fields: the "config" is the paired session on disk.
  readonly configSchema: ChannelConfigSchema = { fields: [] }

  /** Plain start (boot restore): reconnect from a stored session, no QR sink. */
  async start(channelId: string, config: Record<string, unknown>, onMessage: IncomingMessageHandler): Promise<void> {
    await this.startWithPairing(channelId, config, { onMessage })
  }

  async startWithPairing(
    channelId: string,
    _config: Record<string, unknown>,
    handlers: ChannelStartHandlers,
  ): Promise<void> {
    // Idempotent restart: tear down any existing socket for this channel.
    const prior = runtimes.get(channelId)
    if (prior) {
      prior.stopping = true
      try { prior.sock?.end(undefined) } catch { /* ignore */ }
    }
    const runtime: ChannelRuntime = {
      sock: null,
      handlers,
      stopping: false,
      reconnectBackoff: 0,
      connected: false,
    }
    runtimes.set(channelId, runtime)
    await this.openSocket(channelId, runtime)
  }

  private async openSocket(channelId: string, runtime: ChannelRuntime): Promise<void> {
    const dir = sessionDir(channelId)
    mkdirSync(dir, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(dir)

    let version: [number, number, number] | undefined
    try {
      ;({ version } = await fetchLatestBaileysVersion())
    } catch {
      // Best-effort: fall back to the version bundled with Baileys.
    }

    const sock = makeWASocket({
      auth: state,
      version,
      browser: Browsers.ubuntu('Hivekeep'),
      logger: silentLogger,
      markOnlineOnConnect: false,
    })
    runtime.sock = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update
      if (qr) {
        runtime.handlers.onPairing?.({ type: 'qr', qr })
      }
      if (connection === 'open') {
        runtime.connected = true
        runtime.reconnectBackoff = 0
        runtime.selfName = sock.user?.name ?? sock.user?.id
        log.info({ channelId, user: sock.user?.id }, 'WhatsApp-Web session connected')
        runtime.handlers.onPairing?.({ type: 'connected' })
      }
      if (connection === 'close') {
        runtime.connected = false
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode
        if (runtime.stopping) return
        if (statusCode === DisconnectReason.loggedOut) {
          // Session invalidated on the phone — wipe it so the next start re-pairs.
          log.warn({ channelId }, 'WhatsApp-Web logged out; clearing stored session')
          try { rmSync(sessionDir(channelId), { recursive: true, force: true }) } catch { /* ignore */ }
          runtime.handlers.onPairing?.({ type: 'logged-out' })
          runtimes.delete(channelId)
          return
        }
        // Transient drop — reconnect with capped backoff.
        runtime.reconnectBackoff = Math.min(
          runtime.reconnectBackoff ? runtime.reconnectBackoff * 2 : 1000,
          MAX_RECONNECT_BACKOFF_MS,
        )
        log.info({ channelId, statusCode, backoff: runtime.reconnectBackoff }, 'WhatsApp-Web connection closed; reconnecting')
        setTimeout(() => {
          const current = runtimes.get(channelId)
          if (!current || current !== runtime || runtime.stopping) return
          void this.openSocket(channelId, runtime).catch((err) => {
            log.error({ channelId, err }, 'WhatsApp-Web reconnect failed')
            runtime.handlers.onPairing?.({ type: 'error', message: err instanceof Error ? err.message : 'reconnect failed' })
          })
        }, runtime.reconnectBackoff)
      }
    })

    sock.ev.on('messages.upsert', (upsert) => {
      if (upsert.type !== 'notify') return
      for (const m of upsert.messages) {
        const remoteJid = m.key?.remoteJid
        if (!remoteJid || m.key?.fromMe) continue
        // Ignore status broadcasts and our own newsletter/system jids.
        if (remoteJid === 'status@broadcast') continue
        const text = extractText(m.message as Record<string, any> | null | undefined)
        if (!text) continue // media-only messages: download is out of scope for now
        const isGroup = remoteJid.endsWith('@g.us')
        const senderJid = isGroup ? (m.key?.participant ?? remoteJid) : remoteJid
        // Detect a reply-to-the-bot: Baileys puts a quoted-message contextInfo on
        // extendedTextMessage (text replies); its `participant` is the JID of the
        // sender of the quoted message. If that equals the bot's own JID, this is a
        // reply to one of our messages — used by the WA group access-control gate
        // (only reply-to-bot group messages are processed unless allowAllInGroups).
        const waCtx = (m.message as Record<string, any> | null)?.extendedTextMessage?.contextInfo
        const botJid = runtime.sock?.user?.id
        const isReplyToBot = !!(
          waCtx?.participant && botJid &&
          jidNormalizedUser(waCtx.participant) === jidNormalizedUser(botJid)
        )
        // Group @mention of the bot: Baileys lists mentioned JIDs in
        // contextInfo.mentionedJid. Treat a mention of the bot's own JID like a
        // reply-to-bot so group messages that @mention the bot are processed
        // (not just replies).
        const isMentioned = !!(
          Array.isArray(waCtx?.mentionedJid) && botJid &&
          (waCtx!.mentionedJid as string[]).some((j) => jidNormalizedUser(j) === jidNormalizedUser(botJid))
        )
        void runtime.handlers
          .onMessage({
            platformUserId: jidNormalizedUser(senderJid),
            platformDisplayName: m.pushName ?? undefined,
            platformMessageId: m.key?.id ?? '',
            platformChatId: remoteJid,
            content: text,
            chatType: isGroup ? 'group' : 'private',
            isReplyToBot,
            isMentioned,
            metadata: { whatsappWeb: { group: isGroup } },
          })
          .catch((err) => log.error({ channelId, err }, 'Failed to handle inbound WhatsApp-Web message'))
      }
    })
  }

  async stop(channelId: string): Promise<void> {
    const runtime = runtimes.get(channelId)
    if (!runtime) return
    runtime.stopping = true
    try {
      runtime.sock?.end(undefined)
    } catch (err) {
      log.warn({ channelId, err }, 'Error ending WhatsApp-Web socket')
    }
    runtimes.delete(channelId)
  }

  async sendMessage(
    channelId: string,
    _config: Record<string, unknown>,
    params: OutboundMessageParams,
  ): Promise<OutboundMessageResult> {
    const runtime = runtimes.get(channelId)
    if (!runtime?.sock || !runtime.connected) {
      throw new Error('WhatsApp-Web channel is not connected — scan the QR code to pair it.')
    }
    const jid = params.chatId.includes('@') ? params.chatId : jidNormalizedUser(`${params.chatId}@s.whatsapp.net`)

    let lastId = ''
    if (params.attachments?.length) {
      for (let i = 0; i < params.attachments.length; i++) {
        const att = params.attachments[i]!
        const blob = await readAttachmentBlob(att)
        const buffer = Buffer.from(await blob.arrayBuffer())
        const caption = i === 0 ? params.content : undefined
        const content = isImageAttachment(att)
          ? { image: buffer, caption }
          : { document: buffer, mimetype: att.mimeType, fileName: attachmentFileName(att), caption }
        const sent = await runtime.sock.sendMessage(jid, content as Parameters<WASocket['sendMessage']>[1])
        lastId = sent?.key?.id ?? lastId
      }
      // Text already delivered as the first attachment's caption.
      if (params.content) return { platformMessageId: lastId }
      return { platformMessageId: lastId }
    }

    const sent = await runtime.sock.sendMessage(jid, { text: params.content })
    return { platformMessageId: sent?.key?.id ?? '' }
  }

  /**
   * For this adapter the "config" is the paired session, so validity is "is a
   * session connected". validateConfig only receives the static config (no
   * channelId), so it can't probe a specific channel — it returns valid and
   * lets the live connection state drive the channel status instead.
   */
  async validateConfig(_config: Record<string, unknown>): Promise<{ valid: boolean; error?: string }> {
    return { valid: true }
  }

  async getBotInfo(_config: Record<string, unknown>): Promise<{ name: string; username?: string } | null> {
    // No channelId here, so we can't resolve the specific paired number; the
    // host falls back to the channel name. Connection detail is surfaced via
    // the pairing SSE events instead.
    return null
  }

  /** Whether a given channel currently has a live, connected session. */
  isConnected(channelId: string): boolean {
    return runtimes.get(channelId)?.connected ?? false
  }
}

/** Shared singleton instance (registered in main.ts). Exported so routes can
 *  query live connection state for a channel. */
export const whatsAppWebAdapter = new WhatsAppWebAdapter()
