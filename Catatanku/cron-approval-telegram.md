# CRON Approval via Telegram — Analisis & Rencana Eksekusi

> Dibuat: 1 Jul 2026 · Status: **rencana untuk eksekusi besok (2 Jul 2026)** · Prioritas: sedang

## Daftar Isi

1. [Latar belakang & masalah](#1-latar-belakang--masalah)
2. [Audit kode yang ada sekarang](#2-audit-kode-yang-ada-sekarang)
3. [Pertanyaan: bisakah approve di Telegram?](#3-pertanyaan-bisakah-approve-di-telegram)
4. [Pilihan implementasi (Opsi A, B, C)](#4-pilihan-implementasi-opsi-a-b-c)
5. [Rekomendasi & keputusan](#5-rekomendasi--keputusan)
6. [Rencana eksekusi.step-by-step (Opsi A)](#6-rencana-eksekusi-step-by-step-opsi-a)
7. [Rencana eksekusi tambahan (Opsi B)](#7-rencana-eksekusi-tambahan-opsi-b)
8. [Test & verifikasi](#8-test--verifikasi)
9. [Pitfalls & safety](#9-pitfalls--safety)
10. [Update Catatanku terkait](#10-update-catatanku-terkait)

---

## 1. Latar belakang & masalah

### Cerita user

Di Telegram, user (admin/pemilik bot) minta Agent Yefia buat cron "kirim 5 soal OSN Matematika SMP setiap Senin jam 19:30":
```
[7/1/26 8:59 PM] P Gun: Yefia, buat cron kirim 5 soal OSN Matematika SMP ke saya setiap hari Senin jam 7.30 malam.
[7/1/26 9:00 PM] yefia: Saya tanya dulu, Pak — soalnya nanti hasilnya beda ukuran file dan effortnya. Tunggu jawabannya ya, setelah itu langsung saya buatkan cron-nya.
[7/1/26 9:01 PM] P Gun: tanya nya bisa di sini aja untuk saya approve atau pilih?
[7/1/26 9:01 PM] yefia: Maaf, Pak, untuk approval cron-nya memang harus lewat web Gezy... Saya nggak punya akses untuk approve dari sini.
```

### Masalah inti

Bot terpaksa bilang "tidak bisa approve dari sini" karena:

1. Approval cron saat ini HANYA via REST endpoint `POST /api/crons/:id/approve` yang butuh cookie sesi web (tidak bisa dipanggil dari Telegram chat).
2. Tidak ada handler perintah `/setujui` atau `/approve` di adapter Telegram di kode saat ini.
3. Tidak ada inline button "Setujui" yang dikirim ke chat saat cron pending.

### Tujuan user

Admin/pemilik bot bisa menyetujui cron dari chat Telegram (atau WhatsApp), tidak perlu buka web Gezy — cukup balas di chat tempat bot berkomunikasi. Terutama untuk skenario aplikasi mobile (HP).

---

## 2. Audit kode yang ada sekarang

### 2.1 Pembuatan cron oleh Agent

**File:** `src/server/services/crons.ts:85-93`

```ts
export async function createCron(params, isAgentCreated, ...) {
  const id = uuid()
  // ...
  const created = await db.insert(crons).values({
    id, name: params.name, schedule: params.schedule,
    agentId: isAgentCreated ? params.agentId : null,
    isActive: !isAgentCreated,  // ⚠️ Agent-created = inactive day 1
    requiresApproval: isAgentCreated,  // ⚠️ Agent-created = butuh approval
    ...
  })
  ...
}
```

Ketika Agent buat cron → `isAgentCreated = true` → cron dibuat dengan `requiresApproval: true, isActive: false`. Cron **tidak akan jalan** sampai `requiresApproval` diset `false`.

### 2.2 Notifikasi SSE + UI pending

**File:** `src/server/services/crons.ts:121-132`

```ts
if (isAgentCreated) {
  // SSE event → sidebar UI pickup
  sseManager.broadcast({...})
  
  // Persistent notification untuk UI (badge "pending approval" sidebar)
  await createNotification({
    type: 'cron:pending-approval',
    title: 'Cron needs approval',
    body: params.name,
    agentId: params.agentId,
    relatedId: id,
    relatedType: 'cron',
  })
}
```

Notifikasi ini **khusus untuk web UI** (badge kuning di sidebar Crons). Tidak terkirim ke channel eksternal (Telegram/WA).

### 2.3 Approve cron (yang sudah ada)

**File:** `src/server/services/crons.ts:223-239`

```ts
export async function approveCron(cronId: string) {
  await db.update(crons)
    .set({ requiresApproval: false, isActive: true, updatedAt: new Date() })
    .where(eq(crons.id, cronId))
  
  const approved = await db.select().from(crons).where(eq(crons.id, cronId)).get()
  if (approved) {
    scheduleJob(approved)  // ⚡ jadwalkan via croner
    sseManager.broadcast({ type: 'cron:approved', ... })
  }
  return approved
}
```

✅ Function `approveCron(cronId)` sudah siap dipakai. Tinggal panggil dari code path Telegram (tidak perlu modifikasi fungsi ini).

### 2.4 REST endpoint approve

**File:** `src/server/routes/crons.ts` (atau routes terkait)

```
POST /api/crons/:id/approve
  → Auth middleware cookie sesi web
  → Memanggil approveCron(req.params.id)
  → Return updated cron
```

Tidak bisa dipanggil dari Telegram (butuh cookie). Perlu jalan baru untuk Telegram.

### 2.5 Handler command `/start` (pattern yang akan diikuti)

**File:** `src/server/services/channels.ts:828-830` + `1074-1120`

```ts
// handleIncomingChannelMessage() — PRE-AGENT, tidak enqueue ke LLM
if (/^\/start(?:\s|@|$)/.test(incoming.content)) {
  await handleBotStart(channel, incoming, senderName)
  return  // ⛔ skip Agent queue
}

async function handleBotStart(channel, incoming, senderName) {
  const agent = ...; const welcomeText = `Hi! I'm ${agentName}...`
  await adapter.sendMessage(channel.id, cfg, {
    chatId: incoming.platformChatId,
    content: welcomeText,
    threadId: incoming.metadata?.threadId,  // ← topik yang benar
    replyToMessageId: incoming.platformMessageId,
  })
  // Update stats, return tanpa enqueue Agent
}
```

✅ **Pattern akan diikuti untuk `/setujui`:** ditangani pra-Agent, kirim balasan langsung, skip queue Agent. Jangan pernah menuju Agent (Agent tidak boleh punya kemampuan approve sendiri).

### 2.6 Identifikasi owner

**File:** `src/server/config.ts:631`

```ts
telegramOwnerUserId: process.env.OWNER_TELEGRAM_USER_ID?.trim() || null,
```

**File:** `src/server/services/channels.ts:625-635` (telegramAccessGate memakai ini untuk gate balasan "belum terdaftar")

Untuk approve cron, **wajib cek `platformUserId === config.channels.telegramOwnerUserId`** — bukan `TELEGRAM_ALLOWED_USERS`. Why: `TELEGRAM_ALLOWED_USERS` berisi user umum yang diizinkan chat, bukan admin. Approval hanya untuk owner.

### 2.7 `IncomingMessage` shape

**File:** `packages/sdk/src/index.ts:304-332`

```ts
export interface IncomingMessage {
  platformUserId: string   // ← Telegram user ID (compare dg owner)
  platformChatId: string    // ← chat ID (group/DM)
  platformMessageId: string
  content: string           // ← text pesan
  metadata?: Record<string, unknown>  // ← threadId di sini
  chatType, isMentioned, isReplyToBot, ...
}
```

### 2.8 Cron schema (database)

**File:** `src/server/db/schema.ts` (tabel `crons`)

```ts
requiresApproval: integer('is_public', {mode:'boolean'}).notNull().default(false),
isActive: integer('is_active', {mode:'boolean'}).notNull().default(true),
name: text('name').notNull(),
schedule: text('schedule').notNull(),
agentId: text('agent_id'),  // null untuk user-created, ID untuk agent-created
```

### 2.9 Channel message context (untuk kirim balasan)

**File:** `src/server/services/channels.ts` — `handleIncomingChannelMessage` punya akses ke:
- `channel` (record dari DB)
- `incoming` (IncomingMessage)
- `senderName`

Bagian ini bisa langsung panggil `adapter.sendMessage()` seperti di `handleBotStart`.

---

## 3. Pertanyaan: bisakah approve di Telegram?

### Jawaban: **BISA**, dengan code baru. Belum ada handler saat ini.

Implementable karena:

1. ✅ `approveCron(cronId)` sudah siap (cukup panggil) — no rework backend service
2. ✅ Pola handle pra-Agent sudah ada (`/start`) → tinggal klon untuk `/setujui`
3. ✅ Owner identification siap via `OWNER_TELEGRAM_USER_ID`
4. ✅ `threadId` propagation ke sendMessage sudah fix (fix terkait topik forum kemarin)
5. ✅ Tidak perlu auth cookie / sesi web (skip middleware REST)

### Safety boundary yang tetap dipertahankan

1. Hanya owner (`OWNER_TELEGRAM_USER_ID`) yang bisa approve — bukan anggota `TELEGRAM_ALLOWED_USER` biasa
2. Handler `/setujui` harus **pra-Agent** (seperti `/start`) → tidak masuk antrian LLM → Agent tidak bisa approve sendiri
3. Cron disetujui langsung `isActive=true` + `scheduleJob()` via fungsi `approveCron` yang ada (project lintang)
4. Bisa juga pulihkan cron jika user kirim ulang `/setujui` (idempotency di approveCron menangani: update sama jika sudah approve sebelumnya)

---

## 4. Pilihan implementasi (Opsi A, B, C)

### Opsi A — Perintah slash `/setujui` (paling sederhana, **rekomendasi v1**)

```
User: /setujui            → Bot balas daftar cron pending (nama + ID pendek + schedule)
User: /setujui <nama>     → Bot approve cron pertama yang namanya match (case-insensitive contains)
User: /setujui <id>       → Bot approve cron by ID (exact match)
User: /tolak <nama>       → Bot hapus cron pending (opsional)
```

Layout Telegram:
```
⏳ Cron menunggu persetujuan:

1. Kirim 5 Soal OSN SMP — Senin 19:30
   ID: cron-a1b2c3
2. Notifikasi Harian — 0 8 * * *
   ID: cron-x7y8z9

Ketik /setujui <ID atau nama>
```

Setelah approve:
```
✅ Cron "Kirim 5 Soal OSN SMP" disetujui dan aktif.
Jadwal: Senin 19:30 WIB
Akan jalan otomatis.
```

**Pro:**
- Pattern identik dengan `/start` (sudah dikenal, ~150 baris)
- Userelah tetap mobile friendly (cukup ketik "setujui osn")
- Tidak butuh perubahan adapter Telegram
- Transferable ke WhatsApp (`/setujui` via chat, bot cek user ID = owner WA)

**Kontra:**
- User harus hafal nama cron atau baca daftar dulu
- Tidak ada one-click button di Telegram

**Estimasi:** ~0.5 hari

### Opsi B — Inline keyboard button (UX terbaik)

Ketika Agent buat cron dan butuh approval, bot otomatis kirim ke chat owner:

```
📬 Cron baru menunggu persetujuan

Nama: Kirim 5 Soal OSN SMP
Jadwal: Senin 19:30 WIB
Agent: Yefia
Deskripsi: Kirim 5 soal OSN Matematika SMP ke P Gun setiap Senin.

[✅ Setujui]  [❌ Tolak]
```

User klik button → Telegram kirim `callback_query` ke bot → adapter handle → panggil `approveCron` atau `deleteCron`.

**Pro:**
- UX jauh lebih enak (one-tap)
- Otomatis muncul tanpa user harus ingat command
- Setara dengan banner kanan SSE di web UI

**Kontra:**
- Butuh handler `callback_query` baru di adapter Telegram (polling + webhook)
- Butuh endpoint Telegram `answerCallbackQuery` baru
- Inline keyboard persistent di chat (kalau cron approve berkali-kali, butuh edit-keyboard lama jadi "✅ Disetujui")
- Telegram adapter harus tahu cronOwnerTelegramChatId (ke mana kirim notif — grup admin? DM owner?) — butuh lookup tambahan
- Untuk WhatsApp (tidak ada inline button) tetap butuh fallback ke Opsi A

**Estimasi:** ~1 hari (termasuk callback handler + UI pengiriman notifikasi)

### Opsi C — A + B gabungan (ideal jangka panjang)

- Opsi A dulu jalan untuk WhatsApp & fallback Telegram → produksi hari ini
- Opsi B sesudah untuk upgrade UX Telegram khusus
- Cron notification router bisa dipakai bareng (kirim notif inline button Telegram + notif teks biasa ke WA)

**Estimasi:** ~1.25 hari

### Matriks perbandingan

| Aspek | Opsi A (`/setujui`) | Opsi B (inline button) | Opsi C (gabungan) |
|---|---|---|---|
| Effort | 0.5 hari | 1 hari | 1.25 hari |
| UX: Telegram | Ketik command | One-tap | One-tap + fallback |
| UX: WhatsApp | Ketik command | Tidak support (fallback A) | One-tap + ketik fallback |
| File baru | 0 (edit 2 file) | 1 (notification router) | 1 + dispatch |
| Risk terhadap Agent flow | Tidak ada | Tidak ada | Tidak ada |
| Test surface | `channels.test.ts` | `crons.test.ts` + `channels.test.ts` + adapter | Gabungan |

---

## 5. Rekomendasi & keputusan

### Rekomendasi eksekusi besok: **Opsi A dulu, Opsi B sesudah**

Alasan:

1. **Opsi A langsung menjawab kebutuhan user** ("besok bisa approve dari HP") dengan effort kecil
2. **Pattern `/start` sudah ada** → copy-paste + adaptasi, rendah risiko
3. **Tidak mengganggu arsitektur Agent** → safety boundary tetap dipertahankan
4. **Transferable ke WhatsApp** → pattern sama一经
5. **Opsi B bisa diadopsi belakangan** sebagai polish UX (lihat section 7)

### Out-of-scope eksekusi besok:

- Inline keyboard button (Opsi B) → defer ke phase berikutnya
- Approval via WhatsApp (`/setujui` WA) → Opsi A pattern siap untuk WA, baru klon handler channel.ts kalau diminta

### Acceptance Criteria

- [ ] User kirim `/setujui` di topik Telegram mana pun → bot balas di topik itu (lewat `threadId`)
- [ ] User kirim `/setujui` tanpa argumen → bot balas daftar cron pending (empty state tidak ada pending = balas "Tidak ada cron menunggu persetujuan.")
- [ ] User kirim `/setujui <nama atau ID>` → bot approve cron + balas konfirmasi
- [ ] User non-owner kirim `/setujui` → bot silent drop (atau balas "Maaf, hanya owner yang bisa approve") — pilih: silent drop lebih aman (tidak bocor info cron ada/tidak)
- [ ] User kirim `/setujui nonexistent` → bot balas "Cron tidak ditemukan"
- [ ] Cron yang sudah di-setujui tetap berjalan (verifikasi `scheduleJob` kepanggil)
- [ ] Pasca-approve, `/setujui` (tanpa argumen) tidak lagi mendaftarkan cron itu
- [ ] Cron approval tidak masuk antrian Agent (verifikasi: tidak ada message user dengan prefix `[telegram:...] /setujui` di log Agent)

---

## 6. Rencana eksekusi step-by-step (Opsi A)

### Langkah 1: Tambah handler pra-Agent di `handleIncomingChannelMessage`

**File:** `src/server/services/channels.ts`

Tambah setelah blok `/start` (sekitar L828-831):

```ts
// Handle bot commands (/start, /start@botname, /start deeplink)
if (/^\/start(?:\s|@|$)/.test(incoming.content)) {
  await handleBotStart(channel, incoming, senderName)
  return
}

// Handle cron approval command (/setujui, /approve)
// Only owner can approve — see handleCronApproval below.
if (/^\/setujui(?:\s|$)|^\/approve(?:\s|$)/.test(incoming.content)) {
  await handleCronApproval(channel, incoming, senderName)
  return
}
```

**Catatan penting:** regex allow `/setujui` (Indonesia) dan `/approve` (EN fallback). Tidak allow `/setujui@botname` pattern — Telegram user kadang kirim `/setujui@yefiabot`. Regex harus handle ini. Update regex:

```ts
// /setujui atau /approve, mungkin suffix @botname
if (/^\/(?:setujui|approve)(?:\s|@|$)/.test(incoming.content)) {
  await handleCronApproval(channel, incoming, senderName)
  return
}
```

### Langkah 2: Implementasi `handleCronApproval` function

**File:** `src/server/services/channels.ts`

Tambah function baru setelah `handleBotStart` (sekitar L1120):

```ts
// ─── Cron approval command (/setujui, /approve) ─────────────────────────────

/**
 * Handle `/setujui` or `/approve` slash command from chat (Telegram or WA).
 * Only the channel owner (OWNER_TELEGRAM_USER_ID for Telegram, OWNER_WHATSAPP_USER_ID for WA) can approve.
 * This is a pre-Agent handler — does NOT enqueue to the LLM queue.
 *
 * Forms:
 *   /setujui            → list pending crons (name + ID + schedule)
 *   /setujui <id>       → approve by exact cron ID
 *   /setujui <name>     → approve by first case-insensitive name match (contains)
 *   /setujui <partial>  → approve by first name contains match
 */
async function handleCronApproval(
  channel: typeof channels.$inferSelect,
  incoming: IncomingMessage,
  _senderName: string,
) {
  // 1. Authorization check — only owner can approve
  const isOwner = isChannelOwner(channel.platform, incoming.platformUserId)
  if (!isOwner) {
    // Silent drop for non-owner — don't leak cron existence
    log.debug({ channelId: channel.id, platformUserId: incoming.platformUserId }, 'Cron approval from non-owner dropped')
    return
  }

  // 2. Parse args
  const parts = incoming.content.trim().split(/\s+/)
  const arg = parts.length > 1 ? parts.slice(1).join(' ') : ''

  // 3. Resolve adapter + cfg for reply
  const adapter = channelAdapters.get(channel.platform)
  if (!adapter) return
  const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>

  // Helper to reply in the correct topic (uses threadId we just fixed)
  const reply = (text: string) => adapter.sendMessage(channel.id, cfg, {
    chatId: incoming.platformChatId,
    content: text,
    threadId: incoming.metadata?.threadId as string | undefined,
    replyToMessageId: incoming.platformMessageId,
  }).catch((err) => log.error({ channelId: channel.id, err }, 'Failed to send cron approval reply'))

  // 4. Import approveCron + listPendingCrons
  const { approveCron, listPendingCrons } = await import('@/server/services/crons')

  // 5. No arg → list pending
  if (!arg) {
    const pending = await listPendingCrons(channel.agentId)
    if (pending.length === 0) {
      await reply('✅ Tidak ada cron menunggu persetujuan.')
      return
    }
    const lines = pending.map((c, i) =>
      `${i + 1}. ${c.name} — ${c.schedule}\n   ID: ${c.id}`
    )
    await reply(`⏳ Cron menunggu persetujuan:\n\n${lines.join('\n\n')}\n\nKetik /setujui <ID atau nama> untuk menyetujui.`)
    return
  }

  // 6. Match by ID (exact) or name (contains, case-insensitive)
  const pending = await listPendingCrons(channel.agentId)
  const byId = pending.find((c) => c.id === arg)
  const byName = pending.find((c) => c.name.toLowerCase().includes(arg.toLowerCase()))

  if (!byId && !byName) {
    await reply(`❓ Cron tidak ditemukan: "${arg}"\n\nKetik /setujui (tanpa argumen) untuk melihat daftar cron pending.`)
    return
  }

  // 7. Approve
  const target = byId ?? byName!
  try {
    const approved = await approveCron(target.id)

    // If cron has channel context (senderId we want to notify later), we could
    // also annotate the cron payload or the Agent prompt — defer to phase 2.

    await reply(`✅ Cron "${approved?.name}" disetujui dan aktif.\nJadwal: ${approved?.schedule}\nAkan jalan otomatis sesuai jadwal.`)
  } catch (err) {
    log.error({ channelId: channel.id, err, cronId: target.id }, 'Failed to approve cron via chat command')
    await reply(`❌ Gagal menyetujui cron "${target.name}". Coba lagi atau buka web Gezy.`)
  }
}

/**
 * Check if the message sender is the channel's owner (admin).
 * Telegram: matches OWNER_TELEGRAM_USER_ID.
 * WhatsApp: matches OWNER_WHATSAPP_USER_ID (after LID resolution).
 */
function isChannelOwner(platform: string, platformUserId: string): boolean {
  if (platform === 'telegram') {
    return config.channels.telegramOwnerUserId != null
      && String(platformUserId) === config.channels.telegramOwnerUserId
  }
  if (platform === 'whatsapp-web') {
    // Strip JID suffix and compare digits
    const digits = platformUserId.replace(/[^0-9]/g, '')
    const ownerDigits = config.channels.whatsappOwnerUserId?.replace(/[^0-9]/g, '')
    return ownerDigits != null && digits === ownerDigits
  }
  return false
}
```

### Langkah 3: Tambah `listPendingCrons` di crons service

**File:** `src/server/services/crons.ts`

Tambah function setelah `approveCron` (sekitar L240):

```ts
/**
 * List crons pending approval for a given agent (or all agents if agentId is null).
 * Used by the `/setujui` chat command handler.
 */
export async function listPendingCrons(agentId?: string): Promise<Array<{
  id: string
  name: string
  schedule: string
  agentId: string | null
}>> {
  const query = db
    .select({
      id: crons.id,
      name: crons.name,
      schedule: crons.schedule,
      agentId: crons.agentId,
    })
    .from(crons)
    .where(
      agentId
        ? and(eq(crons.requiresApproval, true), eq(crons.agentId, agentId))
        : eq(crons.requiresApproval, true)
    )
    .all()
  return query
}
```

**Catatan:** kita filter `requiresApproval = true` di DB level → efisien, tidak load semua cron. Filter per-agent opsional (`agentId`). Kalau owner punya banyak agent, mungkin perlu argumen `scope: 'this' | 'all'` untuk approve cron dari agent lain — tapi v1 cukup scope same-agent (cron yang dibuat oleh agent channel yang sedang dipakai user).

Pertimbangan: kalau user kirim `/setujui` ke agent A, tetapi cron pending diciptakan oleh agent B, cron B tidak muncul di daftar. tandanya v1 konfirmasi: "Tidak ada cron menunggu persetujuan." → user tahu harus approval via agent yang menciptakan.

Alternatif v1.1: kirim daftar semua cron pending lintas agent kalau owner. Decission: defer — v1 scope same-agent.

### Langkah 4: Tunjukkan ke Agent bahwa approval bisa lewat chat

**File:** `src/server/services/prompt-builder.ts` — di blok cron tools description

Saat ini prompt bilang "Agent-created crons require user approval via the web UI." Update untuk kasih tahu Agent bahwa bisa minta owner kirim `/setujui`:

```ts
// Contoh tambahan di prompt:
`- Agent-created crons require owner approval before they run. The owner can approve via the web UI, OR via chat by sending \`/setujui <cron name or ID>\` (Telegram/WhatsApp). Tell the user: "Cron will aktif after you type /setujui" — the owner will get a notification and instructions.`
```

Menantikan hari eksekusi: cek dulu bagian prompt-builder.ts yang mention cron approval, update dengan baris di atas.

### Langkah 5: Test unit di `channels.test.ts`

**File:** `src/server/channels/index.test.ts` atau test service channels

Tambah test block untuk `handleCronApproval` behavior. Mock adapter + mock `approveCron`:

```ts
describe('cron approval command', () => {
  it('renders pending list when /setujui called without args', async () => {
    // Setup: channel active, sender is owner, no crons pending
    // Expect: adapter.sendMessage called with pending list text
  })

  it('approves cron by ID when /setujui <id>', async () => {
    // Setup: cron pending exists
    // Expect: approveCron(id) called, reply "disetujui dan aktif"
  })

  it('approves cron by name (contains) when /setujui <partial name>', async () => {
    // Setup: cron "Kirim 5 Soal OSN SMP" pending
    // Call: /setujui osn
    // Expect: approveCron(that-cron-id) called
  })

  it('silently drops non-owner /setujui', async () => {
    // Setup: sender is NOT owner
    // Expect: adapter.sendMessage NOT called (silent drop)
  })

  it('shows empty state when no pending crons', async () => {
    // Setup: sender is owner, no pending
    // Expect: reply "Tidak ada cron menunggu persetujuan"
  })

  it('replies with threadId (forum topic)', async () => {
    // Setup: message has metadata.threadId
    // Expect: adapter.sendMessage called with threadId in params
  })

  it('replies cron not found for unknown name', async () => {
    // Setup: no cron matching "nonexistent"
    // Expect: reply "Cron tidak ditemukan"
  })

  it('does not enqueue to Agent queue (pre-Agent handling)', async () => {
    // Setup: spy on enqueueMessage
    // Call: /setujui
    // Expect: enqueueMessage NOT called
  })
})
```

### Langkah 6: Verify typecheck + run tests

```bash
NODE_OPTIONS="--max-old-space-size=4096" bunx tsc --noEmit --pretty false
# EXIT 0

bun test src/server/services/channels.test.ts
# All pass

bun test   # full suite, no regression
# same pass count as before (pre-existing 48 fails di DB/migration/tiket tetap, gak terkait)
```

### Langkah 7: Commit + push

**Commit message:**

```
feat: approve agent-created crons via /setujui chat command (Telegram + WhatsApp)

Cron yang dibuat Agent butuh approval sebelum jalan. Sebelumnya hanya
bisa via web UI (POST /api/crons/:id/approve). Sekarang owner bisa
ketik /setujui (atau /approve) di chat Telegram/WhatsApp:

  /setujui            → daftar cron pending
  /setujui <id>       → approve by ID
  /setujui <name>     → approve by name match

Pre-Agent handler (mirip /start): tidak enqueue ke LLM, Agent tidak
bisa approve sendiri. Hanya owner (OWNER_TELEGRAM_USER_ID /
OWNER_WHATSAPP_USER_ID) yang bisa approve; non-owner silent-drop.

Balasan kirim ke topic yang benar (threadId propagation). Function
approveCron() yang ada dipakai langsung — no rework backend.

Tambah listPendingCrons(agentId) di crons.ts. Update prompt bilang
"cron bisa approve via /setujui di chat". Test di channels.test.ts.
```

### Langkah 8: Deploy & test E2E di VPS

```bash
docker compose pull
docker compose up -d --force-recreate gezy
docker image prune -f
```

**Test E2E di Telegram:**

1. Minta Yefia buat cron baru (misal "kirim sapaan tiap jam 8 pagi")
2. Bot balas "cron pending, ketik /setujui untuk approve"
3. User kirim `/setujui` di topik yang sama
4. Bot balas daftar cron pending
5. User kirim `/setujui sapaan` (atau ID)
6. Bot balas "✅ disetujui dan aktif"
7. Check sidebar web Gezy → cron tidak lagi pending (badge kuning hilang)
8. Tunggu schedule jalan (atau trigger manual via web) → cron run

---

## 7. Rencana eksekusi tambahan (Opsi B — inline button)

Defer sampai Opsi A jalan stabil. Berikut rancangan untuk implementasi sesudahnya:

### Langkah B1: Cron notification router di `crons.ts`

Saat `createCron` dengan `isAgentCreated = true`, kirim inline-button notification ke channel owner selain SSE + persistent notif yang sudah ada:

```ts
// Setelah createNotification(...) di createCron
if (isAgentCreated) {
  // Existing: SSE + persistent notif → web UI
  sseManager.broadcast(...)
  createNotification({...})

  // NEW: kirim ke chat channels (Telegram inline button / WA text)
  void sendCronApprovalToChannels(params.agentId, {
    cronId: id,
    name: params.name,
    schedule: params.schedule,
  }).catch((err) => log.warn({cronId: id, err}, 'Failed to send cron approval to channels'))
}
```

### Langkah B2: Function `sendCronApprovalToChannels`

```ts
import { getActiveChannelsForAgent } from '@/server/services/channels'

async function sendCronApprovalToChannels(agentId: string, cron: {cronId, name, schedule}) {
  const channels = await getActiveChannelsForAgent(agentId)
  for (const channel of channels) {
    if (channel.platform === 'telegram') {
      // Telegram: kirim inline keyboard
      await sendTelegramApprovalInline(channel, cron)
    } else if (channel.platform === 'whatsapp-web') {
      // WA: kirim teks biasa (tidak ada inline button)
      await sendWhatsAppApprovalText(channel, cron)
    }
  }
}
```

### Langkah B3: Telegram adapter — kirim inline keyboard

Di adapter, tambah method atau helper khusus at InlineKeyboardMarkup:

```ts
// bot/cron-approve:<cronId>
await telegramApi(token, 'sendMessage', {
  chat_id, message_thread_id,
  text: `📬 Cron baru menunggu persetujuan\n\nNama: ${name}\nJadwal: ${schedule}`,
  reply_markup: {
    inline_keyboard: [[
      { text: '✅ Setujui', callback_data: `cron_approve:${cronId}` },
      { text: '❌ Tolak', callback_data: `cron_reject:${cronId}` },
    ]]
  }
})
```

### Langkah B4: Handle `callback_query` di telegram.ts

Di polling/update processor, tambah cabang:

```ts
// processUpdate menjadi processTelegramUpdate(update)
if ('callback_query' in update && update.callback_query) {
  await this.processCallbackQuery(state, update.callback_query)
  return
}
// Sisanya tetap memproses 'message'
```

Tambah function:

```ts
private async processCallbackQuery(state, callbackQuery) {
  const from = callbackQuery.from
  const data = callbackQuery.data
  if (!data?.startsWith('cron_approve:') && !data?.startsWith('cron_reject:')) return
  
  // answerCallbackQuery (harus segera, Telegram expect <5s)
  await telegramApi(token, 'answerCallbackQuery', { callback_query_id: callbackQuery.id })
  
  const [action, cronId] = data.split(':')
  if (action === 'cron_approve') {
    // Verify from.id === OWNER_TELEGRAM_USER_ID (atau bot owner)
    // Call approveCron(cronId)
    // Edit message keyboard jadi "✅ Disetujui"
    await telegramApi(token, 'editMessageReplyMarkup', {
      chat_id: callbackQuery.message.chat.id,
      message_id: callbackQuery.message.message_id,
      reply_markup: { inline_keyboard: [[{ text: '✅ Disetujui', callback_data: 'noop' }]] },
    })
  }
}
```

Webhook path juga perlu handle `callback_query` di `routes/channel-telegram.ts` (`update.callback_query`).

### Langkah B5: Test callback_query path

- Test di `telegram.test.ts`: `processCallbackQuery` called saat update berisi `callback_query`
- Test `approveCron` called dengan cron ID yang benar
- Test non-owner klik button → silent drop
- Test double-click (idempotensi: approve dari keyboard = approve kedua = no-op)

### Langkah B6: Edit keyboard setelah approved

Untuk UX, setelah approve success, edit message notifikasi keyboard jadi "✅ Disetujui (tombol dinonaktifkan)". Kalau tidak, tombol lama masih clickable → idempotency approveCron harus aman (sebenarnya approveCron itu idempotency OK — update sama lagi tidak crash), tapi UX harus minta tombol hilang.

### Langkah B7: Estimasi realistis

- Handle callback_query polling: 0.25 hari
- Handle callback_query webhook: 0.25 hari
- Cron notification router + inline kirim: 0.25 hari
- Edit keyboard setelah approved: 0.1 hari
- Test callback path: 0.15 hari
- **Total:** ~1 hari

---

## 8. Test & verifikasi

### Test lokal (Opsi A)

```bash
# Typecheck
NODE_OPTIONS="--max-old-space-size=4096" bunx tsc --noEmit --pretty false
# EXIT: 0

# Unit test channels service
bun test src/server/services/channels.test.ts
# All pass (existing + new cron approval tests)

# Full suite (harus sama kan fail count yang sudah ada — pre-existing DB/migration failures)
bun test
# 4109+ pass, 91 skip, same 48 pre-existing fails, 0 new fails

# Test manual via dev (bun run dev + cURL atau telegram test bot)
```

### Test E2E VPS (Opsi A)

Skenario complete happy path:

1. Minta Agent buat cron baru via chat Telegram (misal "buat cron kirim sapaan tiap Senin jam 8 pagi")
2. Agent balas "cron pending approval, ketik /setujui di chat untuk approve"
3. User kirim `/setujui` di **topic yang sama**
4. Bot balas daftar cron pending:
   ```
   ⏳ Cron menunggu persetujuan:
   
   1. Sapaan Senin Pagi — 0 8 * * 1
      ID: cron-abc123
   
   Ketik /setujui <ID atau nama>
   ```
5. User kirim `/setujui Sapaan` di topic yang sama
6. Bot balas "✅ Cron "Sapaan Senin Pagi" disetujui dan aktif."
7. Buka web Gezy → sidebar Crons → badge pending hilang, cron status "Active"
8. Trigger manual dari web atau tunggu Senin jam 8 → cron jalan

Skenario error/edge:

- User non-owner kirim `/setujui` → bot silent drop (no reply, no log error)
- User kirim `/setujui nonexistent-cron` → bot balas "Cron tidak ditemukan"
- User kirim `/setujui` saat tidak ada cron pending → bot balas "Tidak ada cron menunggu persetujuan"
- User kirim `/setujui` di topic A → bot balas di topic A (bukan main thread)
- Cron sudah approved, user kirim `/setujui` lagi → cron tidak lagi muncul di daftar pending

### Test E2E VPS (Opsi B, ketika sudah diimplementasi)

- Buat cron via Agent → notifikasi inline button otomatis muncul di chat owner
- Klik "Setujui" → button berubah "✅ Disetujui", cron active
- Klik "Tolak" → cron dihapus, button berubah "❌ Ditolak"
- Non-owner klik button → silent drop (callback_query answered tapi gak ada action)

---

## 9. Pitfalls & safety

### Pitfalls teknis

1. **Regex `/setujui@botname`**: Telegram kadang kirim `/setujui@yefiabot` (suffix @username). Pattern regex harus handle: `/^\/(?:setujui|approve)(?:\s|@|$)/`. Jangan lupa kalau argumen body bisa contain `@` (misal `/setujui @Senin` — aneh tapi mungkin). Test regex baik-baik.

2. **Case sensitivity match nama cron**: match `c.name.toLowerCase().includes(arg.toLowerCase())` — case-insensitive. Kalau nama cron punya karakter khusus (emoji, dll), match tetap OK (regex contains).

3. **Ambiguity match**: kalau ada 2 cron pending dengan nama overlap (misal "Sapaan Senin" dan "Sapaan Rabu"), `/setujui Sapaan` akan match cron pertama saja. V1 aman (first match). Kalau perlu disambiguate, minta user /setujui <ID> (which is unique). V1 ambil byId first, byName first;ID exactly if arg is a cronId.

4. **`listPendingCrons` query scope**: v1 filter by `agentId` (cron same agent dengan channel). Kalau cron pending dibuat agent lain (channel beda), tidak muncul. Pertimbangan: kalau yefia buat cron dan user chat di channel pakGun untuk /setujui → cron tidak muncul. Fix: extend `listPendingCrons` untuk owner → list semua pending (tanpa filter agentId). Tapi ini perlu concept "owner" di crons.ts (user tidak ada di chat side, tetapi via isChannelOwner sudah filter). Actually bisa: kalau owner chat ke agentA dan minta `/setujui`, list semua pending dari semua agents. Tapi ini change design.

   **Decision v1:** Scope same-agent (yang channel handle = agentId). **Decision v1.1 (jika perlu):** Scope semua agents. Di test cosentino: kalau user pakai multi-agent, mungkin lebih intuitive approve via `/setujui` di channel mana pun.

5. **Tidak ada double-approve masalah**: `approveCron` idempotent (`update SET requiresApproval = false, isActive = true`). Kalau approve cron sudah approved, update sama lagi + `scheduleJob(approved)` kepanggil lagi → croner daftarkan job baru (potensi double schedule!).

   **Cek perlu:** apakah `scheduleJob` idempotent untuk cron yang sama? Lihat `src/server/services/crons.ts:374` (croner avoid double?). Kalau tidak, tambah guard:
   ```ts
   if (!approved.requiresApproval) {
     log.info({ cronId }, 'Cron already approved, skip scheduleJob')
     return approved
   }
   ```
   Atau di handler `/setujui`: skip approve kalau sudah tidak pending.

6. **Adapter race condition**: kalau user kirim `/setujui <id>` cepat-cepat 2x sebelum reply pertama selesai, bisa panggil `approveCron` 2x. Aman karena idempotent (lihat pitfall 5).

7. **Output format di Telegram**: kalau pending list panjang (10+ crons), Telegram 4096 char limit → bisa overflow. V1: log info "pending too long, trunctated to first 10". Atau paginate. Decision v1: cukup top-10 + hint "lihat semua di web".

8. **WhatsApp formatting**: WA kirim sebagai text biasa, format markdown `**bold**` akan jadi teks literal `**bold**` (bot WA raw text, bukan markdown). Pastikan reply text tanpa markdown formatting (atau formatting WA native `*bold*`). Decision v1: reply plain text untuk kompatibilitas lintas platform.

### Safety boundaries yang wajib dipertahankan

1. **`isChannelOwner` check WAJIB di awal handler** — tidak boleh lompat ke logic lain sebelum cek owner.
2. **Pre-Agent handling** — handler `/setujui` harus `return` setelah selesai, jangan fall-through ke `enqueueChannelTurn`.
3. **Agent tidak punya tool approve_cron** — Agent tidak boleh tahu bahwa approve bisa via `/setujui`. Prompt harus bilang "cron butuh approval dari user via /setujui di chat", bukan "Anda bisa approve via tool".
4. **Non-owner silent drop** — jangan reply "anda bukan owner" (bocor informasi sistem ke pengguna umum). Drop saja tanpa log warning.
5. **`threadId` propagation wajib** — balasan harus masuk topik yang benar (fix threadId kemarin sudah主干).
6. **Tidak mengganggu cron approval via web** — REST endpoint tetap jalan, Opsi A adalah jalur alternatif, bukan pengganti.

### Catatan teknis terkait run-time

1. **`bun scheduleJob` (croner)**: kalau `scheduleJob(approved)` dipanggil ulang untuk cron yang sama (edge double-approve), croner kemungkinan register job baru tanpa unregister old job. Verify di crons.ts atau tambah guard (lihat pitfall 5).

2. **`adapter.sendMessage` di `handleCronApproval`** harus fire-and-forget `.catch(...)` untuk tidak block handler. Tapi kalau gagal kirim reply, user tidak dapat konfirmasi → cek kalau timeout Telegram API → kasih log level warn.

3. **Identifikasi owner WhatsApp**: `OWNER_WHATSAPP_USER_ID` match berbasis digit. Kalau user WA mengirim dengan LID (bukan nomor telepon), match gagal → silent drop untuk owner WA yang belum ada lid-mapping. Decision v1: WA insurance-cron approve adalah bonus; bisa pakai v1.1 (LID fallback di isChannelOwner match `lidToPn`). Atau text-only: kalau user WA kirim `/setujui` dan tidak match owner digit → silent drop. User bisa kerja via UI seperti biasa.

4. **Konteks user → userId Gezy**: kita tidak punya mapping kontak Telegram → user_profile untuk verify role=admin secara eksplisit. `OWNER_TELEGRAM_USER_ID` dianggap sebagai proxy "admin" karena cuma satu user di single-admin deploy. Kalau nanti multi-admin, bisa extend: `OWNER_TELEGRAM_USER_ID` → list (env comma-separated), match salah satu. Tapi v1 cukup single owner.

---

## 10. Update catatan terkait

Setelah eksekusi, update:

- `Catatanku/fitur-channel-dokumen.md` — section Telegram: tambah `Cron approval via /setujui ✅`
- `Catatanku/ToDo-besok-1juli.md` — mark task cron-approval done (kalau ada)
- `Catatanku/whatsapp-grup.md` — mention `/setujui` WA support (kalau handle WA juga)

Tidak perlu update:
- `docs-site/agents/tools.md` — bukan user-facing doc (cron approval masih via web UI officially, `/setujui` adalah bonus route)
- `api.md` — tidak ada REST endpoint baru

---

## 11. Checklist eksekusi besok

### Pra-eksekusi
- [ ] Baca file ini dari atas ke bawah
- [ ] Konfirmasi `approveCron` di `src/server/services/crons.ts:223` masih polos (tidak diubah sejak catatan ini)
- [ ] Konfirmasi `OWNER_TELEGRAM_USER_ID` ada di env VPS
- [ ] Konfirmasi threadId fix (commit `170ec80e`) sudah jalan di VPS (test topik Telegram sudah benar)
- [ ] Siapkan test bot Telegram untuk testing E2E

### Eksekusi (Opsi A)
- [ ] Langkah 1: Tambah regex handler di `handleIncomingChannelMessage` (`channels.ts`)
- [ ] Langkah 2: Implementasi `handleCronApproval` + `isChannelOwner` (`channels.ts`)
- [ ] Langkah 3: Tambah `listPendingCrons` (`crons.ts`)
- [ ] Langkah 4: Update prompt-builder.ts (inform agent cron bisa /setujui)
- [ ] Langkah 5: Tambah test di `channels.test.ts` (8 test case minimum)
- [ ] Langkah 6: Typecheck + run tests lokal
- [ ] Langkah 7: Commit + push dengan format message dari Langkah 7
- [ ] Langkah 8: Tunggu GitHub Actions hijau → deploy VPS
- [ ] Langkah 8b: Test E2E di Telegram (lihat section 8)

### Post-eksekusi
- [ ] Update `Catatanku/fitur-channel-dokumen.md` (mark `/setujui` done)
- [ ] Cek apakah `scheduleJob` idempotent — kalau tidak, tambah guard (pitfall 5)
- [ ] Coba happy path + edge cases dari test E2E section
- [ ] Catat lesson learned / tweak yang perlu

---

## 12. Catatan teknis terkait codebase

### File-file yang akan diubah (Opsi A)

| File | Perubahan | Estimasi baris |
|---|---|---|
| `src/server/services/channels.ts` | Tambah regex handler di handleIncomingChannelMessage + function baru `handleCronApproval` + `isChannelOwner` | +120 |
| `src/server/services/crons.ts` | Export `listPendingCrons` baru | +20 |
| `src/server/services/prompt-builder.ts` | Update bullet cron approval (mention `/setujui`) | +1 |
| `src/server/services/channels.test.ts` (atau index.test.ts) | Tambah 8 test case cron approval | +100 |
| **Total** | 4 file | ~240 baris |

### File untuk Opsi B (defer)

| File | Perubahan | Estimasi baris |
|---|---|---|
| `src/server/services/crons.ts` | Tambah `sendCronApprovalToChannels` helper + panggilan di `createCron` | +60 |
| `src/server/channels/telegram.ts` | Tambah `processCallbackQuery` handler + inline keyboard sender | +80 |
| `src/server/routes/channel-telegram.ts` | Handle `callback_query` di webhook path | +20 |
| `src/server/services/channels.test.ts` | Tambah test callback path | +50 |
| `src/server/services/crons.test.ts` | Tambah test notification router | +30 |
| **Total** | 5 file | ~240 baris |

### Env VPS (tidak ada perubahan baru, hanya konfirmasi yang ada)

```env
# Sudah ada — konfirmasi waktu eksekusi:
OWNER_TELEGRAM_USER_ID=6468143001     # user ID P Gun di Telegram
PUBLIC_URL=https://aios.gezytech.web.id
```

### Dependencies baru

Tidak ada. Hanya pakai:
- `approveCron` (already in `crons.ts`)
- `db.select` + `drizzle-orm` (already in `crons.ts`)
- `adapter.sendMessage` (already in `channels.ts`)
- `config.channels` (already used in `channels.ts`)
- `bun:test` (for tests)

### Testing strategy

- **Unit tests** untuk `handleCronApproval`: mock `channelAdapters.get`, mock `approveCron`, mock `db.select` for pending crons
- **Integration smoke**: via `bun run dev` + cURL Telegram Bot API mock atau bot real test
- **E2E**: deploy ke VPS, test di bot Telegram real

---

## 13. FAQ untuk masa depan

### Bagaimana kalau user mau revoke cron (yang sudah approve)?

v1 belum handle. Bisa tambah `/tolak <nama>` atau `/revoke <nama>` di phase berikutnya. Aman untuk skip di v1 (bot selalu bisa deleteCron via UI).

### Bagaimana kalau cron punya payload kompleks (task description dsb)?

v1 cukup approve flag + schedule. Cron payload (task description, attachment, dsb) tetap di DB, dijalankan saat `scheduleJob` trigger. Tidak perlu touch payload di approval phase.

### Bagaimana kalau user punya banyak cron pending?

v1 tampilkan top 10 + hint "lihat semua di web". V1.1 bisa paginate (`/setujui 2` untuk page 2).

### Bagaimana kalau cron pending dibuat untuk agent lain?

v1 scope same-agent (filter by channel.agentId). V1.1: kalau owner kirim `/setujui`, list semua pending lintas agent (abaikan agentId filter). Decision defer.

### Bagaimana kalau non-owner kirim `/setujui`?

Silent drop. Tidak reply, tidak log warning (tapi debug log untuk developer — level debug, bukan info).

### Bagaimana kalau Telegram sedang down?

`adapter.sendMessage` akan throw → `.catch(...)` log error. User tidak dapat reply. Tetap aman (tidak crash server). User retry.

---

## 14. Referensi cepat

- Pattern `/start`: `src/server/services/channels.ts:828-830` (regex) dan `:1074-1120` (handler)
- `approveCron()`: `src/server/services/crons.ts:223`
- Create cron: `src/server/services/crons.ts:85-93`
- `telegramOwnerUserId` config: `src/server/config.ts:631`
- `whatsappOwnerUserId` config: `src/server/config.ts:653`
- `IncomingMessage` shape: `packages/sdk/src/index.ts:304-332`
- Cron schema: `src/server/db/schema.ts` (table `crons`)
- `scheduleJob` (croner): `src/server/services/crons.ts` — verify idempotency sebelum eksekusi

---

## 15. Out-of-scope (jangan kerjakan besok)

- Approval cron via WhatsApp (tertunda sampai ada permintaan eksplisit)
- Cron notification router (Opsi B) — defer
- `/tolak` atau `/revoke` command — defer phase berikutnya
- Paginate daftar cron pending — defer phase berikutnya
- Multi-admin support (env list comma-separated untuk owner) — defer
- Schedule trigger time (membantu cron schedule cron untuk kirim ke jawaban di topik tertentu) — out of scope

---

*Dokumen ini adalah catatan eksekusi untuk besok, 2 Juli 2026. Baca dari atas ke bawah sebelum mulai coding. Checklist di section 11 untuk memandu step-by-step.*