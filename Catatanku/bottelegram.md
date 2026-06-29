# Bot Telegram untuk Hivekeep — Panduan Lengkap

Telegram adalah salah satu **6 channel native** yang built-in di Hivekeep. Anda bisa menghubungkan Agent Hivekeep ke Telegram Bot sehingga bisa chat dengan Agent langsung dari aplikasi Telegram di HP atau desktop.

---

## Gambaran Umum

```
+-------------------+        +-------------------+        +-------------------+
|   Telegram App    | ─────▶ |   Hivekeep Server  | ─────▶ |   AI Agent        |
| (HP / Desktop)    | ◀───── | (localhost:4178)   | ◀───── | (DeepSeek, etc.)  |
+-------------------+        +-------------------+        +-------------------+
```

- Anda chat dengan bot di Telegram → pesan masuk ke Hivekeep → Agent LLM merespons → balasan dikirim kembali ke Telegram
- **Channel handoff**: satu bot bisa dioper oleh beberapa Agent secara bergantian
- Token bot disimpan di **vault terenkripsi** (AES-256-GCM), tidak pernah terekspos

---

## Prasyarat

| Kebutuhan | Detail |
|---|---|
| Akun Telegram | Akun Telegram biasa (untuk chat dengan bot) |
| Bot Token | Dibuat via [@BotFather](https://t.me/BotFather) |
| Hivekeep berjalan | Server di `http://localhost:4178` |
| Agent terkonfigurasi | Minimal 1 Agent dengan LLM provider (lihat `provider.md`) |

---

## Langkah 1: Buat Bot di Telegram

1. Buka Telegram → cari dan chat dengan **[@BotFather](https://t.me/BotFather)**
2. Kirim perintah: `/newbot`
3. Ikuti instruksi BotFather:
   - Masukkan **nama bot** (contoh: `Asisten Pribadi`)
   - Masukkan **username bot** (harus diakhiri `bot`, contoh: `asisten_pribadi_bot`)
4. BotFather akan memberikan **bot token** — simpan ini:
   ```
   123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
   ```
5. **(Opsional)** Set avatar dan deskripsi bot via BotFather

---

## Langkah 2: Tambahkan Channel di Hivekeep

1. Buka **http://localhost:4178** → login (`admin@local.test` / `Password123!`)
2. Masuk ke **Settings → Channels**
3. Klik **"Add Channel"**
4. Isi form:

   | Field | Nilai |
   |---|---|
   | **Agent** | Pilih Agent yang akan merespons (misal: "Tester") |
   | **Platform** | Pilih **Telegram** |
   | **Name** | Nama channel (bebas, contoh: `Bot Telegram Pribadi`) |
   | **Bot Token** | Paste token dari @BotFather |

5. Klik **Save** — token otomatis disimpan di vault terenkripsi

---

## Langkah 3: Mulai Chat di Telegram

1. Buka Telegram → cari bot Anda berdasarkan username (contoh: `@asisten_pribadi_bot`)
2. Kirim pesan `/start` atau pesan apa pun
3. Agent akan merespons melalui bot

---

## Mode Koneksi

Hivekeep mendukung dua mode koneksi ke Telegram:

| Mode | Kapan Dipakai | Cara Kerja |
|---|---|---|
| **Polling** (default dev) | Tanpa HTTPS (localhost) | Hivekeep polling API Telegram tiap 30 detik untuk pesan baru |
| **Webhook** | Production dengan HTTPS | Telegram mengirim pesan langsung ke endpoint Hivekeep |

Karena server jalan di `http://localhost:4178` (tanpa HTTPS), Hivekeep akan **otomatis pakai polling mode**. Tidak perlu konfigurasi tambahan.

Kalau nanti deploy ke production dengan HTTPS dan `PUBLIC_URL` yang valid, Hivekeep akan otomatis switch ke webhook mode.

---

## Fitur Telegram Channel

| Fitur | Detail |
|---|---|
| **Pesan teks** | Dikirim/diterima, auto-split kalau >4096 karakter (batas Telegram) |
| **Reply/membalas** | Agent bisa membalas pesan spesifik |
| **Foto & gambar** | Dikirim sebagai attachment |
| **Dokumen** | PDF, ZIP, dll. |
| **Audio & Voice note** | Didukung |
| **Video** | Didukung |
| **Allowlist chat ID** | Opsional — batasi chat mana yang dilayani (per-chat, by `chat.id`) |
| **Kontrol akses via env** | Batasi **siapa** (by user id / username) + aturan DM vs grup mention — lihat section "Kontrol Akses via Env" |
| **Auto-create contacts** | Pengirim baru otomatis dibuatkan kontak di Hivekeep |
| **Channel handoff** | Pindahkan bot dari satu Agent ke Agent lain tanpa ganti alamat |

---

## Channel Handoff (Transfer Agent)

Salah satu fitur unggulan: Anda bisa memindahkan channel Telegram dari satu Agent ke Agent lain **tanpa mengubah alamat bot**.

1. Masuk ke **Settings → Channels**
2. Klik menu "⋯" di channel → **Transfer**
3. Pilih Agent tujuan
4. Agent baru akan menerima konteks handoff dan riwayat percakapan

> **Catatan**: Di Telegram, transfer Agent akan mengubah nama bot secara global (keterbatasan Telegram API — tidak bisa per-chat identity).

---

## Verifikasi Channel Aktif

```bash
# Cek channel yang terdaftar di database
sqlite3 /tmp/hk-test-39223/hivekeep.db \
  "SELECT id, platform, name, agent_id, is_active FROM channels;"

# Lihat log server (real-time)
tail -f /tmp/hivekeep-server.log | grep -i telegram
```

---

## Troubleshooting

| Masalah | Solusi |
|---|---|
| Bot tidak merespons | Cek status channel di Settings → Channels (pastikan `is_active=1`) |
| Token invalid | Pastikan token dari @BotFather lengkap (format: `123:ABC`) |
| Polling lambat | Polling interval 30 detik — wajar ada sedikit delay. Untuk instant, deploy dengan HTTPS + webhook |
| "No results found" di Channels | Sama seperti Providers — klik **"Add Channel"**, bukan mencari di daftar kosong |
| Error `EADDRINUSE` | Webhook mode tabrakan port — pastikan `PUBLIC_URL` di-set dengan benar |
| Bot hanya bisa 1 Agent | Channel di-bind ke 1 Agent. Untuk multi-Agent, buat beberapa channel atau pakai handoff |

---

## Konfigurasi Lanjutan

### Allowlist Chat ID (batasi pengguna)

Hivekeep mendukung pembatasan pengguna yang bisa berinteraksi dengan bot Telegram. Fitur ini berguna untuk bot pribadi yang hanya Anda sendiri (atau tim kecil) yang pakai.

**Cara kerja**: Saat Add/Edit Channel, isi field `allowedChatIds` dengan Telegram user ID yang diizinkan. Kalau diisi, bot hanya merespons user dalam daftar — user lain diabaikan.

#### Mendapatkan Telegram User ID

1. Buka Telegram → cari [@userinfobot](https://t.me/userinfobot)
2. Kirim `/start` → bot akan membalas dengan **ID** Anda
3. Catat angka tersebut (contoh: `123456789`)

Alternatif: bisa juga pakai [@RawDataBot](https://t.me/RawDataBot) atau [@getidsbot](https://t.me/getidsbot).

#### Format input

Di form Add/Edit Channel, setelah field Bot Token ada field `allowedChatIds`. Isi dengan ID yang diizinkan, pisahkan dengan koma:

```
123456789, 987654321
```

#### Level keamanan

| Konfigurasi | Perilaku |
|---|---|
| **Kosong** (default) | Semua orang bisa chat dengan bot — tidak ada pembatasan |
| **Diisi 1+ ID** | Hanya user dengan ID dalam daftar yang dilayani Agent; user lain diabaikan |

#### Catatan penting

- Ini filter **server-side** di Hivekeep — user tidak diizinkan tetap bisa mengirim pesan ke bot (Telegram sendiri tidak memblokir), tapi **Agent tidak akan merespons**
- Hivekeep tetap mencatat pesan dari user tidak diizinkan di log server untuk audit
- Di mode development (localhost/polling), filter tetap berfungsi sama seperti production

### Mode Grup

Bot Telegram bisa ditambahkan ke grup:
1. Tambahkan bot ke grup Telegram
2. Bot akan membaca semua pesan di grup (perlu `/start` dulu di private chat)
3. Secara **default** (`ALLOW_ALL_USERS_IN_GROUPS=false`), Agent hanya merespons pesan yang **`@mention` bot** atau **reply ke pesan bot** — pesan grup biasa diabaikan agar bot tidak ikut campur percakapan yang bukan ditujukan padanya. Set `ALLOW_ALL_USERS_IN_GROUPS=true` untuk membuat bot memproses semua pesan grup dari pengguna terdaftar.

> Lihat juga section "Kontrol Akses via Env (DM vs Grup + Allowlist)" di bawah untuk aturan lengkap siapa yang boleh bicara dengan bot.

### Kontrol Akses via Env (DM vs Grup + Allowlist)

Selain filter per-channel `allowedChatIds` (batasi per **chat id**), Hivekeep mendukung **kontrol akses global** berbasis env vars: batasi **siapa** (by Telegram user id / username) yang boleh bicara dengan bot, dan **kapan** bot merespons di grup vs DM. Gerbang ini dijalankan **server-side, sebelum** kontak dibuat / LLM jalan — pesan yang ditolak tidak pernah sampai ke Agent.

#### Env vars

| Variable | Default | Deskripsi |
|---|---|---|
| `OWNER_TELEGRAM_USER_ID` | _(kosong)_ | User id Telegram (numerik) owner. User ini **selalu** punya akses penuh. Dicocokkan **hanya** by user id, bukan username, supaya tidak bisa di-spoof dengan ganti username. |
| `ALLOW_ALL_USERS_IN_GROUPS` | `false` | `true` → proses **semua** pesan grup dari user terdaftar (tanpa perlu `@mention`/reply). `false` → hanya proses pesan grup yang `@mention` bot atau reply ke pesan bot. DM tidak terpengaruh. |
| `TELEGRAM_ALLOWED_USERS` | _(kosong)_ | Whitelist comma-separated. Tiap entry auto-deteksi: angka murni → Telegram user id (stabil, direkomendasikan); selain itu → username (tanpa `@`, case-insensitive). Kalau **kosong** → hanya owner yang bisa interaksi. Owner selalu diizinkan implisit, tidak perlu didaftarkan. Contoh: `TELEGRAM_ALLOWED_USERS=pgun75,aantriono,6468143001,ferilee` |

> **Jika ketiga env kosong**, gerbang nonaktif (no-op) dan perilaku lama berlaku: `allowedChatIds` per-channel + alur `autoCreateContacts` / pending-approval. Set salah satu untuk mengaktifkan gerbang.

#### Contoh `.env`

```bash
# ── Telegram Access Control ──────────────────────────────
OWNER_TELEGRAM_USER_ID=6468143001
ALLOW_ALL_USERS_IN_GROUPS=false
TELEGRAM_ALLOWED_USERS=pg957
```

#### Matriks perilaku

`authorized` = sender adalah owner atau ada di `TELEGRAM_ALLOWED_USERS`.

| `chat.type` | sender | mention/reply? | `ALLOW_ALL_USERS_IN_GROUPS` | hasil |
|---|---|---|---|---|
| `private` (DM) | owner | n/a | n/a | ✅ proses |
| `private` (DM) | allowlist | n/a | n/a | ✅ proses |
| `private` (DM) | lain | n/a | n/a | ❌ balas sekali "Maaf, Anda belum terdaftar berkomunikasi dengan Saya.", lalu drop diam |
| `group`/`supergroup` | owner | ya | bebas | ✅ proses |
| `group`/`supergroup` | owner | tidak | `false` | ❌ drop diam |
| `group`/`supergroup` | owner | tidak | `true` | ✅ proses |
| `group`/`supergroup` | allowlist | ya | bebas | ✅ proses |
| `group`/`supergroup` | allowlist | tidak | `false` | ❌ drop diam |
| `group`/`supergroup` | allowlist | tidak | `true` | ✅ proses |
| `group`/`supergroup` | lain | ya/tidak | bebas | ❌ drop diam (mention tidak bypass allowlist) |
| `channel` | * | * | * | ❌ ignore (post broadcast) |

#### Catatan penting

- **Owner tidak diistimewakan di grup** (kecuali `ALLOW_ALL_USERS_IN_GROUPS=true`). Alasannya: di grup bot tidak bisa tahu kapan owner berbicara padanya vs. sekadar chat; tanpa syarat mention, setiap pesan owner akan ditanggapi walau tidak ditujukan ke bot.
- Balasan "Maaf, Anda belum terdaftar…" dikirim **sekali per session** per `channelId:userId` (dedup in-memory, di-clear saat restart) supaya tidak spam.
- Di grup, sender tidak terdaftar di-drop **diam-diam** — membalas di grup hanya akan noise + bocor fakta bahwa bot sedang filter.
- Pesan dari bot sendiri selalu di-skip (loop prevention).
- `chat.type === 'channel'` (post broadcast Telegram Channel) selalu di-ignore.
- Gerbang ini **global** (berlaku untuk semua channel Telegram di instance). `allowedChatIds` per-channel adalah filter terpisah yang tetap berlaku berdampingan.

#### Cara dapatkan Telegram user id

1. Buka Telegram → chat dengan [@userinfobot](https://t.me/userinfobot) → `/start` → balas dengan ID Anda (contoh: `6468143001`).
2. Atau pakai [@RawDataBot](https://t.me/RawDataBot) / [@getidsbot](https://t.me/getidsbot).

#### Referensi implementasi

| File | Isi |
|---|---|
| `src/server/config.ts` (blok `channels`) | `telegramOwnerUserId`, `telegramAllowAllInGroups`, `telegramAllowedUsers` |
| `src/server/channels/telegram.ts` → `analyzeTelegramMessage` | Deteksi `chatType` / `isMentioned` / `isReplyToBot` dari raw Telegram message |
| `src/server/channels/telegram.ts` → `TelegramAdapter.getBotIdentity` | Cache `getMe()` (bot id + username) untuk deteksi mention/reply |
| `src/server/services/channels.ts` → `matchTelegramAllowlist` | Pure predicate: cek owner (by id) + allowlist (id/username campuran) |
| `src/server/services/channels.ts` → `telegramAccessDecision` | Pure decision: DM/group/channel + mention rule |
| `src/server/services/channels.ts` → `telegramAccessGate` | Async wrapper + side effect (kirim balasan "not registered" sekali) |
| `src/server/services/telegram-access.test.ts` | Unit test untuk semua rule di atas |

---

## Referensi File

| File | Isi |
|---|---|
| `src/server/channels/telegram.ts` | Adapter utama Telegram (polling, webhook, send/receive) |
| `src/server/channels/telegram-utils.ts` | Utilities (resolve file URL, extract attachments) |
| `src/server/services/channels.ts` | Manajemen channel (create, delete, transfer, vault secrets) |
| `src/server/routes/channels.ts` | REST API routes untuk channel |

---

## Ringkasan Perintah BotFather

```
/start         - Mulai bot
/newbot        - Buat bot baru
/mybots        - Lihat daftar bot Anda
/setname       - Ganti nama bot
/setuserpic    - Ganti foto profil bot
/setcommands   - Set daftar perintah bot
/token         - Dapatkan token bot yang sudah ada
/revoke        - Cabut/revoke token lama
```
