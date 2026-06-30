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

## Fix LID (Linked Identity) — root cause DM owner ditolak

### Diagnosa

Log diagnostik info-level (`WhatsApp access gate decision`) menunjukan:
```
"userId":"37456745394304@lid","chatType":"private","allow":false,"reason":"dm-unregistered",
"ownerDigits":"6285156266044","allowlistDigits":["6285156266044","6289527852099"]
```

Pengirim dikirim sebagai **LID** (`37456745394304@lid`) — fitur privasi WhatsApp
(Linked Identity) yang menyembunyikan nomor telepon di belakang identifier acak
`@lid`. `waDigits` LID → `37456745394304` → gak match owner `6285156266044` →
DM owner ditolak sebagai `dm-unregistered`. Bukan salah env, bukan salah kode
gate-nya — JID-nya emang bukan nomor telepon.

### Fix (`d9ed5912`)

- `src/server/channels/whatsapp-web.ts`:
    - `ChannelRuntime` tambah field `lidToPn: Map<string, string>`.
    - `openSocket` subscribe `sock.ev.on('lid-mapping.update', ...)` — event
      Baileys yang bawakan mapping LID ↔ PN (`{ lid, pn }`).
    - Helper `resolveLid(jid)` di onMessage: kalau JID `@lid` ada di map,
      balikin JID telepon (`@s.whatsapp.net`); kalau belum, fallback ke LID.
    - `platformUserId`, `isReplyToBot` (participant), `isMentioned`
      (mentionedJid) semua diresolve ke PN dulu → gate match terhadap nomor.
- `docs-site/channels/whatsapp-web.md`: section baru "WhatsApp privacy & LIDs".

### Fallback

Kalau mapping belum dipelajari (pesan pertama dari kontak baru sebelum Baileys
publish `lid-mapping.update`), sender tetap di-match pakai LID digits. Sebagai
escape hatch, LID-nya bisa ditambah ke `GEZY_WHATSAPP_ALLOWED_USERS`:
```
GEZY_WHATSAPP_ALLOWED_USERS=6285156266044,6289527852099,37456745394304
```
Begitu mapping datang, nomor-telepon match ambil alih.

### Status

- [x] Gate host WA: allowlist + reply-only → mention-atau-reply
- [x] Deteksi `@mention` via `contextInfo.mentionedJid`
- [x] Resolve LID → PN sebelum gate (fix DM owner ditolak)
- [x] Log diagnostik info-level (bisa dihapus nanti setelah fix terkonfirmasi)
- [ ] Tes E2E VPS: DM owner + mention + reply (tunggu deploy `d9ed5912`)

