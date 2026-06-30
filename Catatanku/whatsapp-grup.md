# WhatsApp grup — allowlist nomor + reply-only (RC-1 lanjutan)

> Tanggal: 2026-06-30 · Status: **DONE (lokal, belum deploy)**.

## Permintaan

Di grup WhatsApp, hanya nomor WA tertentu yang direspon, dan hanya yang reply (balas ke pesan bot) yang direspon.

## Audit singkat

Telegram punya gate (`telegramAccessGate` + env `OWNER_TELEGRAM_USER_ID` / `TELEGRAM_ALLOWED_USERS` / `ALLOW_ALL_USERS_IN_GROUPS`). WhatsApp-web **belum** punya padanannya: gate Telegram no-op untuk platform non-telegram, dan adapter WA cuma kirim `metadata.group`, gak deteksi reply-to-bot. Jadi WA grup dulu-respon semua pesan dari contact-approved.

## Fix yang diterapkan

1. **Adapter** (`src/server/channels/whatsapp-web.ts`): deteksi reply-to-bot lewat Baileys `message.extendedTextMessage.contextInfo.participant` dibanding `runtime.sock.user.id` (bot JID). Kirim `chatType` ('group'|'private'), `isReplyToBot`, `isMentioned:false` di `onMessage`.

2. **Config** (`src/server/config.ts`): 3 field baru (mirror Telegram):
   - `whatsappOwnerUserId` ← `OWNER_WHATSAPP_USER_ID` (digit, contoh `6281234567890`)
   - `whatsappAllowAllInGroups` ← `GEZY_WHATSAPP_ALLOW_ALL_IN_GROUPS=true`
   - `whatsappAllowedUsers` ← `GEZY_WHATSAPP_ALLOWED_USERS` (comma-separated, dinormalisasi ke digit mentah — JID/nomor/+62… semua match)

3. **Gate** (`src/server/services/channels.ts`): `matchWhatsappAllowlist` + `whatsappAccessDecision` (pure) + `whatsappAccessGate`. Aturan: DM authorized → proses; grup authorized + (allowAllInGroups ATAU isReplyToBot) → proses; selain itu drop (dm-unregistered → balas "Maaf…" sekali). Dipanggil di `handleIncomingChannelMessage` setelah gate Telegram.

4. **Docs**: `docs-site/src/content/docs/channels/whatsapp-web.md` baru — section Access Control + env table + behaviour matrix (mirror Telegram).

5. **Test**: `whatsapp-access.test.ts` (13 test: matchWhatsappAllowlist 4 + whatsappAccessDecision 9). Pure, no DB/browser. 13 pass.

Validasi: typecheck clean, full suite 4192 pass / 0 fail.

## Env VPS (compose)

Tambah ke `docker/docker-compose.prod.yml` (env service gezy):
```
- OWNER_WHATSAPP_USER_ID=62<nomor kamu>
- GEZY_WHATSAPP_ALLOWED_USERS=62<nomor1>,62<nomor2>
- GEZY_WHATSAPP_ALLOW_ALL_IN_GROUPS=false
```
`GEZY_WHATSAPP_ALLOW_ALL_IN_GROUPS=false` → di grup cuma reply-ke-bot yang direspon. `true` → semua pesan authorized diproses.

## Catatan
- Nomor dinormalisasi ke digit mentah: pakai format `62...` (country code tanpa `+`/spasi/dash). JID `6281...@s.whatsapp.net` juga match.
- Reply-to-bot detect dari `contextInfo.participant === botJid`. Kalau user reply pesan orang lain di grup → gak diproses (default `false`). Sesuai permintaan "yg reply saja yg direspon".
- Kalau env gak diset (no owner + empty allowlist) → gate no-op, kontak-approval gate bawaan tetap jalan (new sender → pending approval). Aman.
- DM (private) authorized selalu diproses tanpa perlu reply.

## Estimasi: ~0.5 hari (audit + implement + test + docs).