/**
 * KinBot plugin: twilio-sms
 *
 * Channel adapter that sends and receives SMS via Twilio:
 *   - outbound: POST to https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json
 *   - inbound: signed webhook at /api/channels/plugin/twilio-sms/webhook/{channelId}
 *
 * This file is the scaffold. Real outbound and inbound logic land in the
 * following commits; sendMessage and handleInboundWebhook here are stubs.
 */

import type {
  ChannelAdapter,
  IncomingMessage,
  IncomingMessageHandler,
  OutboundMessageParams,
  OutboundMessageResult,
} from '@/server/channels/adapter'
import { getSecretValue } from '@/server/services/vault'
import { getAccount, sendSms, TwilioApiException, type TwilioAuth } from './twilioApi'

// ─── Plugin context (loose typing, mirrors the teamspeak plugin) ────────────

interface PluginCtxLog {
  debug(msg: string): void
  debug(obj: Record<string, unknown>, msg: string): void
  info(msg: string): void
  info(obj: Record<string, unknown>, msg: string): void
  warn(msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
  error(msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

interface PluginCtx {
  config: Record<string, unknown>
  log: PluginCtxLog
  manifest: { name: string; version: string }
}

// ─── Resolved channel config shape ──────────────────────────────────────────
// Stored in `channels.platformConfig` as JSON. The Auth Token is a password
// field so KinBot replaces it with `authTokenVaultKey` on persistence; the
// real value is fetched from the vault at use time. Plain-text fallback is
// supported for tests and dev-time fixtures.

export interface TwilioChannelConfig {
  accountSid: string
  authToken?: string
  authTokenVaultKey?: string
  fromNumber: string
}

async function resolveAuth(config: Record<string, unknown>): Promise<TwilioAuth> {
  const cfg = config as Partial<TwilioChannelConfig>
  if (!cfg.accountSid || typeof cfg.accountSid !== 'string') {
    throw new Error('Twilio channel config missing accountSid')
  }
  let token = typeof cfg.authToken === 'string' ? cfg.authToken : ''
  if (!token && typeof cfg.authTokenVaultKey === 'string') {
    const fromVault = await getSecretValue(cfg.authTokenVaultKey)
    if (!fromVault) {
      throw new Error(`Twilio Auth Token vault key "${cfg.authTokenVaultKey}" not found`)
    }
    token = fromVault
  }
  if (!token) {
    throw new Error('Twilio channel config missing authToken (or authTokenVaultKey)')
  }
  return { accountSid: cfg.accountSid, authToken: token }
}

function requireFromNumber(config: Record<string, unknown>): string {
  const cfg = config as Partial<TwilioChannelConfig>
  if (!cfg.fromNumber || typeof cfg.fromNumber !== 'string') {
    throw new Error('Twilio channel config missing fromNumber')
  }
  return cfg.fromNumber
}

const E164_RE = /^\+[1-9]\d{1,14}$/

// ─── Plugin entry point ─────────────────────────────────────────────────────

export default function twilioSmsPlugin(ctx: PluginCtx): {
  channels: { 'twilio-sms': ChannelAdapter }
  activate?: () => Promise<void>
  deactivate?: () => Promise<void>
} {
  const adapter: ChannelAdapter = {
    platform: 'twilio-sms',
    meta: {
      displayName: 'Twilio SMS',
      brandColor: '#F22F46',
    },

    async start(
      channelId: string,
      _config: Record<string, unknown>,
      _onMessage: IncomingMessageHandler,
    ): Promise<void> {
      // Twilio is webhook-driven; nothing to start at the transport layer.
      // The dispatcher route invokes handleInboundWebhook on each request.
      ctx.log.info({ channelId }, 'twilio-sms channel started')
    },

    async stop(channelId: string): Promise<void> {
      ctx.log.info({ channelId }, 'twilio-sms channel stopped')
    },

    async validateConfig(config: Record<string, unknown>): Promise<{ valid: boolean; error?: string }> {
      try {
        const auth = await resolveAuth(config)
        const fromNumber = (config as Partial<TwilioChannelConfig>).fromNumber
        if (!fromNumber || !E164_RE.test(fromNumber)) {
          return { valid: false, error: 'fromNumber must be E.164 (e.g. +15551234567)' }
        }
        const account = await getAccount(auth)
        if (account.status && account.status !== 'active') {
          return { valid: false, error: `Twilio account is not active (status: ${account.status})` }
        }
        return { valid: true }
      } catch (err) {
        if (err instanceof TwilioApiException) {
          return { valid: false, error: err.message }
        }
        return { valid: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    async getBotInfo(config: Record<string, unknown>): Promise<{ name: string; username?: string } | null> {
      const cfg = config as Partial<TwilioChannelConfig>
      try {
        const auth = await resolveAuth(config)
        const account = await getAccount(auth)
        return {
          name: account.friendly_name || 'Twilio SMS',
          username: cfg.fromNumber ?? undefined,
        }
      } catch (err) {
        ctx.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'twilio-sms getBotInfo failed; returning fallback',
        )
        return { name: 'Twilio SMS', username: cfg.fromNumber ?? undefined }
      }
    },

    async sendMessage(
      _channelId: string,
      config: Record<string, unknown>,
      params: OutboundMessageParams,
    ): Promise<OutboundMessageResult> {
      const auth = await resolveAuth(config)
      const from = requireFromNumber(config)
      const to = params.chatId
      if (!E164_RE.test(to)) {
        throw new Error(`Recipient ${to} is not in E.164 format (must start with + and 8-15 digits)`)
      }
      const body = (params.content ?? '').trim()
      if (!body) {
        throw new Error('Cannot send empty SMS body')
      }
      const result = await sendSms({ auth, from, to, body })
      ctx.log.info(
        { sid: result.sid, status: result.status, to, from },
        'twilio-sms message sent',
      )
      return {
        platformMessageId: result.sid,
        deliveryMeta: {
          twilio: { status: result.status, to, from },
        },
      }
    },

    async handleInboundWebhook(
      _channelId: string,
      _config: Record<string, unknown>,
      _req: Request,
    ): Promise<{ incoming: IncomingMessage | null; response: Response }> {
      throw new Error('twilio-sms handleInboundWebhook not implemented yet')
    },
  }

  return {
    channels: { 'twilio-sms': adapter },

    async activate(): Promise<void> {
      ctx.log.info({ plugin: ctx.manifest.name, version: ctx.manifest.version }, 'twilio-sms plugin activated')
    },

    async deactivate(): Promise<void> {
      ctx.log.info('twilio-sms plugin deactivated')
    },
  }
}
