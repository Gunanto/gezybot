---
title: WhatsApp (QR)
description: Connect your Agent to WhatsApp via the multi-device web protocol (QR pairing, no business account).
---

WhatsApp integration uses the multi-device **web protocol** (Baileys) — QR-code pairing, no Meta Cloud API and no business account required. The inbound model is a long-lived socket (like Telegram polling); the "config" is a paired session persisted under the data dir and reconnected automatically on restart.

## Setup

1. In Gezy, go to your Agent's **Channels** tab
2. Click **Add Channel**, select **WhatsApp (QR)**
3. Scan the QR code with your phone (WhatsApp → Settings → Linked Devices → Link a device)
4. The session connects and persists; it reconnects automatically on restart

## Access Control (DM vs Group + Allowlist)

WhatsApp-Web has the same access-control gate as Telegram: an env allowlist + owner, processing group messages only when they **@mention the bot or reply to one of its messages** (unless you opt into processing all group messages). New senders that pass the gate still go through the per-channel contact-approval flow.

`authorized` = sender is the owner or in `GEZY_WHATSAPP_ALLOWED_USERS`.

| `chatType` | sender | mention/reply? | `GEZY_WHATSAPP_ALLOW_ALL_IN_GROUPS` | result |
|---|---|---|---|---|
| `private` (DM) | owner | n/a | n/a | ✅ process |
| `private` (DM) | allowlist | n/a | n/a | ✅ process |
| `private` (DM) | other | n/a | n/a | ❌ reply once: "Maaf, Anda belum terdaftar berkomunikasi dengan Saya.", then silent drop |
| `group` | owner | yes | any | ✅ process |
| `group` | owner | no | `false` | ❌ silent drop |
| `group` | owner | no | `true` | ✅ process |
| `group` | allowlist | yes | any | ✅ process |
| `group` | allowlist | no | `false` | ❌ silent drop |
| `group` | allowlist | no | `true` | ✅ process |

A "reply-to-bot" is detected from the quoted-message `contextInfo.participant` matching the bot's own JID, and an "@mention of the bot" is detected from `contextInfo.mentionedJid` containing the bot's JID. In groups, either signal triggers processing (unless `GEZY_WHATSAPP_ALLOW_ALL_IN_GROUPS=true`, which processes all authorized group messages).

### WhatsApp privacy & LIDs (Linked Identity)

WhatsApp may deliver messages from a sender using a **LID** (`<random>@lid`) instead of their phone-number JID (`<number>@s.whatsapp.net`) — a privacy feature that hides phone numbers. Gezy listens to Baileys `lid-mapping.update` events and resolves `@lid` sender JIDs to the phone-number JID before the access-control gate runs, so you can allowlist by phone number (`6281...`) as usual.

If a mapping has not been learned yet (e.g. the very first message from a brand-new contact), the sender is matched against the LID digits instead — as a fallback you can also add a LID's digits to `GEZY_WHATSAPP_ALLOWED_USERS`. Once the mapping arrives, phone-number matching takes over.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `OWNER_WHATSAPP_USER_ID` | _(unset)_ | WhatsApp number (digits, e.g. `6281234567890`) of the owner. This user **always** has full access. Matched by digits only, so it cannot be spoofed by a display name. |
| `GEZY_WHATSAPP_ALLOW_ALL_IN_GROUPS` | `false` | `true` → process every group message from an authorized user (no reply-to-bot needed). `false` → only process group messages that reply to one of the bot's messages. DMs are unaffected. |
| `GEZY_WHATSAPP_ALLOWED_USERS` | _(empty)_ | Comma-separated whitelist of WhatsApp numbers. Entries are normalized to bare digits, so `6281234567890`, `+62 812-3456-7890`, and the full JID `6281234567890@s.whatsapp.net` all match. If empty, **only** the owner can interact. The owner is always implicitly allowed. Example: `GEZY_WHATSAPP_ALLOWED_USERS=6281234567890,6281211002200` |

### Notes

- The owner is **not** exempt from the group reply rule (unless `GEZY_WHATSAPP_ALLOW_ALL_IN_GROUPS=true`). In a group the bot cannot otherwise tell when the owner is addressing it vs. just chatting.
- When nothing is configured (no owner + empty allowlist), the gate is a no-op and the pre-existing contact-approval gate applies unchanged (new senders become "pending" until an admin approves them).
- Identifiers are normalized to digits: include the country code, no `+`, no spaces/dashes. A JID like `6281234567890@s.whatsapp.net` is reduced to `6281234567890` for matching.