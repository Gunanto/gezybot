---
title: Telegram
description: Connect your Agent to Telegram using a bot.
---

Telegram integration uses the [Bot API](https://core.telegram.org/bots/api) with automatic transport selection: **webhooks** when a public HTTPS URL is available, or **long polling** for local/development setups.

## Setup

1. **Create a bot** with [@BotFather](https://t.me/BotFather) on Telegram
2. Copy the bot token
3. In Hivekeep, go to your Agent's **Channels** tab
4. Click **Add Channel**, select **Telegram**
5. Paste your bot token. It will be encrypted in Hivekeep's vault
6. Optionally, restrict to specific chat IDs with the allowlist

Hivekeep automatically selects the best transport mode based on your configuration.

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| Bot Token | ✅ | Token from BotFather (stored encrypted) |
| Allowed Chat IDs | ❌ | Restrict to specific chats (groups or users) |

## Transport Modes

### Webhook mode (default for production)

When `PUBLIC_URL` is set and starts with `https://`, Hivekeep registers a webhook with Telegram pointing to your instance. Telegram sends updates directly to this endpoint for real-time delivery.

**Requirements:**
- `PUBLIC_URL` must be configured in your Hivekeep environment
- The URL must be HTTPS (Telegram requirement)
- Your instance must be reachable from the internet

### Long polling mode (local/development)

When `PUBLIC_URL` is not set or is not HTTPS, Hivekeep automatically falls back to **long polling** using Telegram's `getUpdates` API. This enables Telegram channels on local or development setups without a public HTTPS endpoint.

**How it works:**
- Hivekeep deletes any existing webhook on the bot (Telegram requirement before using `getUpdates`)
- A per-channel polling loop runs in the background, fetching updates every 30 seconds
- Exponential backoff (up to 30 seconds) handles transient API failures
- No public URL or HTTPS is required

:::tip
Long polling mode is selected automatically, no manual configuration needed. Just leave `PUBLIC_URL` unset or set it to a non-HTTPS URL.
:::

## How It Works

- **Inbound:** Messages are received via webhook or polling. The adapter parses text and attachments (photos, documents, audio, video) and routes them to the Agent.
- **Outbound:** Messages are sent via the Bot API. Long messages (>4,096 chars) are automatically split. File attachments are uploaded as multipart form data.

## Features

- Text messages with Markdown formatting
- **Rich messages (Bot API 10.1)** — when the Agent's reply contains block-level markdown (headings, tables, lists, code fences, blockquotes, horizontal rules, **LaTeX math**), Gezy auto-sends it via `sendRichMessage` so Telegram renders headings/tables/lists/code blocks/blockquotes/math natively. Inline math (`$…$`) and block math (`$$…$$` / ``` ```math ```) are converted to `<tg-math>` / `<tg-math-block>` tags. Plain paragraphs still use the legacy `sendMessage` path. If the rich API rejects the payload, Gezy falls back to `sendMessage` automatically.
- **Streaming drafts (Bot API 10.1)** — when an Agent's reply is triggered from a Telegram chat, Gezy streams the LLM output incrementally to Telegram via `sendRichMessageDraft` so the user sees the reply appear in real-time (type-on animation, like ChatGPT). The ephemeral draft is committed as a persistent message (`sendRichMessage`) when the LLM finishes, or discarded if the user stops the stream. Non-Telegram channels keep the one-shot delivery path.
- Image, document, audio, and video attachments (inbound and outbound)
- File attachment retry logic (1 retry with 500ms delay for transient API failures)
- Reply threading via `reply_to_message_id`
- Automatic message chunking at paragraph/line boundaries
- Typing indicator (`sendChatAction`)
- Group chat support (with optional chat ID filtering)

## Access Control (DM vs Group + Allowlist)

Hivekeep supports env-driven access control so you can restrict **who** may
talk to the bot and **how** the bot responds in groups vs DMs. This is
enforced server-side **before** any contact is created or LLM turn runs —
rejected messages never reach the Agent.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `OWNER_TELEGRAM_USER_ID` | _(unset)_ | Telegram user id (numeric) of the owner. This user **always** has full access. Matched **only** by user id, never by username, so it cannot be spoofed by changing a Telegram username. |
| `ALLOW_ALL_USERS_IN_GROUPS` | `false` | `true` → process every group/supergroup message from an authorized user (no `@mention`/reply needed). `false` → only process group messages that `@mention` the bot or reply to one of the bot's own messages. DMs are unaffected. |
| `TELEGRAM_ALLOWED_USERS` | _(empty)_ | Comma-separated whitelist. Each entry is auto-detected: pure-numeric → Telegram user id (stable, recommended); otherwise → username (without `@`, case-insensitive). If empty, **only** the owner can interact. The owner is always implicitly allowed and does not need to be listed. Example: `TELEGRAM_ALLOWED_USERS=pgun75,aantriono,6468143001,ferilee` |

:::note
When **none** of these are set, the gate is a no-op and the pre-existing
behavior applies (per-channel `allowedChatIds` + the `autoCreateContacts` /
pending-approval workflow). Setting even one enables the gate.
:::

### Behaviour matrix

`authorized` = sender is the owner or in `TELEGRAM_ALLOWED_USERS`.

| `chat.type` | sender | mention/reply? | `ALLOW_ALL_USERS_IN_GROUPS` | result |
|---|---|---|---|---|
| `private` (DM) | owner | n/a | n/a | ✅ process |
| `private` (DM) | allowlist | n/a | n/a | ✅ process |
| `private` (DM) | other | n/a | n/a | ❌ reply once: "Maaf, Anda belum terdaftar berkomunikasi dengan Saya.", then silent drop |
| `group` / `supergroup` | owner | yes | any | ✅ process |
| `group` / `supergroup` | owner | no | `false` | ❌ silent drop |
| `group` / `supergroup` | owner | no | `true` | ✅ process |
| `group` / `supergroup` | allowlist | yes | any | ✅ process |
| `group` / `supergroup` | allowlist | no | `false` | ❌ silent drop |
| `group` / `supergroup` | allowlist | no | `true` | ✅ process |
| `group` / `supergroup` | other | yes/no | any | ❌ silent drop (mention does not bypass the allowlist) |
| `channel` | any | any | any | ❌ ignore (broadcast posts) |

### Notes

- The owner is **not** exempt from the group mention rule (unless
  `ALLOW_ALL_USERS_IN_GROUPS=true`). This is intentional: in a group the bot
  cannot otherwise tell when the owner is addressing it vs. just chatting.
- The "not registered" DM reply is sent **once per session** per
  `channelId:userId` (in-memory dedup, cleared on restart) to avoid spam.
- In groups, unauthorized senders are dropped **silently** — replying would
  noise the group and leak that the bot is filtering.
- The bot's own messages are always skipped (loop prevention).
- `chat.type === 'channel'` (Telegram Channel broadcast posts) is always
  ignored — the bot is not a channel admin listener.
- This gate is **global** (applies to every Telegram channel on the
  instance). Per-channel `allowedChatIds` is a separate, complementary
  filter that still applies.
